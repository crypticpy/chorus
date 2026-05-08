/**
 * Structured-output adapter for CLI-backed voices.
 *
 * Phases that need typed work-item lists (audit, orchestrate) call this
 * helper rather than parsing free-form prose themselves. We wrap the
 * caller's prompt with explicit JSON-fence instructions, run the CLI via
 * its existing `runHeadless` shim, extract the JSON from the final text,
 * and validate against a zod schema. On parse / validation failure we get
 * one repair pass (configurable) where the model is told exactly what
 * went wrong and asked to re-emit just the JSON block.
 *
 * Why a single helper:
 *   - Every CLI lineage already implements `runHeadless`, so we don't
 *     need per-lineage structured-output paths.
 *   - The prompt-wrapping rules (fenced block at end, no commentary
 *     after) are uniform — duplicating them at each call site invites
 *     drift between phases.
 *   - The repair budget lives here, not in callers, so audit / orchestrate
 *     don't each invent their own retry policy.
 */

import type { z } from "zod";
import type {
  AgentShim,
  AgentEvent,
  HeadlessSpawnOptions,
} from "../agents/types.js";

export interface StructuredRequestOptions<T extends z.ZodTypeAny> {
  shim: AgentShim;
  spawn: Omit<HeadlessSpawnOptions, "promptText">;
  /**
   * Free-form prompt body. The adapter wraps this with explicit JSON
   * formatting instructions before sending — callers should NOT add
   * "respond with JSON" themselves.
   */
  prompt: string;
  /**
   * The zod schema the adapter will validate the response against. The
   * adapter inlines a JSON-schema-ish hint into the prompt so the model
   * knows the shape it's targeting.
   */
  schema: T;
  /**
   * Optional brief description of the schema (e.g. "list of audit
   * items"). Helps the model produce conformant output. Default: empty.
   */
  schemaDescription?: string;
  /** Cap retry attempts after a parse failure. Default 1 (one repair pass). */
  maxRepairAttempts?: number;
}

export type StructuredRequestResult<T extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<T>; rawText: string }
  | {
      ok: false;
      reason: "parse_error" | "spawn_error" | "schema_violation";
      detail: string;
      rawText?: string;
    };

/**
 * Wrap the caller's prompt with explicit JSON-fence instructions. We ask
 * for one trailing ```json ... ``` block and forbid commentary after it,
 * which makes the extraction step (below) deterministic.
 */
function buildInitialPrompt(prompt: string, schemaSketch: string): string {
  return (
    `${prompt}\n\n` +
    `---\n\n` +
    `Respond with your reasoning (if any) followed by a single fenced JSON block at the very end of your message. Use this exact form:\n\n` +
    "```json\n" +
    `<json matching the shape below>\n` +
    "```\n\n" +
    `Do not write anything after the closing fence. The JSON must match this shape:\n\n` +
    `${schemaSketch}\n`
  );
}

/**
 * Repair prompt: surface the exact parse/validation error so the model
 * knows what to fix, and tighten the format contract (JSON only, no
 * prose) to maximise the chance of success on the second attempt.
 */
function buildRepairPrompt(
  originalPrompt: string,
  schemaSketch: string,
  errorDetail: string,
): string {
  return (
    `${originalPrompt}\n\n` +
    `---\n\n` +
    `Your previous response could not be parsed. Error: ${errorDetail}.\n\n` +
    `Re-emit ONLY a fenced \`\`\`json block matching this shape:\n\n` +
    `${schemaSketch}\n\n` +
    `No commentary. No explanation. Just the JSON.\n`
  );
}

/**
 * Best-effort sketch of the expected payload. We don't try to convert
 * the full zod schema to JSON-Schema (zod-to-json-schema is heavy and
 * the model only needs a hint, not a spec). The caller's
 * `schemaDescription` is the load-bearing signal; we tag it as JSON.
 */
function buildSchemaSketch(schemaDescription: string | undefined): string {
  const desc = (schemaDescription ?? "").trim();
  if (desc.length === 0) {
    return "A JSON object or array. Match the shape implied by the prompt above.";
  }
  return desc;
}

/**
 * Pull JSON text out of the model's final text. Tries cheapest paths
 * first: a direct parse of the trimmed text (covers "model returned
 * pure JSON"), then a fenced ```json ... ``` block, then any fenced
 * block, then the first {...} or [...] substring.
 *
 * Returns the parsed value on success, or throws the underlying parse
 * error on failure (callers convert that into a repair attempt).
 */
function extractJson(finalText: string): unknown {
  const trimmed = finalText.trim();

  // Path 1: whole response is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Path 2: ```json ... ``` fenced block.
  const jsonFence = /```json\s*([\s\S]*?)```/i.exec(finalText);
  if (jsonFence && jsonFence[1]) {
    return JSON.parse(jsonFence[1].trim());
  }

  // Path 3: any ``` ... ``` fenced block.
  const anyFence = /```\s*([\s\S]*?)```/.exec(finalText);
  if (anyFence && anyFence[1]) {
    return JSON.parse(anyFence[1].trim());
  }

  // Path 4: try {...} and [...] independently — last resort for
  // prose-wrapped JSON without a code fence. We can't pick by "first
  // opener wins" because prose like `mentions [stuff] before {object}`
  // would extract `[stuff]` instead of the real payload. Try both
  // shapes; if both parse, prefer the longer slice (more content
  // captured = more likely the real payload).
  const candidates: { value: unknown; length: number }[] = [];
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const first = finalText.indexOf(open);
    const last = finalText.lastIndexOf(close);
    if (first >= 0 && last > first) {
      const slice = finalText.slice(first, last + 1);
      try {
        candidates.push({ value: JSON.parse(slice), length: slice.length });
      } catch {
        // fall through to the other shape / re-throw below
      }
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0].value;
  }

  // Re-throw the original direct-parse error so the caller has a
  // meaningful detail to forward to the repair prompt.
  return JSON.parse(trimmed);
}

interface SpawnOutcome {
  ok: true;
  finalText: string;
}

interface SpawnFailure {
  ok: false;
  detail: string;
}

/**
 * Drive one runHeadless cycle: collect text deltas, capture the
 * terminal `message_done` finalText, surface any `error` event as a
 * spawn failure, and treat a stream that ends without `message_done`
 * as a spawn failure too (a hung CLI shouldn't look like an empty
 * answer).
 */
async function runOnce(
  shim: AgentShim,
  spawn: Omit<HeadlessSpawnOptions, "promptText">,
  promptText: string,
): Promise<SpawnOutcome | SpawnFailure> {
  if (!shim.runHeadless) {
    return {
      ok: false,
      detail: `shim ${shim.name} does not implement runHeadless`,
    };
  }

  const stream = shim.runHeadless({ ...spawn, promptText });
  let finalText: string | undefined;
  let collected = "";

  try {
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      if (ev.type === "text_delta") {
        collected += ev.text;
      } else if (ev.type === "message_done") {
        // finalText is authoritative when present; some shims pass an
        // empty string and rely on the streamed deltas instead.
        finalText =
          ev.finalText && ev.finalText.length > 0 ? ev.finalText : collected;
      } else if (ev.type === "error") {
        return { ok: false, detail: `${ev.kind}: ${ev.message}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (finalText === undefined) {
    return { ok: false, detail: "stream ended without message_done" };
  }
  return { ok: true, finalText };
}

/**
 * Send `prompt` to the given CLI shim and return a typed value matching
 * `schema`. Caller-facing contract is in the type aliases above.
 */
export async function requestStructured<T extends z.ZodTypeAny>(
  opts: StructuredRequestOptions<T>,
): Promise<StructuredRequestResult<T>> {
  const repairBudget = Math.max(0, opts.maxRepairAttempts ?? 1);
  const schemaSketch = buildSchemaSketch(opts.schemaDescription);
  const initialPrompt = buildInitialPrompt(opts.prompt, schemaSketch);

  let attemptPrompt = initialPrompt;
  let lastRawText: string | undefined;
  let lastReason: "parse_error" | "schema_violation" = "parse_error";
  let lastDetail = "no attempts run";

  // Initial attempt + up to repairBudget repair attempts.
  for (let attempt = 0; attempt <= repairBudget; attempt++) {
    const outcome = await runOnce(opts.shim, opts.spawn, attemptPrompt);
    if (!outcome.ok) {
      // Spawn errors are not repaired — the CLI itself failed, the
      // model never saw the prompt, so a repair prompt would just hit
      // the same failure mode.
      return { ok: false, reason: "spawn_error", detail: outcome.detail };
    }

    lastRawText = outcome.finalText;

    // Parse.
    let parsed: unknown;
    try {
      parsed = extractJson(outcome.finalText);
    } catch (err) {
      lastReason = "parse_error";
      lastDetail = err instanceof Error ? err.message : String(err);
      attemptPrompt = buildRepairPrompt(opts.prompt, schemaSketch, lastDetail);
      continue;
    }

    // Validate.
    const validated = opts.schema.safeParse(parsed);
    if (validated.success) {
      return {
        ok: true,
        data: validated.data as z.infer<T>,
        rawText: outcome.finalText,
      };
    }
    lastReason = "schema_violation";
    lastDetail = validated.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    attemptPrompt = buildRepairPrompt(opts.prompt, schemaSketch, lastDetail);
  }

  return {
    ok: false,
    reason: lastReason,
    detail: lastDetail,
    rawText: lastRawText,
  };
}
