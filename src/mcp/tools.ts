/**
 * Chorus MCP tools — 7 tools wrapping daemon REST API.
 * Each tool has a Zod input schema and calls daemonFetch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import yaml from "yaml";
import {
  DEFAULT_COCKPIT_URL,
  readDaemonInfo,
} from "../lib/daemon-discovery.js";
import { daemonFetch, streamChat } from "./client";

/** Per-file cap on reviewer output bundled into MCP responses. 16 KiB
 *  matches the figure called out in chorus-issues.md #5 — large enough
 *  to carry a full request_changes review with code blocks, small
 *  enough that a 5-reviewer chat doesn't blow the MCP response budget. */
const REVIEWER_OUTPUT_CAP_BYTES = 16 * 1024;

interface ReviewerArtifact {
  round: number;
  agent: string;
  content: string;
  truncated: boolean;
}

/**
 * Walk `~/.chorus/chats/<chatId>/round-N/reviewer-*` dirs and return each
 * reviewer's answer.md content (capped). Used by wait_for_chat /
 * get_chat_status to surface reviewer findings to MCP clients without
 * forcing them to re-read chorus's local chat directory by hand — see
 * chorus-issues.md #5.
 *
 * Best-effort: any FS error is swallowed and the caller continues without
 * the artifact (status fields are still useful even if outputs are gone).
 * The list is sorted by (round desc, agent asc) so the most recent round
 * is first — matches what a user actually reads in the cockpit.
 */
function readReviewerArtifacts(chatId: string): ReviewerArtifact[] {
  const chatDir = path.join(os.homedir(), ".chorus", "chats", chatId);
  if (!fs.existsSync(chatDir)) return [];

  const out: ReviewerArtifact[] = [];
  let rounds: string[];
  try {
    rounds = fs.readdirSync(chatDir).filter((n) => /^round-\d+$/.test(n));
  } catch {
    return [];
  }

  for (const roundName of rounds) {
    const round = parseInt(roundName.replace("round-", ""), 10);
    const roundDir = path.join(chatDir, roundName);
    let entries: string[];
    try {
      entries = fs
        .readdirSync(roundDir)
        .filter((n) => n.startsWith("reviewer-"));
    } catch {
      continue;
    }
    for (const reviewerName of entries) {
      const answerFile = path.join(roundDir, reviewerName, "answer.md");
      try {
        const stat = fs.statSync(answerFile);
        if (!stat.isFile() || stat.size === 0) continue;
        const truncated = stat.size > REVIEWER_OUTPUT_CAP_BYTES;
        const buf = Buffer.alloc(
          Math.min(stat.size, REVIEWER_OUTPUT_CAP_BYTES),
        );
        const fd = fs.openSync(answerFile, "r");
        try {
          fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        out.push({
          round,
          agent: reviewerName.replace(/^reviewer-/, ""),
          content: buf.toString("utf-8"),
          truncated,
        });
      } catch {
        // missing/unreadable — skip this reviewer
      }
    }
  }

  out.sort((a, b) =>
    a.round !== b.round ? b.round - a.round : a.agent.localeCompare(b.agent),
  );
  return out;
}

/**
 * Resolve the cockpit URL the run links should point at. Sync read from
 * daemon.json (no health probe — the link is informational; if the
 * cockpit is dead the user finds out when they click it). CHORUS_WEB_URL
 * env override remains the explicit escape hatch.
 */
function cockpitBase(): string {
  if (process.env.CHORUS_WEB_URL) return process.env.CHORUS_WEB_URL;
  const info = readDaemonInfo();
  if (info) return `http://127.0.0.1:${info.cockpitPort}`;
  return DEFAULT_COCKPIT_URL;
}

// Daemon stores chats with snake_case `id` + `current_phase_idx`; MCP contract
// is camelCase `chatId` + `phase`. Single source of truth for the mapping so
// every tool returns the same shape.
interface DaemonChatRow {
  id: string;
  status: string;
  current_phase_idx?: number;
  updated_at?: number;
  /** Optional slug — present on chats created after the slug migration. */
  slug?: string | null;
}
function chatRowToRef(row: DaemonChatRow) {
  const webBase = cockpitBase();
  // Prefer slug for the user-visible URL (it's what the cockpit uses
  // too). Falls back to ULID for legacy rows the daemon couldn't
  // backfill — both forms resolve identically server-side.
  const segment = row.slug || row.id;
  return {
    chatId: row.id,
    status: row.status,
    url: `${webBase}/runs/${segment}`,
  };
}
function chatRowToStatus(row: DaemonChatRow) {
  return {
    chatId: row.id,
    status: row.status,
    phase: row.current_phase_idx,
    blocked: row.status === "blocked",
  };
}

interface RawTemplateRow {
  id: string;
  source?: string;
  yaml?: string;
}

interface ParsedTemplateYaml {
  name?: string;
  description?: string;
  phases?: Array<{
    doer?: { lineage?: string };
    reviewer?: { candidates?: Array<{ lineage?: string }> };
  }>;
}

function parseTemplateRow(row: RawTemplateRow): {
  id: string;
  name: string;
  description: string;
  lineages: string[];
} {
  let parsed: ParsedTemplateYaml = {};
  if (row.yaml) {
    try {
      parsed = (yaml.parse(row.yaml) as ParsedTemplateYaml) ?? {};
    } catch {
      // ignore — fall through to id-only fallback
    }
  }
  const lineages = new Set<string>();
  for (const p of parsed.phases ?? []) {
    if (p.doer?.lineage) lineages.add(p.doer.lineage);
    for (const c of p.reviewer?.candidates ?? []) {
      if (c.lineage) lineages.add(c.lineage);
    }
  }
  return {
    id: row.id,
    name: parsed.name ?? row.id,
    description: parsed.description ?? "",
    lineages: Array.from(lineages),
  };
}

// ─── Input schemas ───────────────────────────────────────────────────────

/**
 * Pre-launch (v0.7) naming sweep landed `templateId` as the canonical
 * field — matches the REST POST /chats body shape and the
 * `<resource>Id` pattern used elsewhere (`chatId`, `personaId`).
 * The legacy `template` alias is accepted so existing scripts keep
 * working through v0.7; will be dropped in v0.8.
 *
 * Per-field `.describe()` calls are loadbearing — the MCP SDK turns
 * them into the `description` strings on the published JSONSchema, so
 * MCP clients can introspect what each field means rather than
 * guessing (chorus-issues.md #8).
 *
 * IMPORTANT: kept as a plain `z.object()` (no `.transform()`). MCP
 * clients introspect the schema to discover required fields; wrapping
 * it in `ZodEffects` strips the `properties` map and the tool reports
 * an empty schema. The legacy `template` → `templateId` alias is
 * resolved inside `createChat()` instead.
 */
export const CreateChatSchema = z.object({
  work: z
    .string()
    .min(1, "work prompt is required")
    .describe(
      "The brief / question / instruction the chat should act on. " +
        "For review-only templates this is the framing prompt; the " +
        "artifact under review goes in `artifact`. Required.",
    ),
  templateId: z
    .string()
    .optional()
    .describe(
      "Template id from `list_templates` (e.g. `code-review`, " +
        "`review-only`, `tri-review`). Defaults to `code-review` when " +
        "omitted.",
    ),
  template: z
    .string()
    .optional()
    .describe(
      "Legacy alias for `templateId`. Accepted through v0.7; will be " +
        "dropped in v0.8 — prefer `templateId`.",
    ),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Absolute or repo-relative paths to attach to the doer/reviewer " +
        "prompt. Each file is inlined (capped per file by chorus's " +
        "attached-file limit).",
    ),
  artifact: z
    .string()
    .optional()
    .describe(
      "Artifact text for review-only templates (e.g. `templateId: " +
        '"review-only"`). Required when the chosen template\'s first ' +
        "phase has `kind: review_only`. Ignored for full-pipeline " +
        "templates. Capped by the template's artifact.maxBytes " +
        "(default 1 MiB).",
    ),
  repoPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to the repo the chat targets. When set, " +
        "reviewers run inside the repo (so `gh`, file reads, and " +
        "sandboxed CLIs like Gemini can see the code) and the ship " +
        "phase can commit/push. Optional.",
    ),
});

/**
 * Schema for `review_pr` — fetches a GitHub PR via gh CLI and seeds a
 * review-only chat from the synthesized artifact. Same `ZodEffects`-strips-
 * properties hazard as `CreateChatSchema` — kept as a plain `z.object()`.
 */
export const ReviewPrSchema = z.object({
  url: z
    .string()
    .min(1, "url is required")
    .describe(
      "Full GitHub PR URL (e.g. https://github.com/owner/repo/pull/123). " +
        "The chorus daemon shells out to `gh` on the host machine to fetch " +
        "PR meta, diff, and existing comments.",
    ),
  templateId: z
    .string()
    .optional()
    .describe(
      "Template id from `list_templates`. Must be a review-only template " +
        "(e.g. `review-only`). Defaults to `review-only` when omitted.",
    ),
  repoPath: z
    .string()
    .optional()
    .describe(
      "Optional absolute path to the PR's repo on local disk. Used as the " +
        "cwd for `gh`. Pass when the repo is checked out locally so the " +
        "chat row retains the path for follow-up flows.",
    ),
});

export const WaitForChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  timeoutSec: z.number().int().positive().optional().default(600),
});

export const GetChatStatusSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListBlockedSchema = z.object({});

export const ResumeChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  answer: z.string().min(1, "answer is required"),
});

export const CancelChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListTemplatesSchema = z.object({});

export const ListPersonasSchema = z.object({});

/**
 * Schema for `invoke_persona`.
 *
 * Same `ZodEffects`-strips-properties hazard as `CreateChatSchema` — kept
 * as a plain `z.object()` so MCP introspection sees the real fields. The
 * legacy `template` alias and the `code-review` default are applied in
 * `invokePersona()` via `resolveTemplateId()` (chorus-issues.md #8).
 */
export const InvokePersonaSchema = z.object({
  personaId: z
    .string()
    .min(1, "personaId is required")
    .describe(
      "Persona id from `list_personas` (e.g. `kim-general`, " +
        "`security-reviewer`). The persona's `system_prompt` is " +
        "prepended to `brief`. Required.",
    ),
  brief: z
    .string()
    .min(1, "brief is required")
    .describe(
      "The user request that the persona should act on. Combined with " +
        "the persona's system prompt before being handed to the doer. " +
        "Required.",
    ),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Absolute or repo-relative paths to attach to the prompt. Each " +
        "file is inlined (capped per file by chorus's attached-file " +
        "limit).",
    ),
  templateId: z
    .string()
    .optional()
    .describe(
      "Template id from `list_templates`. Controls which lineage runs " +
        "the persona (e.g. `code-review`, `tri-review`). Defaults to " +
        "`code-review` when omitted.",
    ),
  template: z
    .string()
    .optional()
    .describe(
      "Legacy alias for `templateId`. Accepted through v0.7; will be " +
        "dropped in v0.8 — prefer `templateId`.",
    ),
  repoPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to the repo the persona should run against. When " +
        "set, reviewers and the doer run inside the repo so they can " +
        "see the code. Optional.",
    ),
});

// ─── Output schemas ─────────────────────────────────────────────────────

const ChatRefSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  url: z.string(),
});

const ReviewerArtifactSchema = z.object({
  round: z.number(),
  agent: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

const ChatStatusSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  phase: z.number().optional(),
  progress: z.number().optional(),
  blocked: z.boolean().optional(),
  /** Each finished reviewer's answer.md content (capped, most-recent
   *  round first). Empty when nothing has been written yet. */
  reviews: z.array(ReviewerArtifactSchema).optional(),
});

const ChatResultSchema = z.object({
  status: z.string(),
  verdict: z.string().optional(),
  summary: z.string().optional(),
  blocked: z.boolean().optional(),
  /** Each finished reviewer's answer.md content (capped, most-recent
   *  round first). Lets MCP clients surface "request changes" verdicts
   *  with their findings instead of having to read ~/.chorus by hand. */
  reviews: z.array(ReviewerArtifactSchema).optional(),
});

const BlockedChatSchema = z.object({
  chatId: z.string(),
  work: z.string(),
  blockedReason: z.string(),
  since: z.number(),
});

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  lineages: z.array(z.string()).optional(),
});

const PersonaSchema = z.object({
  id: z.string(),
  label: z.string(),
  oneLiner: z.string(),
  recommendedLineage: z.string().nullable().optional(),
  builtin: z.boolean(),
});

interface DaemonPersonaRow {
  id: string;
  label: string;
  one_liner: string;
  system_prompt: string;
  recommended_lineage: string | null;
  builtin: boolean | number;
}

function personaRowToRef(row: DaemonPersonaRow) {
  return {
    id: row.id,
    label: row.label,
    oneLiner: row.one_liner,
    recommendedLineage: row.recommended_lineage,
    builtin: Boolean(row.builtin),
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────

/** Resolve the legacy `template` alias and apply the `code-review`
 *  default. Empty strings count as missing — the daemon rejects them
 *  outright, so we treat them the same as omitted. Previously lived in
 *  a Zod `.transform()` but moved out so the MCP schema introspection
 *  exposes the real `properties` map (chorus-issues.md #8). */
function resolveTemplateId(input: {
  templateId?: string;
  template?: string;
}): string {
  const fromCanonical =
    input.templateId && input.templateId.length > 0
      ? input.templateId
      : undefined;
  const fromAlias =
    input.template && input.template.length > 0 ? input.template : undefined;
  return fromCanonical ?? fromAlias ?? "code-review";
}

/**
 * Create a new chat.
 * Returns immediately with chatId and status.
 */
export async function createChat(input: unknown) {
  const parsed = CreateChatSchema.parse(input);
  const templateId = resolveTemplateId(parsed);

  const result = await daemonFetch<DaemonChatRow>("/chats", {
    method: "POST",
    body: JSON.stringify({
      work: parsed.work,
      templateId,
      files: parsed.files,
      ...(parsed.artifact !== undefined ? { artifact: parsed.artifact } : {}),
      ...(parsed.repoPath !== undefined ? { repoPath: parsed.repoPath } : {}),
    }),
  });

  return ChatRefSchema.parse(chatRowToRef(result));
}

/**
 * Seed a review-only chat from a GitHub PR URL. The daemon fetches PR
 * meta + diff + existing comments via `gh` and composes an artifact;
 * we just forward the request and return the resulting chat ref.
 *
 * Defaults `templateId` to `review-only` so a caller can pass just a
 * URL and get a useful run.
 */
export async function reviewPr(input: unknown) {
  const parsed = ReviewPrSchema.parse(input);
  const templateId = parsed.templateId ?? "review-only";

  const result = await daemonFetch<DaemonChatRow>("/chats/from-pr", {
    method: "POST",
    body: JSON.stringify({
      url: parsed.url,
      templateId,
      ...(parsed.repoPath !== undefined ? { repoPath: parsed.repoPath } : {}),
    }),
  });

  return ChatRefSchema.parse(chatRowToRef(result));
}

/**
 * Long-poll a chat until terminal state.
 * Emits progress events via SSE stream.
 * Resolves when status flips to terminal.
 */
export async function waitForChat(
  input: unknown,
  onProgress: (event: Record<string, unknown>) => void,
) {
  const parsed = WaitForChatSchema.parse(input);

  for await (const event of streamChat(parsed.chatId, parsed.timeoutSec)) {
    onProgress(event);

    // Check if we've reached a terminal state
    if (event && typeof event === "object") {
      const status = (event as Record<string, unknown>).status;
      if (
        status === "approved" ||
        status === "merged" ||
        status === "blocked" ||
        status === "cancelled" ||
        status === "failed"
      ) {
        const reviews = readReviewerArtifacts(parsed.chatId);
        const merged = {
          ...(event as Record<string, unknown>),
          ...(reviews.length > 0 ? { reviews } : {}),
        };
        return ChatResultSchema.parse(merged);
      }
    }
  }

  // If stream closed without reaching terminal, fetch final status
  const result = (await daemonFetch<unknown>(
    `/chats/${parsed.chatId}`,
  )) as Record<string, unknown> | null;
  const reviews = readReviewerArtifacts(parsed.chatId);
  const merged = {
    ...(result ?? {}),
    ...(reviews.length > 0 ? { reviews } : {}),
  };
  return ChatResultSchema.parse(merged);
}

/**
 * Get current chat status without blocking.
 */
export async function getChatStatus(input: unknown) {
  const parsed = GetChatStatusSchema.parse(input);

  const result = await daemonFetch<DaemonChatRow>(`/chats/${parsed.chatId}`);
  const reviews = readReviewerArtifacts(parsed.chatId);
  const status = chatRowToStatus(result);
  return ChatStatusSchema.parse({
    ...status,
    ...(reviews.length > 0 ? { reviews } : {}),
  });
}

/**
 * List all blocked chats.
 */
export async function listBlocked(input: unknown) {
  ListBlockedSchema.parse(input);
  // input is empty object, but we validate it anyway for schema consistency

  const result = await daemonFetch<unknown>("/blocked");
  // Daemon now returns the canonical list envelope `{items, total, hasMore}`.
  // Array fallback covers legacy callers; `.chats` fallback covers an even
  // older shape that lived briefly during the v0.6 daemon refactor.
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>)
      : Array.isArray(obj.chats)
        ? (obj.chats as Array<Record<string, unknown>>)
        : [];

  const chats = z.array(BlockedChatSchema).parse(
    rows.map((row) => ({
      chatId: row.id,
      work: row.work,
      blockedReason: row.ship_error ?? "Awaiting user input",
      since: row.updated_at,
    })),
  );

  return { chats };
}

/**
 * Resume a blocked chat with a user answer.
 */
export async function resumeChat(input: unknown) {
  const parsed = ResumeChatSchema.parse(input);

  const result = await daemonFetch<DaemonChatRow>(
    `/chats/${parsed.chatId}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ answer: parsed.answer }),
    },
  );

  return { ok: true, status: ChatStatusSchema.parse(chatRowToStatus(result)) };
}

/**
 * Cancel a chat.
 */
export async function cancelChat(input: unknown) {
  const parsed = CancelChatSchema.parse(input);

  await daemonFetch<unknown>(`/chats/${parsed.chatId}/cancel`, {
    method: "POST",
  });

  return { ok: true };
}

/**
 * List all available templates.
 */
export async function listTemplates(input: unknown) {
  ListTemplatesSchema.parse(input);

  const result = await daemonFetch<unknown>("/templates");
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as RawTemplateRow[])
    : Array.isArray(obj.items)
      ? (obj.items as RawTemplateRow[])
      : Array.isArray(obj.templates)
        ? (obj.templates as RawTemplateRow[])
        : [];

  const templates = z.array(TemplateSchema).parse(rows.map(parseTemplateRow));
  return { templates };
}

/**
 * List all personas (built-in + user-defined).
 * Returns enough metadata for a picker — full system prompt is fetched
 * via /personas/:id when needed.
 */
export async function listPersonas(input: unknown) {
  ListPersonasSchema.parse(input);

  const result = await daemonFetch<unknown>("/personas");
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as DaemonPersonaRow[])
    : Array.isArray(obj.items)
      ? (obj.items as DaemonPersonaRow[])
      : Array.isArray(obj.personas)
        ? (obj.personas as DaemonPersonaRow[])
        : [];

  const personas = z.array(PersonaSchema).parse(rows.map(personaRowToRef));

  return { personas };
}

/**
 * Fire a chat that wears a chosen persona.
 *
 * The persona's `system_prompt` is prepended to the user's brief so the
 * downstream CLI sees both the worldview and the request. Voice routing is
 * handled by the existing template machinery (template's `doer.lineage`
 * decides which CLI runs); v0.7 keeps voice selection implicit via template
 * choice and v0.8 will add explicit per-phase voice override.
 */
export async function invokePersona(input: unknown) {
  const parsed = InvokePersonaSchema.parse(input);
  const templateId = resolveTemplateId(parsed);

  // Pull full persona so we have the system_prompt.
  const persona = await daemonFetch<DaemonPersonaRow>(
    `/personas/${encodeURIComponent(parsed.personaId)}`,
  );

  const composedBrief = [
    `# Persona: ${persona.label}`,
    persona.system_prompt.trim(),
    `---`,
    `# User request`,
    parsed.brief.trim(),
  ].join("\n\n");

  const result = await daemonFetch<DaemonChatRow>("/chats", {
    method: "POST",
    body: JSON.stringify({
      work: composedBrief,
      templateId,
      files: parsed.files,
      ...(parsed.repoPath !== undefined ? { repoPath: parsed.repoPath } : {}),
    }),
  });

  return ChatRefSchema.parse(chatRowToRef(result));
}
