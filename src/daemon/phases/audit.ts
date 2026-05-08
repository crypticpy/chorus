/**
 * Audit phase runner.
 *
 * One reviewer voice + one preset lens (`de-slopify`,
 * `monolith-breakdown`, `code-review`, `engineering-review`,
 * `architecture-review`) produces a typed `AuditItem[]` via the
 * structured-output adapter. Persists the items so a follow-up phase
 * (orchestrate) can pick them up after the user trims/approves the
 * checklist in the cockpit.
 *
 * Single shot — no doer, no reviewer agreement, no iterate loop. The
 * runner sets chat status to `blocked` after this returns so the runner
 * exits cleanly and the cockpit can render the checklist.
 */
import fs from "fs";
import path from "path";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import {
  AuditOutputSchema,
  type AuditItem,
  type AuditPhase,
} from "../../lib/template-schema.js";
import { pickShimForVoice } from "../agents/index.js";
import { requestStructured } from "../runner/structured-output.js";
import type { RunnerEvent } from "../runner/types.js";

/**
 * Resolve the preset prompt body. Loads from
 * `src/daemon/presets/<preset>.md` relative to this module so the lookup
 * works the same in dev (tsx), prod (compiled), and tests.
 */
function loadPresetPrompt(preset: string): string {
  // `__dirname` works in both the CJS dist build and tsx-driven dev
  // (tsx ≥4 shims it in ESM mode). Avoid `import.meta.url` here — the
  // server tsconfig compiles to CJS, where `import.meta` is a syntax
  // error.
  const promptPath = path.join(__dirname, "..", "presets", `${preset}.md`);
  return fs.readFileSync(promptPath, "utf-8");
}

export interface RunAuditPhaseArgs {
  chatDir: string;
  chatId: string;
  phase: AuditPhase;
  phaseIdx: number;
  /** User's chat work / intent text. */
  work: string;
  /** Absolute path to the user's repo. Becomes the model's cwd. */
  repoPath: string;
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
}

export interface RunAuditPhaseResult {
  /** False iff aborted before the structured request returned. */
  completed: boolean;
  /** Parsed checklist; empty when completed=false or the model returned nothing. */
  items: AuditItem[];
  /** Raw model output (for debugging / replay). Empty on failure. */
  rawText: string;
}

/**
 * Drive one audit phase.
 *
 * Layout under `<chatDir>` mirrors review-only-phase:
 *   round-1/audit/output.md   — raw model output
 *   audit-output.json         — parsed `{ items: AuditItem[] }`
 *
 * The latter lives at the chat root (not under round-1/) so the
 * follow-up orchestrate phase can find it without knowing which round
 * the audit ran in.
 */
export async function runAuditPhase(
  args: RunAuditPhaseArgs,
): Promise<RunAuditPhaseResult> {
  const {
    chatDir,
    chatId,
    phase,
    phaseIdx,
    work,
    repoPath,
    onEvent,
    abortSignal,
  } = args;

  if (abortSignal.aborted) {
    return { completed: false, items: [], rawText: "" };
  }

  const round = 1; // audit is single-pass
  const auditDir = path.join(chatDir, `round-${round}`, "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const reviewerModel = phase.reviewer.models?.[0];
  const shim = pickShimForVoice(phase.reviewer.lineage, reviewerModel);

  onEvent({
    chatId,
    type: "phase_start",
    payload: {
      phaseId: phase.id,
      phaseIdx,
      kind: phase.kind,
      round,
      role: "audit",
      agent: shim.name,
      preset: phase.preset,
    },
    ts: Date.now(),
  });

  const presetMarkdown = loadPresetPrompt(phase.preset);
  const prompt = `${presetMarkdown}\n\nUser intent: ${work}\n`;

  const result = await requestStructured({
    shim,
    spawn: {
      cwd: repoPath,
      model: reviewerModel,
      abortSignal,
      timeoutMs: phase.timeoutMs,
    },
    prompt,
    schema: AuditOutputSchema,
    schemaDescription:
      'A JSON object: { "items": Array<{ id: string, summary: string, complexity: "high"|"medium"|"low", files: string[], rationale: string }> }. `id` should be a short kebab-case slug unique within the list.',
  });

  if (!result.ok) {
    // Persist whatever raw text we got (may be empty on spawn_error) so
    // a debugger can see what the model produced.
    if (result.rawText) {
      fs.writeFileSync(path.join(auditDir, "output.md"), result.rawText);
    }
    onEvent({
      chatId,
      type: "phase_failed",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: phase.kind,
        role: "audit",
        reason: result.reason,
        detail: result.detail,
      },
      ts: Date.now(),
    });
    return {
      completed: !abortSignal.aborted,
      items: [],
      rawText: result.rawText ?? "",
    };
  }

  // Persist artifacts. Raw first (mirrors review-only's per-participant
  // dir layout); parsed JSON at the chat root so orchestrate can find it
  // without round bookkeeping.
  fs.writeFileSync(path.join(auditDir, "output.md"), result.rawText);
  atomicWriteJsonSync(path.join(chatDir, "audit-output.json"), {
    preset: phase.preset,
    phaseId: phase.id,
    items: result.data.items,
    generatedAt: Date.now(),
  });

  onEvent({
    chatId,
    type: "phase_progress",
    payload: {
      phaseId: phase.id,
      phaseIdx,
      kind: "audit",
      role: "audit",
      items: result.data.items,
    },
    ts: Date.now(),
  });

  return {
    completed: true,
    items: result.data.items,
    rawText: result.rawText,
  };
}
