/**
 * DB regression tests for the PR-babysit job + decision tables.
 *
 * Each test gets a fresh temp DB; the schema is loaded via getDb() so the
 * idempotent CREATE TABLE IF NOT EXISTS migrations in connection.ts are
 * exercised end-to-end (catches drift between schema.sql and connection.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

import {
  _resetDbForTests,
  babysitDecisions,
  babysitJobs,
  getDb,
} from "@/lib/db";

let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-babysit-test-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
});

afterEach(async () => {
  await _resetDbForTests();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort */
    }
  }
  delete process.env.CHORUS_DB_PATH;
});

describe("schema migration", () => {
  it("creates babysit_jobs + babysit_decisions tables on fresh DB", async () => {
    const db = await getDb();
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = result.rows.map((r) => r.name as string);
    expect(names).toContain("babysit_jobs");
    expect(names).toContain("babysit_decisions");
  });
});

describe("babysitJobs.create", () => {
  it("inserts a new job with default counters + idle state", async () => {
    const job = await babysitJobs.create({
      repo: "anthropics/claude-code",
      pr_number: 1234,
      installation_id: 99,
    });
    expect(job.id).toBe("anthropics/claude-code#1234");
    expect(job.state).toBe("idle");
    expect(job.fix_commits).toBe(0);
    expect(job.total_judge_calls).toBe(0);
    expect(job.ended_at).toBeNull();
    expect(job.installation_id).toBe(99);
  });

  it("accepts a null installation_id (gh-CLI-only mode)", async () => {
    const job = await babysitJobs.create({
      repo: "foo/bar",
      pr_number: 7,
      installation_id: null,
    });
    expect(job.installation_id).toBeNull();
  });

  it("rejects duplicate (repo, pr_number) via UNIQUE constraint", async () => {
    await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await expect(
      babysitJobs.create({ repo: "foo/bar", pr_number: 1 }),
    ).rejects.toThrow();
  });
});

describe("babysitJobs.getById / getByPr", () => {
  it("returns null for an unknown job", async () => {
    expect(await babysitJobs.getById("missing#1")).toBeNull();
    expect(await babysitJobs.getByPr("foo/bar", 99)).toBeNull();
  });

  it("getByPr resolves via the same canonical id", async () => {
    const created = await babysitJobs.create({ repo: "foo/bar", pr_number: 5 });
    const fetched = await babysitJobs.getByPr("foo/bar", 5);
    expect(fetched?.id).toBe(created.id);
  });
});

describe("babysitJobs.setState", () => {
  it("transitions through non-terminal states without stamping ended_at", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const judging = await babysitJobs.setState(job.id, "judging");
    expect(judging.state).toBe("judging");
    expect(judging.ended_at).toBeNull();
    const fixing = await babysitJobs.setState(job.id, "fixing");
    expect(fixing.ended_at).toBeNull();
  });

  it("auto-stamps ended_at on transition to merged", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const merged = await babysitJobs.setState(job.id, "merged");
    expect(merged.state).toBe("merged");
    expect(merged.ended_at).not.toBeNull();
  });

  it("auto-stamps ended_at on transition to escalated, persists reason", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const escalated = await babysitJobs.setState(job.id, "escalated", {
      escalation_reason: "fix_commits cap exceeded",
    });
    expect(escalated.state).toBe("escalated");
    expect(escalated.ended_at).not.toBeNull();
    expect(escalated.escalation_reason).toBe("fix_commits cap exceeded");
  });

  it("does not re-stamp ended_at on subsequent terminal transitions", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const merged = await babysitJobs.setState(job.id, "merged");
    const firstEndedAt = merged.ended_at;
    // Pause + resume cycle wouldn't go via merged again, but if it did the
    // first ended_at should win — this is the "sticky" invariant.
    await new Promise((r) => setTimeout(r, 5));
    const merged2 = await babysitJobs.setState(job.id, "merged");
    expect(merged2.ended_at).toBe(firstEndedAt);
  });

  it("allows callers to explicitly clear ended_at (resume after pause)", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await babysitJobs.setState(job.id, "merged");
    const reopened = await babysitJobs.setState(job.id, "judging", {
      ended_at: null,
    });
    expect(reopened.ended_at).toBeNull();
  });

  it("updates worktree_path when supplied", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const next = await babysitJobs.setState(job.id, "fixing", {
      worktree_path: "/tmp/wt/foo-bar-1",
    });
    expect(next.worktree_path).toBe("/tmp/wt/foo-bar-1");
  });

  it("throws when job does not exist", async () => {
    await expect(babysitJobs.setState("missing#1", "judging")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("babysitJobs.incrementCounters", () => {
  it("adds deltas to existing counters", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await babysitJobs.incrementCounters(job.id, {
      total_judge_calls: 3,
      total_tokens_in: 1500,
      total_tokens_out: 200,
    });
    const after = await babysitJobs.incrementCounters(job.id, {
      total_judge_calls: 2,
      fix_commits: 1,
    });
    expect(after.total_judge_calls).toBe(5);
    expect(after.fix_commits).toBe(1);
    expect(after.total_tokens_in).toBe(1500);
    expect(after.total_tokens_out).toBe(200);
  });
});

describe("babysitJobs.list / listActive", () => {
  it("listActive returns only jobs with no ended_at", async () => {
    const a = await babysitJobs.create({ repo: "foo/a", pr_number: 1 });
    const b = await babysitJobs.create({ repo: "foo/b", pr_number: 2 });
    await babysitJobs.create({ repo: "foo/c", pr_number: 3 });
    await babysitJobs.setState(a.id, "merged");
    await babysitJobs.setState(b.id, "escalated", {
      escalation_reason: "cap",
    });
    const active = await babysitJobs.listActive();
    expect(active.map((j) => j.id)).toEqual(["foo/c#3"]);
  });

  it("list filters by state", async () => {
    const a = await babysitJobs.create({ repo: "foo/a", pr_number: 1 });
    await babysitJobs.create({ repo: "foo/b", pr_number: 2 });
    await babysitJobs.setState(a.id, "judging");
    const judging = await babysitJobs.list({ state: "judging" });
    expect(judging).toHaveLength(1);
    expect(judging[0].id).toBe(a.id);
  });
});

describe("babysitDecisions.create", () => {
  it("inserts with outcome=NULL and shadow_disagreed=false by default", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const d = await babysitDecisions.create({
      job_id: job.id,
      comment_id: 9001,
      comment_author: "coderabbitai[bot]",
      comment_hash: "a".repeat(64),
      bot: "coderabbit",
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.92,
      judge_model: "claude-haiku-4-5",
    });
    expect(d.outcome).toBeNull();
    expect(d.outcome_commit).toBeNull();
    expect(d.shadow_disagreed).toBe(false);
    expect(d.bot).toBe("coderabbit");
  });

  it("rejects invalid validity", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await expect(
      babysitDecisions.create({
        job_id: job.id,
        comment_id: 1,
        comment_author: "u",
        comment_hash: "a".repeat(64),
        // @ts-expect-error — runtime check
        validity: "maybe",
        category: "apply-trivial",
        confidence: 0.5,
        judge_model: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects confidence outside [0,1]", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await expect(
      babysitDecisions.create({
        job_id: job.id,
        comment_id: 1,
        comment_author: "u",
        comment_hash: "a".repeat(64),
        validity: "valid",
        category: "apply-trivial",
        confidence: 1.5,
        judge_model: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects non-64-char comment_hash (forces sha256)", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    await expect(
      babysitDecisions.create({
        job_id: job.id,
        comment_id: 1,
        comment_author: "u",
        comment_hash: "short",
        validity: "valid",
        category: "apply-trivial",
        confidence: 0.5,
        judge_model: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("babysitDecisions.setOutcome", () => {
  it("stamps outcome + commit and returns the updated row", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const d = await babysitDecisions.create({
      job_id: job.id,
      comment_id: 1,
      comment_author: "coderabbitai[bot]",
      comment_hash: "b".repeat(64),
      validity: "valid",
      category: "apply-targeted",
      confidence: 0.8,
      judge_model: "claude-sonnet-4-6",
    });
    const updated = await babysitDecisions.setOutcome(d.id, "fixed", "abc1234");
    expect(updated.outcome).toBe("fixed");
    expect(updated.outcome_commit).toBe("abc1234");
  });

  it("accepts outcome with no commit (e.g. replied)", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const d = await babysitDecisions.create({
      job_id: job.id,
      comment_id: 2,
      comment_author: "sourcery-ai[bot]",
      comment_hash: "c".repeat(64),
      validity: "invalid",
      category: "reply-disagree",
      confidence: 0.95,
      judge_model: "claude-sonnet-4-6",
    });
    const updated = await babysitDecisions.setOutcome(d.id, "replied");
    expect(updated.outcome).toBe("replied");
    expect(updated.outcome_commit).toBeNull();
  });
});

describe("babysitDecisions.getAttemptCount", () => {
  it("counts decisions matching (job, comment_hash)", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    const hash = "d".repeat(64);
    expect(await babysitDecisions.getAttemptCount(job.id, hash)).toBe(0);
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 1,
      comment_author: "x",
      comment_hash: hash,
      validity: "valid",
      category: "apply-targeted",
      confidence: 0.7,
      judge_model: "m",
    });
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 1,
      comment_author: "x",
      comment_hash: hash,
      validity: "valid",
      category: "apply-targeted",
      confidence: 0.7,
      judge_model: "m",
    });
    expect(await babysitDecisions.getAttemptCount(job.id, hash)).toBe(2);
  });

  it("does not cross job boundaries", async () => {
    const a = await babysitJobs.create({ repo: "foo/a", pr_number: 1 });
    const b = await babysitJobs.create({ repo: "foo/b", pr_number: 1 });
    const hash = "e".repeat(64);
    await babysitDecisions.create({
      job_id: a.id,
      comment_id: 1,
      comment_author: "x",
      comment_hash: hash,
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.9,
      judge_model: "m",
    });
    expect(await babysitDecisions.getAttemptCount(b.id, hash)).toBe(0);
  });
});

describe("babysitDecisions.listForJob", () => {
  it("returns decisions ordered by decided_at then id", async () => {
    const job = await babysitJobs.create({ repo: "foo/bar", pr_number: 1 });
    for (let i = 0; i < 3; i++) {
      await babysitDecisions.create({
        job_id: job.id,
        comment_id: i + 1,
        comment_author: "x",
        comment_hash: String.fromCharCode(97 + i).repeat(64),
        validity: "valid",
        category: "apply-trivial",
        confidence: 0.9,
        judge_model: "m",
      });
    }
    const rows = await babysitDecisions.listForJob(job.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.comment_id)).toEqual([1, 2, 3]);
  });
});
