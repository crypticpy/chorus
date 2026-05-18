/**
 * One row per PR being babysat. ID is the canonical "<owner>/<repo>#<number>"
 * so callers (webhook receiver, MCP tool, CLI) can address a job without
 * a prior SELECT. The (repo, pr_number) UNIQUE constraint prevents two
 * concurrent registrations of the same PR.
 *
 * See docs/pr-babysit-design.md for the state machine the daemon walks
 * each job through. This module is just persistence — no orchestration.
 */
import { z } from "zod";
import { getDb } from "./connection.js";

export const BABYSIT_STATES = [
  "idle",
  "judging",
  "fixing",
  "verifying",
  "pushing",
  "waiting",
  "quiet_check",
  "escalated",
  "merged",
  "paused",
] as const;

export type BabysitState = (typeof BABYSIT_STATES)[number];

const BabysitJobSchema = z.object({
  id: z.string(),
  repo: z.string(),
  pr_number: z.number().int(),
  installation_id: z.number().int().nullable(),
  state: z.enum(BABYSIT_STATES),
  worktree_path: z.string().nullable(),
  started_at: z.number().int(),
  updated_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  fix_commits: z.number().int().default(0),
  total_judge_calls: z.number().int().default(0),
  total_fix_calls: z.number().int().default(0),
  total_tokens_in: z.number().int().default(0),
  total_tokens_out: z.number().int().default(0),
  escalation_reason: z.string().nullable(),
});

export type BabysitJob = z.infer<typeof BabysitJobSchema>;

const CreateBabysitJobSchema = z.object({
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  installation_id: z.number().int().nullable().optional(),
  worktree_path: z.string().optional(),
});

export type CreateBabysitJobInput = z.infer<typeof CreateBabysitJobSchema>;

function buildJobId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

export const babysitJobs = {
  id: buildJobId,

  async create(input: CreateBabysitJobInput): Promise<BabysitJob> {
    const db = await getDb();
    const validated = CreateBabysitJobSchema.parse(input);
    const id = buildJobId(validated.repo, validated.pr_number);
    const now = Date.now();

    await db.execute({
      sql: `
        INSERT INTO babysit_jobs (
          id, repo, pr_number, installation_id, state, worktree_path,
          started_at, updated_at
        ) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)
      `,
      args: [
        id,
        validated.repo,
        validated.pr_number,
        validated.installation_id ?? null,
        validated.worktree_path ?? null,
        now,
        now,
      ],
    });

    const row = await babysitJobs.getById(id);
    if (!row) throw new Error(`babysitJobs.create: row vanished: ${id}`);
    return row;
  },

  async getById(id: string): Promise<BabysitJob | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: "SELECT * FROM babysit_jobs WHERE id = ?",
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return BabysitJobSchema.parse(result.rows[0]);
  },

  async getByPr(repo: string, prNumber: number): Promise<BabysitJob | null> {
    return babysitJobs.getById(buildJobId(repo, prNumber));
  },

  async list(filter?: { state?: BabysitState }): Promise<BabysitJob[]> {
    const db = await getDb();
    const result = filter?.state
      ? await db.execute({
          sql: "SELECT * FROM babysit_jobs WHERE state = ? ORDER BY updated_at DESC",
          args: [filter.state],
        })
      : await db.execute("SELECT * FROM babysit_jobs ORDER BY updated_at DESC");
    return result.rows.map((r) => BabysitJobSchema.parse(r));
  },

  async listActive(): Promise<BabysitJob[]> {
    const db = await getDb();
    const result = await db.execute(
      "SELECT * FROM babysit_jobs WHERE ended_at IS NULL ORDER BY updated_at DESC",
    );
    return result.rows.map((r) => BabysitJobSchema.parse(r));
  },

  async setState(
    id: string,
    state: BabysitState,
    extras?: {
      escalation_reason?: string | null;
      worktree_path?: string | null;
      ended_at?: number | null;
    },
  ): Promise<BabysitJob> {
    const db = await getDb();
    const existing = await babysitJobs.getById(id);
    if (!existing) throw new Error(`babysitJobs.setState: not found: ${id}`);
    const now = Date.now();
    const terminalStates: BabysitState[] = ["merged", "escalated"];
    // ended_at is sticky once set — only auto-stamp on first transition into
    // a terminal state. Callers can override via extras.ended_at if they
    // need to re-open a previously-ended job (e.g. resume after pause).
    const endedAt =
      extras && "ended_at" in extras
        ? (extras.ended_at ?? null)
        : terminalStates.includes(state) && existing.ended_at === null
          ? now
          : existing.ended_at;

    await db.execute({
      sql: `
        UPDATE babysit_jobs
        SET state = ?,
            updated_at = ?,
            ended_at = ?,
            escalation_reason = COALESCE(?, escalation_reason),
            worktree_path = COALESCE(?, worktree_path)
        WHERE id = ?
      `,
      args: [
        state,
        now,
        endedAt,
        extras?.escalation_reason ?? null,
        extras?.worktree_path ?? null,
        id,
      ],
    });

    const row = await babysitJobs.getById(id);
    if (!row) throw new Error(`babysitJobs.setState: row vanished: ${id}`);
    return row;
  },

  async incrementCounters(
    id: string,
    delta: {
      fix_commits?: number;
      total_judge_calls?: number;
      total_fix_calls?: number;
      total_tokens_in?: number;
      total_tokens_out?: number;
    },
  ): Promise<BabysitJob> {
    const db = await getDb();
    const now = Date.now();
    await db.execute({
      sql: `
        UPDATE babysit_jobs SET
          fix_commits        = fix_commits        + ?,
          total_judge_calls  = total_judge_calls  + ?,
          total_fix_calls    = total_fix_calls    + ?,
          total_tokens_in    = total_tokens_in    + ?,
          total_tokens_out   = total_tokens_out   + ?,
          updated_at         = ?
        WHERE id = ?
      `,
      args: [
        delta.fix_commits ?? 0,
        delta.total_judge_calls ?? 0,
        delta.total_fix_calls ?? 0,
        delta.total_tokens_in ?? 0,
        delta.total_tokens_out ?? 0,
        now,
        id,
      ],
    });
    const row = await babysitJobs.getById(id);
    if (!row)
      throw new Error(`babysitJobs.incrementCounters: row vanished: ${id}`);
    return row;
  },
};
