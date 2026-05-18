/**
 * Orchestrate phase runner.
 *
 * After the user trims the audit checklist and POSTs `/chats/:id/resume`,
 * the runner re-fires onto this phase. We walk the user-approved
 * `AuditItem[]` (loaded from `<chatDir>/audit-output.json` filtered by
 * `<chatDir>/audit-selected-ids.json`), and for each item:
 *
 *   1. Pick a worker via the pure scheduler (`pickWorkerForItem`).
 *   2. Cut a fresh git branch off the chat's repoPath.
 *   3. Spawn the worker headlessly with a doer-style prompt built from
 *      the item's summary + rationale + files.
 *   4. Capture a `git diff <base>...<branch> --stat` summary.
 *   5. Append a manifest entry.
 *
 * Sequential — workers run one at a time. Parallelism is an explicit
 * non-goal for v1; the scheduler stays pure so a future stateful balancer
 * can wrap it without rewriting branch / diff bookkeeping.
 *
 * The phase persists `<chatDir>/orchestrate-manifest.json` (read by the
 * step-6 diff-apply UI). It does NOT merge worker branches; that's the
 * UI's job after a human reviews each diff.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import { voices as voicesDb } from "../../lib/db/voices.js";
import { logger } from "../../lib/logger.js";
import {
  AuditItemSchema,
  DEFAULT_PHASE_TIMEOUT_MS,
  type AuditItem,
  type OrchestratePhase,
} from "../../lib/template-schema.js";
import { pickShimForVoice } from "../agents/index.js";
import type { Lineage } from "../agents/types.js";
import {
  pickWorkerForItem,
  type SchedulerVoiceMeta,
  type SchedulerWorker,
} from "./orchestrate-scheduler.js";
import type { RunnerEvent } from "../runner/types.js";

export interface OrchestrateManifestEntry {
  idx: number;
  itemId: string;
  voiceId: string;
  branch: string;
  diffStat: string;
  status: "completed" | "failed";
  error?: string;
}

export interface OrchestrateManifest {
  workers: OrchestrateManifestEntry[];
  completedAt: number;
}

export interface RunOrchestratePhaseArgs {
  chatDir: string;
  chatId: string;
  phase: OrchestratePhase;
  phaseIdx: number;
  /** Absolute path to the user's repo. Required — orchestrate cuts branches. */
  repoPath: string;
  /** Whether tier gating should be bypassed (PR-review chats). */
  bypassQuota: boolean;
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
}

export interface RunOrchestratePhaseResult {
  /** False iff aborted before any worker could finish. */
  completed: boolean;
  manifest: OrchestrateManifest;
}

/** Compose the doer-style prompt sent to a worker. Mirrors what runDoer
 *  does in spirit but avoids the reviewer-loop scaffolding. The worker
 *  edits files in `repoPath` directly (the spawn cwd), so the prompt
 *  surfaces the item context and asks for concrete edits. */
function buildWorkerPrompt(item: AuditItem, repoPath: string): string {
  const filesBlock =
    item.files.length > 0
      ? `Files in scope (paths relative to the repo root at \`${repoPath}\`):\n${item.files.map((f) => `  - ${f}`).join("\n")}\n\n`
      : "";
  return (
    `You are a worker handling one item from an audit checklist. Apply the fix described below by editing files in the working directory.\n\n` +
    `### Task\n${item.summary}\n\n` +
    `### Rationale\n${item.rationale || "(none provided)"}\n\n` +
    filesBlock +
    `Make focused, surgical edits. Do not refactor adjacent code. When done, write a short summary of what you changed.\n`
  );
}

/** Run a git command synchronously. Returns ok + stdout/stderr/code. */
function git(
  repoPath: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  try {
    const result = spawnSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 60_000,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: null,
    };
  }
}

/** Substitute {chatId} and {idx} placeholders in branchPrefix. */
function formatBranchName(
  branchPrefix: string,
  chatId: string,
  idx: number,
): string {
  return branchPrefix
    .replaceAll("{chatId}", chatId)
    .replaceAll("{idx}", String(idx));
}

/**
 * Detect the repo's current branch so we can return to it after cutting
 * the worker branch. Falls back to "HEAD" on detached state.
 */
function detectStartingBranch(repoPath: string): string {
  const head = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head.ok ? head.stdout.trim() : "HEAD";
}

/**
 * Cut (or reset) a worker branch off the current HEAD.
 *
 * Reuses the ship-phase pattern: `git checkout -B <branch>` is
 * idempotent and replaces an existing branch's tip with the current
 * HEAD. That's the right semantics for a re-run — we never want to
 * append on top of stale worker work.
 */
function createWorkerBranch(
  repoPath: string,
  branch: string,
): { ok: true } | { ok: false; detail: string } {
  const result = git(repoPath, ["checkout", "-B", branch]);
  if (!result.ok) {
    return {
      ok: false,
      detail: `git checkout -B ${branch} failed: ${result.stderr.trim()}`,
    };
  }
  return { ok: true };
}

/**
 * Capture `git diff <startingBranch>...<branch> --stat`. When
 * startingBranch is "HEAD" (detached / unknown), fall back to a
 * plain `git diff --stat HEAD~1 HEAD` so we still surface something
 * informative; if even that fails we record an empty string.
 */
function captureDiffStat(
  repoPath: string,
  startingBranch: string,
  branch: string,
): string {
  if (startingBranch && startingBranch !== "HEAD") {
    const r = git(repoPath, [
      "diff",
      `${startingBranch}...${branch}`,
      "--stat",
    ]);
    if (r.ok) return r.stdout.trim();
  }
  // Fallback: diff against the parent commit. Empty on a no-op worker.
  const r = git(repoPath, ["diff", "HEAD~1...HEAD", "--stat"]);
  return r.ok ? r.stdout.trim() : "";
}

/**
 * Build a Map<voiceId, {tier, enabled}> from the local voices DB so the
 * scheduler can be called purely. We pull every voice (not just enabled)
 * so the disabled-skip path in the scheduler has the right input.
 */
async function loadVoicesById(): Promise<Map<string, SchedulerVoiceMeta>> {
  const all = await voicesDb.list();
  const map = new Map<string, SchedulerVoiceMeta>();
  for (const v of all) {
    map.set(v.id, { tier: v.tier, enabled: v.enabled });
  }
  return map;
}

/**
 * Resolve the voice id a template worker entry refers to. The template
 * schema only carries `lineage + models[] + persona?`; voice ids are
 * inferred by matching lineage + first model id against the voices
 * table. When no voice row matches, returns the synthetic id
 * `${lineage}:${model ?? "default"}` so the scheduler still has a
 * stable handle (the corresponding voicesById lookup will miss and the
 * scheduler will skip — same outcome as "voice not in DB").
 */
async function resolveWorkerVoiceIds(
  workers: OrchestratePhase["workers"],
): Promise<SchedulerWorker[]> {
  const all = await voicesDb.list();
  const out: SchedulerWorker[] = [];
  for (const w of workers) {
    const model = w.models?.[0];
    const match = all.find(
      (v) => v.lineage === w.lineage && (!model || v.model_id === model),
    );
    out.push({
      voiceId: match?.id ?? `${w.lineage}:${model ?? "default"}`,
      lineage: w.lineage,
      model,
      persona: w.persona,
    });
  }
  return out;
}

export async function runOrchestratePhase(
  args: RunOrchestratePhaseArgs,
): Promise<RunOrchestratePhaseResult> {
  const {
    chatDir,
    chatId,
    phase,
    phaseIdx,
    repoPath,
    bypassQuota,
    onEvent,
    abortSignal,
  } = args;

  const manifest: OrchestrateManifest = {
    workers: [],
    completedAt: 0,
  };

  if (abortSignal.aborted) {
    manifest.completedAt = Date.now();
    return { completed: false, manifest };
  }

  // 1. Load the approved checklist. audit-output.json carries every item
  //    the audit produced; audit-selected-ids.json is the user's filter.
  const auditPath = path.join(chatDir, "audit-output.json");
  const selectedPath = path.join(chatDir, "audit-selected-ids.json");

  let allItems: AuditItem[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(auditPath, "utf-8")) as {
      items?: unknown;
    };
    if (Array.isArray(raw.items)) {
      allItems = raw.items
        .map((it) => AuditItemSchema.safeParse(it))
        .filter((r) => r.success)
        .map((r) => (r as { success: true; data: AuditItem }).data);
    }
  } catch (err) {
    logger.warn(
      { chatId, err: err instanceof Error ? err.message : String(err) },
      "orchestrate: audit-output.json read/parse failed",
    );
  }

  let selectedIds: string[] | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(selectedPath, "utf-8")) as {
      ids?: unknown;
    };
    if (Array.isArray(raw.ids) && raw.ids.every((s) => typeof s === "string")) {
      selectedIds = raw.ids as string[];
    }
  } catch {
    // Missing file is fine on the legacy / direct-fire path; fall back to
    // running every audit item.
    selectedIds = null;
  }

  const items =
    selectedIds === null
      ? allItems
      : allItems.filter((i) => selectedIds!.includes(i.id));

  // 2. Build scheduler inputs once.
  const voicesById = await loadVoicesById();
  const schedulerWorkers = await resolveWorkerVoiceIds(phase.workers);

  // 3. Walk items sequentially. Each iteration: pick worker → branch →
  //    spawn → diff stat → manifest entry.
  const startingBranch = detectStartingBranch(repoPath);

  for (let idx = 0; idx < items.length; idx++) {
    if (abortSignal.aborted) break;

    const item = items[idx];
    const picked = pickWorkerForItem({
      item,
      workers: schedulerWorkers,
      voicesById,
      bypassQuota,
    });

    if (!picked) {
      const entry: OrchestrateManifestEntry = {
        idx,
        itemId: item.id,
        voiceId: "",
        branch: "",
        diffStat: "",
        status: "failed",
        error: `no eligible worker for complexity=${item.complexity}`,
      };
      manifest.workers.push(entry);
      onEvent({
        chatId,
        type: "phase_progress",
        payload: {
          phaseId: phase.id,
          phaseIdx,
          kind: "orchestrate",
          workerIdx: idx,
          itemId: item.id,
          status: "failed",
          error: entry.error,
        },
        ts: Date.now(),
      });
      continue;
    }

    const branch = formatBranchName(phase.branchPrefix, chatId, idx);

    onEvent({
      chatId,
      type: "phase_start",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: "orchestrate",
        role: "worker",
        workerIdx: idx,
        itemId: item.id,
        voiceId: picked.voiceId,
        lineage: picked.lineage,
        branch,
      },
      ts: Date.now(),
    });

    // Always start each worker from the original starting branch so we
    // don't stack workers on top of each other. `git checkout
    // <startingBranch>` is a no-op when we're already on it. Pre-fix this
    // result was ignored — if checkout failed (dirty working tree, locked
    // index from a parallel CLI, etc.), subsequent workers would stack on
    // top of the previous worker's branch, polluting diff stats and
    // triggering ugly merge conflicts on open-pr.
    if (startingBranch && startingBranch !== "HEAD") {
      const checkoutResult = git(repoPath, ["checkout", startingBranch]);
      if (!checkoutResult.ok) {
        const detail = `git checkout ${startingBranch} failed: ${checkoutResult.stderr.trim()}`;
        const entry: OrchestrateManifestEntry = {
          idx,
          itemId: item.id,
          voiceId: picked.voiceId,
          branch,
          diffStat: "",
          status: "failed",
          error: detail,
        };
        manifest.workers.push(entry);
        onEvent({
          chatId,
          type: "phase_failed",
          payload: {
            phaseId: phase.id,
            phaseIdx,
            kind: "orchestrate",
            workerIdx: idx,
            itemId: item.id,
            reason: "checkout_failed",
            detail,
          },
          ts: Date.now(),
        });
        continue;
      }
    }

    const branchResult = createWorkerBranch(repoPath, branch);
    if (!branchResult.ok) {
      const entry: OrchestrateManifestEntry = {
        idx,
        itemId: item.id,
        voiceId: picked.voiceId,
        branch,
        diffStat: "",
        status: "failed",
        error: branchResult.detail,
      };
      manifest.workers.push(entry);
      onEvent({
        chatId,
        type: "phase_failed",
        payload: {
          phaseId: phase.id,
          phaseIdx,
          kind: "orchestrate",
          workerIdx: idx,
          itemId: item.id,
          reason: "branch_create_failed",
          detail: branchResult.detail,
        },
        ts: Date.now(),
      });
      continue;
    }

    // 4. Spawn the worker headlessly. We bypass runDoer's reviewer-loop
    //    machinery — workers are single-shot doers in v1. The shim's
    //    runHeadless yields events; we drain them and capture the final
    //    text. Errors mark the entry failed and we move on.
    const shim = pickShimForVoice(picked.lineage as Lineage, picked.model);
    const prompt = buildWorkerPrompt(item, repoPath);

    let workerErr: string | undefined;
    if (shim.runHeadless) {
      try {
        const stream = shim.runHeadless({
          cwd: repoPath,
          promptText: prompt,
          model: picked.model,
          // Worker needs to write files — workspace sandbox + auto-approve
          // matches the doer-driver default for repo-targeted work.
          sandbox: "workspace",
          autoApprove: true,
          networkAccess: false,
          abortSignal,
          timeoutMs: phase.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS,
        });
        for await (const event of stream) {
          if (event.type === "error") {
            workerErr = `${event.kind}: ${event.message}`;
          }
          // Surface live progress so the cockpit can show the worker is
          // alive. We don't accumulate text here — the cockpit reads
          // diffStat post-hoc; the worker writes its summary into the
          // working tree, not a chat artifact dir.
          if (event.type === "text_delta" || event.type === "progress") {
            onEvent({
              chatId,
              type: "phase_progress",
              payload: {
                phaseId: phase.id,
                phaseIdx,
                kind: "orchestrate",
                workerIdx: idx,
                voiceId: picked.voiceId,
                role: "worker",
              },
              ts: Date.now(),
            });
          }
        }
      } catch (err) {
        workerErr = err instanceof Error ? err.message : String(err);
      }
    } else {
      // Shim has no headless mode — fail this worker. v1 doesn't fall
      // back to tmux for orchestrate (would mean wiring a TUI for every
      // sub-task; deferred).
      workerErr = `shim ${shim.name} has no runHeadless implementation`;
    }

    const diffStat = captureDiffStat(repoPath, startingBranch, branch);

    const entry: OrchestrateManifestEntry = {
      idx,
      itemId: item.id,
      voiceId: picked.voiceId,
      branch,
      diffStat,
      status: workerErr ? "failed" : "completed",
      ...(workerErr ? { error: workerErr } : {}),
    };
    manifest.workers.push(entry);

    onEvent({
      chatId,
      type: workerErr ? "phase_failed" : "phase_progress",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: "orchestrate",
        workerIdx: idx,
        itemId: item.id,
        voiceId: picked.voiceId,
        branch,
        diffStat,
        status: entry.status,
        ...(workerErr ? { error: workerErr } : {}),
      },
      ts: Date.now(),
    });
  }

  // 5. Restore the user's starting branch — workers shouldn't leave the
  //    repo on the last worker's branch. Best-effort.
  if (startingBranch && startingBranch !== "HEAD") {
    git(repoPath, ["checkout", startingBranch]);
  }

  manifest.completedAt = Date.now();
  try {
    atomicWriteJsonSync(
      path.join(chatDir, "orchestrate-manifest.json"),
      manifest,
    );
  } catch (err) {
    logger.warn(
      { chatId, err: err instanceof Error ? err.message : String(err) },
      "orchestrate: failed to persist manifest",
    );
  }

  return {
    completed: !abortSignal.aborted,
    manifest,
  };
}
