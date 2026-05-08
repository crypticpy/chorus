import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import { chats, phaseEvents, templates } from "../../lib/db/index.js";
import { chatLogger, logger } from "../../lib/logger.js";
import {
  TemplateSchema,
  isReviewOnlyPhase,
  templateRequiresArtifact,
} from "../../lib/template-schema.js";
import {
  errorResponse,
  listEnvelope,
  sendError,
  successResponse,
  type ApiResponse,
  type ListEnvelope,
} from "../api-response.js";
import type { ErrorDetector } from "../error-detector.js";
import * as participantAborts from "../participant-aborts.js";
import {
  abortActiveRun,
  getActiveRun,
  runWithMultiplex,
} from "../runner-multiplex.js";
import type { TmuxManager } from "../tmux-types.js";
import { registerChatsFromPrRoute } from "./chats-from-pr.js";
import { registerChatStreamRoute } from "./chats-stream.js";
import { isValidChatId } from "./chats-validation.js";

export { isValidChatId };

const TERMINAL_STATUSES = [
  "approved",
  "merged",
  "blocked",
  "cancelled",
  "failed",
  "no_review",
] as const;
type ChatStatus = (typeof TERMINAL_STATUSES)[number] | "drafting" | "reviewing";
type PhaseKind =
  | "plan"
  | "spec"
  | "tests"
  | "implement"
  | "review"
  | "verify"
  | "divergence"
  | "review_only";

const VALID_PHASE_KINDS: readonly PhaseKind[] = [
  "plan",
  "spec",
  "tests",
  "implement",
  "review",
  "verify",
  "divergence",
];

interface RegisterChatRoutesArgs {
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
}

type ChatRow = Awaited<ReturnType<typeof chats.create>>;

export type CreateChatInputs = {
  work: string;
  templateId: string;
  files?: string[];
  canonicalRepoPath?: string;
  artifact?: string;
  yolo?: boolean;
  /** Set true on PR-review chats so the orchestrate scheduler ignores
   *  voice.tier and runs every enabled voice at full capacity. */
  bypassQuota?: boolean;
  requestId?: string;
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
};

export type CreateChatResult =
  | { ok: true; chat: ChatRow }
  | {
      ok: false;
      code: "validation" | "not_found" | "db_error";
      message: string;
      data?: Record<string, unknown>;
    };

// Shared chat-creation tail used by POST /chats and POST /chats/from-pr.
// Performs template lookup, parses to identify the initial phase, validates
// the artifact against the template's review-only constraints, persists the
// chat row + opening phase event, and fire-and-forgets the runner.
//
// Caller is responsible for input shape / repoPath canonicalization. This
// helper assumes everything passed is already syntactically valid.
export async function createChatFromValidatedInputs(
  args: CreateChatInputs,
): Promise<CreateChatResult> {
  const {
    work,
    templateId,
    files,
    canonicalRepoPath,
    artifact,
    yolo,
    bypassQuota,
    requestId,
    tmuxMgr,
    errorDetector,
  } = args;

  const tmpl = await templates.getById(templateId);
  if (!tmpl) {
    const valid = (await templates.list()).map((t) => t.id);
    return {
      ok: false,
      code: "not_found",
      message: `Unknown templateId "${templateId}". Valid IDs: ${valid.join(", ")}`,
      data: { validIds: valid },
    };
  }
  if (!tmpl.is_complete) {
    return {
      ok: false,
      code: "validation",
      message: `Template "${templateId}" needs setup — at least one slot has no models. Edit the YAML to assign models for your fleet.`,
    };
  }

  let initialPhaseKind: PhaseKind = "plan";
  let parsedTemplateForArtifactCheck: ReturnType<
    typeof TemplateSchema.parse
  > | null = null;
  try {
    const rawParsed = yaml.parse(tmpl.yaml);
    const safe = TemplateSchema.safeParse(rawParsed);
    if (safe.success) {
      parsedTemplateForArtifactCheck = safe.data;
      const firstKind = safe.data.phases[0]?.kind;
      initialPhaseKind = firstKind as PhaseKind;
    } else {
      const loose = rawParsed as
        | { phases?: Array<{ kind?: string }> }
        | undefined;
      const firstKind = loose?.phases?.[0]?.kind;
      if (firstKind === "review_only") initialPhaseKind = "review_only";
      else if (
        typeof firstKind === "string" &&
        (VALID_PHASE_KINDS as readonly string[]).includes(firstKind)
      ) {
        initialPhaseKind = firstKind as PhaseKind;
      }
    }
  } catch {
    /* fall through with 'plan' default */
  }

  if (
    parsedTemplateForArtifactCheck &&
    templateRequiresArtifact(parsedTemplateForArtifactCheck)
  ) {
    if (typeof artifact !== "string" || artifact.trim().length === 0) {
      return {
        ok: false,
        code: "validation",
        message: "artifact is required for review-only templates",
      };
    }
    const firstPhase = parsedTemplateForArtifactCheck.phases[0];
    if (firstPhase && isReviewOnlyPhase(firstPhase)) {
      const maxBytes = firstPhase.artifact.maxBytes;
      const byteLen = Buffer.byteLength(artifact, "utf-8");
      if (byteLen > maxBytes) {
        return {
          ok: false,
          code: "validation",
          message: `artifact exceeds template limit (${byteLen} bytes > ${maxBytes} bytes)`,
        };
      }
    }
  } else if (artifact !== undefined && artifact !== null && artifact !== "") {
    return {
      ok: false,
      code: "validation",
      message: "artifact is only valid for review-only templates",
    };
  }

  const chat = await chats.create({
    work,
    template_id: templateId,
    attached_files: files ? JSON.stringify(files) : undefined,
    repo_path: canonicalRepoPath,
    artifact: artifact ?? undefined,
    yolo: yolo === true,
    bypass_quota: bypassQuota === true,
  });

  await phaseEvents.create({
    chat_id: chat.id,
    phase_idx: 0,
    phase_kind: initialPhaseKind,
    role: "doer",
    agent_id: null,
    state: "drafting",
    output: null,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    started_at: Date.now(),
    finished_at: null,
  });

  chatLogger(chat.id).info(
    {
      templateId,
      phaseKind: initialPhaseKind,
      requestId,
      hasArtifact:
        artifact !== undefined && artifact !== null && artifact !== "",
      hasRepoPath: canonicalRepoPath !== undefined,
      attachedFileCount: files?.length ?? 0,
    },
    "chat created",
  );

  // Auto-fire the runner. Fire-and-forget; the SSE route attaches to the
  // existing activeRuns entry rather than re-creating one.
  if (
    parsedTemplateForArtifactCheck &&
    !(TERMINAL_STATUSES as readonly string[]).includes(chat.status)
  ) {
    const entry = runWithMultiplex({
      chatId: chat.id,
      template: parsedTemplateForArtifactCheck,
      chat,
      tmuxMgr,
      errorDetector,
    });
    entry.promise.catch((err: unknown) => {
      chatLogger(chat.id).error(
        { err: err instanceof Error ? err.message : String(err) },
        "auto-fired chat runner failed",
      );
    });
  }

  return { ok: true, chat };
}

export function registerChatRoutes(
  fastify: FastifyInstance,
  { tmuxMgr, errorDetector }: RegisterChatRoutesArgs,
): void {
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
    Reply: ApiResponse<ListEnvelope<object>>;
  }>("/chats", async (request) => {
    try {
      const { status, limit, offset } = request.query;
      const list = await chats.list({
        status: status || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
      return successResponse(listEnvelope(list));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>("/chats/:id", async (request, reply) => {
    try {
      if (!isValidChatId(request.params.id)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      const chat = await chats.getBySlugOrId(request.params.id);
      if (!chat) {
        return sendError(
          reply,
          "not_found",
          `Chat ${request.params.id} not found`,
        );
      }
      // phaseEvents.list keys by ULID, not slug. Use the resolved row's
      // id so a /chats/<slug> request returns events correctly.
      const events = await phaseEvents.list(chat.id);
      return successResponse({ ...chat, events });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  fastify.post<{
    Body: {
      work: string;
      templateId: string;
      files?: string[];
      repoPath?: string;
      artifact?: string;
      yolo?: boolean;
    };
    Reply: ApiResponse<object>;
  }>("/chats", async (request, reply) => {
    try {
      const { work, templateId, files, repoPath, artifact, yolo } =
        request.body;

      if (!work || !templateId) {
        return sendError(
          reply,
          "validation",
          "work and templateId are required",
        );
      }

      // Validate repoPath — must be an absolute path to an existing
      // directory.
      //
      // Symlink handling (Audit D2 BLOCKER): pre-fix `existsSync`
      // followed symlinks silently, so a `repoPath` pointing at
      // `~/innocent-link → /etc` would pass and the doer would spawn
      // with `cwd=/etc`. We realpath-resolve and re-check the target
      // is a directory. Storing the canonical path means a later swap
      // of the symlink can't redirect the doer.
      //
      // Stricter checks (is-a-repo, gh-authed) happen when the ship
      // phase runs.
      // Resolve `repoPath` to its canonical (symlink-followed) form once
      // so we can persist the canonical path on the chat row. Pre-fix
      // we validated via realpath but stored the original `repoPath`,
      // leaving the symlink-swap attack surface from Audit D2 partially
      // open: a later swap of `~/innocent-link → /etc` would still
      // redirect the runner. `canonicalRepoPath` is undefined when no
      // repoPath was supplied — the chat creates without one.
      let canonicalRepoPath: string | undefined;
      if (repoPath !== undefined) {
        if (typeof repoPath !== "string" || !path.isAbsolute(repoPath)) {
          return sendError(
            reply,
            "validation",
            "repoPath must be an absolute path",
          );
        }
        const resolved = path.resolve(repoPath);
        try {
          // realpathSync resolves symlinks AND verifies the path
          // exists. Throws ENOENT if either link or target is missing.
          canonicalRepoPath = fs.realpathSync(resolved);
        } catch {
          return sendError(
            reply,
            "validation",
            `repoPath does not exist: ${resolved}`,
          );
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(canonicalRepoPath);
        } catch {
          return sendError(
            reply,
            "validation",
            `repoPath does not exist: ${canonicalRepoPath}`,
          );
        }
        if (!stat.isDirectory()) {
          return sendError(
            reply,
            "validation",
            `repoPath must be a directory: ${canonicalRepoPath}`,
          );
        }
      }

      const result = await createChatFromValidatedInputs({
        work,
        templateId,
        files,
        canonicalRepoPath,
        artifact,
        yolo,
        requestId: request.id,
        tmuxMgr,
        errorDetector,
      });
      if (!result.ok) {
        return sendError(reply, result.code, result.message, result.data);
      }
      return successResponse(result.chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { requestId: request.id, err: message, route: "POST /chats" },
        "chat create failed",
      );
      return errorResponse("db_error", message);
    }
  });

  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>("/chats/:id/cancel", async (request, reply) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      // Resolve slug → ULID first. Cancel/abort/tmux all key by ULID.
      const existing = await chats.getBySlugOrId(param);
      if (!existing) {
        return sendError(reply, "not_found", `Chat ${param} not found`);
      }
      const chatId = existing.id;
      const chat = await chats.cancel(chatId);

      // Abort the active runner if there is one. This propagates into
      // the runChat abortListener which fires chat_done(cancelled) once
      // (latched by emitChatDone) — including killing any LLM CLI
      // subprocesses via their AbortSignal. Without this, cancel only
      // flipped the DB row and the runner kept burning tokens until
      // natural termination.
      abortActiveRun(chatId);

      // Kill any tmux sessions associated with this chat (legacy transport).
      const allSessions = tmuxMgr.list();
      for (const session of allSessions) {
        if (session.chatId === chatId) {
          tmuxMgr.kill(session.name);
        }
      }

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  // Cancel a single participant (one reviewer or the doer) without
  // collapsing the entire chat. Useful when one runner is stuck or the
  // user wants to drop a low-value reviewer mid-flight.
  //
  // Path: POST /chats/:id/participants/:key/cancel
  // `key` matches participantAborts.participantKey:
  //   `doer-<agentName>` or `reviewer-<agentName>-<idx>`
  //
  // Returns ok:true{aborted:bool}. aborted=false means the participant
  // wasn't found in the registry (already finished, not yet started, or
  // running on the legacy tmux transport which doesn't register).
  fastify.post<{
    Params: { id: string; key: string };
    Reply: ApiResponse<{ aborted: boolean }>;
  }>("/chats/:id/participants/:key/cancel", async (request, reply) => {
    try {
      const id = request.params.id;
      if (!isValidChatId(id)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      const key = request.params.key;
      // Strict key shape — both prefixes the registry uses. Reject
      // unrecognised shapes so a malformed URL can't side-channel
      // arbitrary registry inspection by guessing keys. The agent name
      // MUST start with an alphanumeric (not `-`/`_`) so a key like
      // `reviewer--0` (empty agent name) is rejected.
      if (!/^(doer-|reviewer-)[A-Za-z0-9][A-Za-z0-9_-]*(?:-\d+)?$/.test(key)) {
        return sendError(reply, "validation", "invalid participant key");
      }
      const existing = await chats.getBySlugOrId(id);
      if (!existing) {
        return sendError(reply, "not_found", `Chat ${id} not found`);
      }
      const aborted = participantAborts.abortParticipant(existing.id, key);
      return successResponse({ aborted });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  // Re-run an existing chat. Creates a fresh chat row carrying over the
  // same work + template_id + attached_files + repo_path + artifact, plus
  // an initial phase event mirroring /chats POST. Intended for the
  // cancelled/failed → Retry button on the run viewer; the original chat
  // row stays untouched as history.
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>("/chats/:id/rerun", async (request, reply) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      const original = await chats.getBySlugOrId(param);
      if (!original) {
        return sendError(reply, "not_found", `Chat ${param} not found`);
      }
      // Guard against rerun-on-active. The cockpit Retry button only
      // renders for terminal statuses, but a direct API call could
      // otherwise spawn a duplicate runner alongside the still-alive
      // original. Reject loudly with a dedicated kind so the caller can
      // distinguish from generic validation.
      if (!(TERMINAL_STATUSES as readonly string[]).includes(original.status)) {
        return sendError(
          reply,
          "conflict",
          `Chat ${param} is still active (status=${original.status}). Cancel it first, then retry.`,
        );
      }
      // Re-realpath on rerun even though create-side now persists the
      // canonical path. Catches legacy rows from before that fix shipped
      // AND defends against a swap that happened between the original
      // chat's success and the rerun click.
      let rerunRepoPath: string | undefined = original.repo_path ?? undefined;
      if (rerunRepoPath) {
        try {
          rerunRepoPath = fs.realpathSync(rerunRepoPath);
        } catch {
          // Original path no longer resolves — skip the rerun's repoPath
          // rather than silently shipping with a broken cwd.
          rerunRepoPath = undefined;
        }
      }
      const newChat = await chats.create({
        work: original.work,
        template_id: original.template_id,
        attached_files: original.attached_files ?? undefined,
        repo_path: rerunRepoPath,
        artifact: original.artifact ?? undefined,
      });
      // Mirror the create-path's initial phase_event so the cockpit
      // gets a populated stepper from t=0.
      let initialPhaseKind: PhaseKind = "plan";
      try {
        const tmpl = await templates.getById(original.template_id);
        if (tmpl) {
          const safe = TemplateSchema.safeParse(yaml.parse(tmpl.yaml));
          if (safe.success) {
            const firstKind = safe.data.phases[0]?.kind;
            if (firstKind) initialPhaseKind = firstKind as PhaseKind;
          }
        }
      } catch {
        /* keep default */
      }
      await phaseEvents.create({
        chat_id: newChat.id,
        phase_idx: 0,
        phase_kind: initialPhaseKind,
        role: "doer",
        agent_id: null,
        state: "drafting",
        output: null,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        started_at: Date.now(),
        finished_at: null,
      });
      return successResponse(newChat);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  // Hard-delete a chat (row + phase_events + filesystem artifacts).
  // Cancels any active session first to avoid orphaned subprocesses
  // writing to the dir we're about to nuke. Idempotent: returns 200
  // even if the chat is already gone (allows the cockpit to retry
  // without distinguishing races).
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>("/chats/:id", async (request, reply) => {
    try {
      const id = request.params.id;
      if (!isValidChatId(id)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      const existing = await chats.getBySlugOrId(id);
      if (!existing) {
        return successResponse({ id, deleted: false, reason: "not_found" });
      }
      // Resolve to the row's authoritative ULID — every downstream key
      // (activeRuns, tmux sessions, phase_events, chat dir on disk)
      // uses the ULID, not the slug. Without this, the route partly
      // worked when called by slug but failed to abort the runner /
      // kill tmux.
      const ulid = existing.id;

      // 1. Cancel first if still active — flips status, signals abort.
      if (existing.status === "drafting" || existing.status === "reviewing") {
        try {
          await chats.cancel(ulid);
        } catch {
          /* best-effort */
        }
      }

      // 1b. Abort the in-memory runner if one is active. Otherwise the
      // runner could keep streaming events and write to a chat dir
      // that we're about to rm -rf, plus it would re-create the row.
      const active = getActiveRun(ulid);
      if (active) {
        active.abortController.abort();
        // Wait for the runner to settle before proceeding with the
        // delete. 5-second timeout to avoid hanging forever.
        try {
          await Promise.race([
            active.promise.catch(() => {}),
            new Promise((r) => setTimeout(r, 5000)),
          ]);
        } catch {
          /* timeout or error — proceed with delete anyway */
        }
      }

      // 2. Kill any tmux sessions tied to this chat.
      try {
        const allSessions = tmuxMgr.list();
        for (const session of allSessions) {
          if (session.chatId === ulid) tmuxMgr.kill(session.name);
        }
      } catch {
        /* tmuxMgr may not be ready in test paths */
      }

      // 3. Drop DB row + phase events.
      await chats.delete(ulid);

      // 4. Nuke chat artifacts directory.
      const osModule = await import("os");
      const chatDir = path.join(osModule.homedir(), ".chorus", "chats", ulid);
      if (fs.existsSync(chatDir)) {
        try {
          fs.rmSync(chatDir, { recursive: true, force: true });
        } catch (err) {
          // Don't fail the request — DB row is already gone, dir is
          // just disk-space cleanup.
          console.warn(`[chorus] failed to remove ${chatDir}:`, err);
        }
      }

      return successResponse({ id: ulid, deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  // Resume — finalise the user's audit checklist selection and re-fire
  // the runner onto the orchestrate phase.
  //
  // Body: { answer: string } where `answer` is JSON-encoded `string[]`
  // (the ids of audit items the user approved). This shape matches what
  // the cockpit's RunChecklist component POSTs.
  //
  // Side effects, in order:
  //   1. Cross-check the ids against `<chatDir>/audit-output.json`.
  //   2. Persist `<chatDir>/audit-selected-ids.json`.
  //   3. Update chats row: status='drafting', current_phase_idx=<orchestrate-idx>.
  //   4. Re-fire the runner via runWithMultiplex (fire-and-forget).
  fastify.post<{
    Params: { id: string };
    Body: { answer: string };
    Reply: ApiResponse<object>;
  }>("/chats/:id/resume", async (request, reply) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return sendError(reply, "validation", "invalid chat id");
      }
      const existing = await chats.getBySlugOrId(param);
      if (!existing) {
        return sendError(reply, "not_found", `Chat ${param} not found`);
      }
      const chatId = existing.id;

      if (existing.status !== "blocked") {
        return sendError(
          reply,
          "validation",
          `Chat ${param} is not blocked (status=${existing.status})`,
        );
      }

      const { answer } = request.body;
      if (typeof answer !== "string" || answer.length === 0) {
        return sendError(reply, "validation", "answer is required");
      }

      // Parse `answer` as JSON; must be a string[].
      let selectedIds: string[];
      try {
        const parsed = JSON.parse(answer);
        if (
          !Array.isArray(parsed) ||
          !parsed.every((s) => typeof s === "string")
        ) {
          return sendError(
            reply,
            "validation",
            "answer must be a JSON-encoded array of strings",
          );
        }
        selectedIds = parsed as string[];
      } catch (err) {
        return sendError(
          reply,
          "validation",
          `answer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Cross-check against audit-output.json. Every id the user
      // submitted must exist in the audit phase's items list — a
      // mismatch likely means the cockpit is stale or a malicious
      // client is fishing.
      const osModule = await import("os");
      const chatDir = path.join(osModule.homedir(), ".chorus", "chats", chatId);
      const auditPath = path.join(chatDir, "audit-output.json");
      let validIds: Set<string>;
      try {
        const raw = JSON.parse(fs.readFileSync(auditPath, "utf-8")) as {
          items?: Array<{ id?: unknown }>;
        };
        if (!Array.isArray(raw.items)) {
          return sendError(
            reply,
            "validation",
            "audit-output.json is missing items[]",
          );
        }
        validIds = new Set(
          raw.items
            .map((it) => it?.id)
            .filter((id): id is string => typeof id === "string"),
        );
      } catch (err) {
        return sendError(
          reply,
          "validation",
          `cannot read audit-output.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const unknownIds = selectedIds.filter((id) => !validIds.has(id));
      if (unknownIds.length > 0) {
        return sendError(
          reply,
          "validation",
          `unknown audit item ids: ${unknownIds.join(", ")}`,
        );
      }

      // Persist the user's selection. atomicWriteJsonSync so a crash
      // mid-write can't leave a partial file the orchestrate phase
      // chokes on.
      const { atomicWriteJsonSync } = await import("../../lib/atomic-write.js");
      try {
        atomicWriteJsonSync(path.join(chatDir, "audit-selected-ids.json"), {
          ids: selectedIds,
          submittedAt: Date.now(),
        });
      } catch (err) {
        return sendError(
          reply,
          "db_error",
          `failed to persist selection: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Find the orchestrate phase index. Prefer the frozen
      // template_snapshot (what the chat actually ran against) over the
      // live template (which may have been edited since the chat fired).
      let orchestrateIdx = -1;
      let parsedTemplate: ReturnType<typeof TemplateSchema.parse> | null = null;
      const tryParseSnapshot = (snapshot: string | null): boolean => {
        if (!snapshot) return false;
        try {
          const parsed = TemplateSchema.safeParse(JSON.parse(snapshot));
          if (parsed.success) {
            parsedTemplate = parsed.data;
            return true;
          }
        } catch {
          /* fall through */
        }
        return false;
      };
      if (!tryParseSnapshot(existing.template_snapshot)) {
        const tmpl = await templates.getById(existing.template_id);
        if (tmpl) {
          const parsed = TemplateSchema.safeParse(yaml.parse(tmpl.yaml));
          if (parsed.success) parsedTemplate = parsed.data;
        }
      }
      if (parsedTemplate) {
        orchestrateIdx = parsedTemplate.phases.findIndex(
          (p) => p.kind === "orchestrate",
        );
      }
      if (orchestrateIdx < 0 || !parsedTemplate) {
        return sendError(
          reply,
          "validation",
          "chat's template has no orchestrate phase",
        );
      }

      // Flip status + phase index. The runner reads
      // chat.current_phase_idx via runner-multiplex when re-fired.
      const updated = await chats.update(chatId, {
        status: "drafting",
        current_phase_idx: orchestrateIdx,
      });

      // Re-fire the runner. Fire-and-forget; SSE re-attachers latch
      // onto the fresh activeRuns entry. Catch the promise so an
      // unhandled rejection doesn't crash the daemon if the runner
      // throws synchronously during setup.
      const entry = runWithMultiplex({
        chatId,
        template: parsedTemplate,
        chat: updated,
        tmuxMgr,
        errorDetector,
      });
      entry.promise.catch((err: unknown) => {
        chatLogger(chatId).error(
          { err: err instanceof Error ? err.message : String(err) },
          "resumed runner failed",
        );
      });

      return successResponse(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse("db_error", message);
    }
  });

  registerChatsFromPrRoute(fastify, { tmuxMgr, errorDetector });
  registerChatStreamRoute(fastify, { tmuxMgr, errorDetector });
}
