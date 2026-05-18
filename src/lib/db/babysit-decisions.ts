/**
 * Append-only audit trail of every judge decision the babysit loop makes.
 * One row per (job, comment) judgment pass; if a comment is re-judged after
 * a fix attempt, that gets its own row — letting us count attempts per
 * comment via `getAttemptCount` (the per-comment circuit breaker).
 *
 * The decision row is created in two stages: judge() inserts the
 * validity/category/confidence with outcome=NULL, then the fix runner
 * stamps outcome (+ outcome_commit) when the attempt resolves. Shadow
 * judge fields stay NULL unless the N-th sample fires.
 */
import { z } from "zod";
import { getDb } from "./connection.js";

export const VALIDITY_VALUES = [
  "valid",
  "invalid",
  "partially_valid",
  "unsure",
] as const;

export const CATEGORY_VALUES = [
  "apply-trivial",
  "apply-targeted",
  "apply-architectural",
  "reply-disagree",
  "reply-ack",
  "defer-to-human",
] as const;

export const OUTCOME_VALUES = [
  "fixed",
  "replied",
  "verify_failed",
  "escalated",
] as const;

export type Validity = (typeof VALIDITY_VALUES)[number];
export type Category = (typeof CATEGORY_VALUES)[number];
export type Outcome = (typeof OUTCOME_VALUES)[number];

const BabysitDecisionSchema = z.object({
  id: z.number().int(),
  job_id: z.string(),
  decided_at: z.number().int(),
  comment_id: z.number().int(),
  comment_author: z.string(),
  comment_hash: z.string(),
  bot: z.string().nullable(),
  validity: z.enum(VALIDITY_VALUES),
  category: z.enum(CATEGORY_VALUES),
  confidence: z.number(),
  judge_model: z.string(),
  shadow_judge_model: z.string().nullable(),
  shadow_validity: z.enum(VALIDITY_VALUES).nullable(),
  shadow_disagreed: z.coerce.boolean().default(false),
  fix_model: z.string().nullable(),
  outcome: z.enum(OUTCOME_VALUES).nullable(),
  outcome_commit: z.string().nullable(),
});

export type BabysitDecision = z.infer<typeof BabysitDecisionSchema>;

const CreateBabysitDecisionSchema = z.object({
  job_id: z.string(),
  comment_id: z.number().int(),
  comment_author: z.string(),
  comment_hash: z.string().length(64),
  bot: z.string().nullable().optional(),
  validity: z.enum(VALIDITY_VALUES),
  category: z.enum(CATEGORY_VALUES),
  confidence: z.number().min(0).max(1),
  judge_model: z.string(),
  shadow_judge_model: z.string().nullable().optional(),
  shadow_validity: z.enum(VALIDITY_VALUES).nullable().optional(),
  shadow_disagreed: z.boolean().optional(),
  fix_model: z.string().nullable().optional(),
});

export type CreateBabysitDecisionInput = z.infer<
  typeof CreateBabysitDecisionSchema
>;

export const babysitDecisions = {
  async create(input: CreateBabysitDecisionInput): Promise<BabysitDecision> {
    const db = await getDb();
    const v = CreateBabysitDecisionSchema.parse(input);
    const result = await db.execute({
      sql: `
        INSERT INTO babysit_decisions (
          job_id, decided_at, comment_id, comment_author, comment_hash, bot,
          validity, category, confidence, judge_model,
          shadow_judge_model, shadow_validity, shadow_disagreed, fix_model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        v.job_id,
        Date.now(),
        v.comment_id,
        v.comment_author,
        v.comment_hash,
        v.bot ?? null,
        v.validity,
        v.category,
        v.confidence,
        v.judge_model,
        v.shadow_judge_model ?? null,
        v.shadow_validity ?? null,
        v.shadow_disagreed ? 1 : 0,
        v.fix_model ?? null,
      ],
    });
    const id = Number(result.lastInsertRowid);
    const row = await babysitDecisions.getById(id);
    if (!row) throw new Error(`babysitDecisions.create: row vanished: ${id}`);
    return row;
  },

  async getById(id: number): Promise<BabysitDecision | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: "SELECT * FROM babysit_decisions WHERE id = ?",
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return BabysitDecisionSchema.parse(result.rows[0]);
  },

  async listForJob(jobId: string): Promise<BabysitDecision[]> {
    const db = await getDb();
    const result = await db.execute({
      sql: "SELECT * FROM babysit_decisions WHERE job_id = ? ORDER BY decided_at ASC, id ASC",
      args: [jobId],
    });
    return result.rows.map((r) => BabysitDecisionSchema.parse(r));
  },

  async setOutcome(
    id: number,
    outcome: Outcome,
    outcome_commit?: string | null,
  ): Promise<BabysitDecision> {
    const db = await getDb();
    await db.execute({
      sql: "UPDATE babysit_decisions SET outcome = ?, outcome_commit = ? WHERE id = ?",
      args: [outcome, outcome_commit ?? null, id],
    });
    const row = await babysitDecisions.getById(id);
    if (!row)
      throw new Error(`babysitDecisions.setOutcome: row vanished: ${id}`);
    return row;
  },

  /**
   * How many times have we already judged this comment (by content hash)
   * for this job? Drives the per-comment attempt circuit breaker — if a
   * bot keeps re-flagging the same issue after our fix, we eventually
   * stop trying and escalate.
   */
  async getAttemptCount(jobId: string, commentHash: string): Promise<number> {
    const db = await getDb();
    const result = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM babysit_decisions WHERE job_id = ? AND comment_hash = ?",
      args: [jobId, commentHash],
    });
    const row = result.rows[0] as unknown as { n: number };
    return Number(row.n);
  },
};
