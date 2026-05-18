/**
 * The babysit judge: read one PR-bot comment, classify it, decide what
 * to do with it.
 *
 * Why a separate module from the comment fetcher:
 *   - Fetcher is pure I/O (gh CLI); judge is pure model interaction.
 *   - Keeps the prompt + routing logic testable without spawning gh.
 *
 * Flow:
 *   1. `buildJudgePrompt` composes the prompt from the comment + PR
 *      context (diff snippet around the anchored lines, prior decisions
 *      on this exact comment hash).
 *   2. `judgeComment` calls `requestStructured` with the JudgeOutputSchema.
 *   3. `decideAction` is a pure function that turns the judgement + the
 *      per-comment attempt count into a concrete next step
 *      (fix / reply / escalate / skip). The state machine in babysit/
 *      runner.ts consumes this; the judge stays stateless.
 *
 * Confidence threshold: anything below 0.7 escalates (defers to human)
 * even when validity says "valid" — low confidence on a bot's claim is
 * a stronger signal to surface than to act on.
 */
import { z } from "zod";
import {
  CATEGORY_VALUES,
  VALIDITY_VALUES,
  type Category,
  type Validity,
} from "../../lib/db/babysit-decisions.js";
import { pickShimForVoice } from "../agents/index.js";
import { requestStructured } from "../runner/structured-output.js";
import type { RawPrComment } from "./comment-fetcher.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** Maximum times we'll attempt the same comment (by sha256 hash) before
 *  giving up and escalating. The design doc calls this the per-comment cap. */
export const PER_COMMENT_ATTEMPT_CAP = 3;

export const JudgeOutputSchema = z.object({
  validity: z.enum(VALIDITY_VALUES),
  category: z.enum(CATEGORY_VALUES),
  confidence: z.number().min(0).max(1),
  /** One-paragraph reason. Stored in the audit trail and shown in cockpit. */
  rationale: z.string().min(1),
  /** Optional reply text the judge wants posted (only used for reply-* categories). */
  reply: z.string().optional(),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface JudgePrContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  /** Branch the PR targets — useful for the judge to understand context. */
  baseBranch: string;
  /** A short snippet around the comment's anchored lines (review comments only). */
  anchoredSnippet?: string;
  /** Prior decisions on this exact comment_hash for this job, oldest-first.
   *  Lets the judge see "we already tried apply-targeted, it failed verify". */
  priorDecisions?: ReadonlyArray<{
    decided_at: number;
    validity: Validity;
    category: Category;
    outcome: string | null;
  }>;
}

/**
 * Compose the judge's user prompt. Pure function — no I/O, no model
 * calls. The prompt is deliberately long-form: judge accuracy depends
 * heavily on having the comment + diff context + prior-attempt history
 * in one place.
 */
export function buildJudgePrompt(
  comment: RawPrComment,
  ctx: JudgePrContext,
): string {
  const lines: string[] = [];
  lines.push(`You are judging a code-review comment posted on a pull request.`);
  lines.push(``);
  lines.push(
    `Your job: decide whether the comment is **valid**, **invalid**, **partially_valid**, or **unsure**, then assign it to ONE of these categories:`,
  );
  lines.push(
    `- \`apply-trivial\`: low-risk fix (rename, typo, missing await, simple null-check). Routable to a small/fast model.`,
  );
  lines.push(
    `- \`apply-targeted\`: localized fix that requires understanding 1–2 files (extract helper, fix off-by-one, tighten a type).`,
  );
  lines.push(
    `- \`apply-architectural\`: cross-file refactor, public API change, behavioral semantics. Slow path; pull in the strong model.`,
  );
  lines.push(
    `- \`reply-disagree\`: the comment is wrong; we should post a polite reply explaining why we're not changing the code.`,
  );
  lines.push(
    `- \`reply-ack\`: the comment is correct/nice-to-have but we don't want to act now (out of scope, deferred).`,
  );
  lines.push(
    `- \`defer-to-human\`: nuanced enough that an autonomous fix would do more harm than good. Surface to the maintainer.`,
  );
  lines.push(``);
  lines.push(
    `Set \`confidence\` honestly between 0 and 1. Anything below ${DEFAULT_CONFIDENCE_THRESHOLD} will be escalated to a human even if you marked it valid — when in doubt, score lower.`,
  );
  lines.push(``);
  lines.push(`## PR`);
  lines.push(`\`${ctx.owner}/${ctx.repo}#${ctx.prNumber}\` — ${ctx.title}`);
  lines.push(`Base: \`${ctx.baseBranch}\``);
  lines.push(``);
  lines.push(`## Comment`);
  lines.push(
    `From: **@${comment.authorLogin}**${comment.bot ? ` (recognised bot: \`${comment.bot}\`)` : ""}`,
  );
  if (comment.path) {
    lines.push(
      `Anchored on: \`${comment.path}\`${comment.line ? `:${comment.line}` : ""}`,
    );
  }
  lines.push(`Posted: ${comment.createdAt}`);
  lines.push(``);
  lines.push(`> ${oneBlockQuote(comment.body)}`);
  lines.push(``);

  if (ctx.anchoredSnippet && ctx.anchoredSnippet.trim().length > 0) {
    lines.push(`## Code context (around the anchored line)`);
    lines.push("```");
    lines.push(ctx.anchoredSnippet.trimEnd());
    lines.push("```");
    lines.push(``);
  }

  if (ctx.priorDecisions && ctx.priorDecisions.length > 0) {
    lines.push(`## Prior attempts on this exact comment`);
    lines.push(
      `We have already judged this comment ${ctx.priorDecisions.length} time(s). If prior \`apply-*\` attempts failed (\`outcome=verify_failed\` or similar), strongly prefer \`reply-disagree\` or \`defer-to-human\` this round.`,
    );
    for (const d of ctx.priorDecisions) {
      lines.push(
        `- ${new Date(d.decided_at).toISOString()}: validity=${d.validity} category=${d.category} outcome=${d.outcome ?? "(in flight)"}`,
      );
    }
    lines.push(``);
  }

  lines.push(`## Output`);
  lines.push(
    `Return a single JSON object with the fields described in the schema. For \`reply-disagree\` and \`reply-ack\` set the \`reply\` field with the actual text we should post (≤ 4 sentences, professional tone, address the bot directly).`,
  );

  return lines.join("\n");
}

/** Block-quote a multi-line comment body cleanly. */
function oneBlockQuote(body: string): string {
  return body.replace(/\r?\n/g, "\n> ");
}

export interface JudgeCommentOptions {
  comment: RawPrComment;
  ctx: JudgePrContext;
  /** Lineage of the model to use for judging (e.g. "anthropic"). */
  lineage: string;
  /** Concrete model id (e.g. "claude-sonnet-4-6"). */
  model: string;
  cwd: string;
  abortSignal: AbortSignal;
  timeoutMs: number;
  /** Override the 0.7 default for tests / per-PR config. */
  confidenceThreshold?: number;
}

export type JudgeCommentResult =
  | {
      ok: true;
      judgement: JudgeOutput;
      modelUsed: string;
      /** Will be true when judgement.confidence < threshold — caller should
       *  force-escalate even if validity says "valid". */
      belowThreshold: boolean;
      rawText: string;
    }
  | {
      ok: false;
      reason: "parse_error" | "spawn_error" | "schema_violation";
      detail: string;
      modelUsed: string;
      rawText?: string;
    };

export async function judgeComment(
  opts: JudgeCommentOptions,
): Promise<JudgeCommentResult> {
  const shim = pickShimForVoice(opts.lineage as never, opts.model);
  const prompt = buildJudgePrompt(opts.comment, opts.ctx);
  const result = await requestStructured({
    shim,
    spawn: {
      cwd: opts.cwd,
      model: opts.model,
      abortSignal: opts.abortSignal,
      timeoutMs: opts.timeoutMs,
    },
    prompt,
    schema: JudgeOutputSchema,
    schemaDescription:
      'A JSON object: { "validity": "valid"|"invalid"|"partially_valid"|"unsure", "category": "apply-trivial"|"apply-targeted"|"apply-architectural"|"reply-disagree"|"reply-ack"|"defer-to-human", "confidence": number in [0,1], "rationale": string, "reply"?: string }. The `reply` field is only required for reply-disagree / reply-ack categories.',
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      detail: result.detail,
      modelUsed: opts.model,
      rawText: result.rawText,
    };
  }

  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  return {
    ok: true,
    judgement: result.data,
    modelUsed: opts.model,
    belowThreshold: result.data.confidence < threshold,
    rawText: result.rawText,
  };
}

// --- Pure routing helper ---

export type FixTier = "trivial" | "targeted" | "architectural";

export type ActionDecision =
  | { kind: "fix"; tier: FixTier; rationale: string }
  | { kind: "reply"; text: string; rationale: string }
  | { kind: "escalate"; reason: string }
  | { kind: "skip"; reason: string };

/**
 * Map a judgement + per-comment attempt count → concrete next step.
 * Pure function so the state machine in runner.ts stays a thin
 * dispatcher. Rules in priority order:
 *
 *   1. Per-comment attempt cap exceeded → escalate (regardless of
 *      validity — if we've tried N times the cap exists for a reason).
 *   2. Below confidence threshold → escalate.
 *   3. category=defer-to-human → escalate.
 *   4. category=reply-* → reply (text from judgement.reply if present).
 *   5. category=apply-* with validity=invalid → reply-disagree fallback
 *      (apply on an invalid claim is the wrong action; reply instead).
 *   6. category=apply-* otherwise → fix at the matching tier.
 *   7. validity=unsure → escalate.
 */
export function decideAction(
  judgement: JudgeOutput,
  args: {
    attemptCount: number;
    belowThreshold: boolean;
    perCommentCap?: number;
  },
): ActionDecision {
  const cap = args.perCommentCap ?? PER_COMMENT_ATTEMPT_CAP;

  if (args.attemptCount >= cap) {
    return {
      kind: "escalate",
      reason: `per-comment attempt cap of ${cap} reached`,
    };
  }
  if (args.belowThreshold) {
    return {
      kind: "escalate",
      reason: `confidence ${judgement.confidence.toFixed(2)} below threshold`,
    };
  }
  if (judgement.category === "defer-to-human") {
    return { kind: "escalate", reason: judgement.rationale };
  }
  if (
    judgement.category === "reply-disagree" ||
    judgement.category === "reply-ack"
  ) {
    const text = (judgement.reply ?? "").trim();
    if (!text) {
      // Judge said reply but gave us nothing. Defer instead of posting
      // an empty comment — the rationale is fine for the audit log but
      // not as a public reply.
      return {
        kind: "escalate",
        reason: "reply category chosen but reply text missing",
      };
    }
    return { kind: "reply", text, rationale: judgement.rationale };
  }
  // apply-* path
  if (judgement.validity === "invalid") {
    // Self-correct: applying a fix for a claim we judged invalid would
    // be incoherent. Either the judge wrongly picked apply-, or the
    // judge wrongly picked invalid; either way escalate so a human can
    // look at the mismatch.
    return {
      kind: "escalate",
      reason: "category=apply but validity=invalid — refusing to act",
    };
  }
  if (judgement.validity === "unsure") {
    return { kind: "escalate", reason: "validity=unsure on an apply-category" };
  }
  const tier: FixTier =
    judgement.category === "apply-trivial"
      ? "trivial"
      : judgement.category === "apply-targeted"
        ? "targeted"
        : "architectural";
  return { kind: "fix", tier, rationale: judgement.rationale };
}
