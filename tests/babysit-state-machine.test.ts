/**
 * Tests for the babysit state-machine driver (runJob).
 *
 * Strategy: real DB, mocked external IO (gh CLI, model invocations,
 * git shellouts). We assert the state transition the driver writes
 * back to babysit_jobs given a specific input state + IO outcome.
 *
 * What we cover:
 *   - idle → judging on successful worktree setup
 *   - idle → escalated on metadata failure
 *   - judging → quiet_check when no new bot comments
 *   - judging → fixing when a comment routes to apply-trivial
 *   - judging → escalated when judge says defer-to-human
 *   - verifying → escalated when verify fails (no retry)
 *   - quiet_check → merged when PR is merged on GitHub
 *   - quiet_check → judging when new bot comments arrive
 *   - terminal states are no-ops
 *
 * We don't unit-test the per-handler internals exhaustively — those
 * have their own focused tests (verifier, fix-executor, etc).
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDbForTests,
  babysitDecisions,
  babysitJobs,
  getDb,
} from "../src/lib/db";
import { runJob } from "../src/daemon/babysit/state-machine";
import * as ghClient from "../src/daemon/babysit/gh-client";
import * as commentFetcher from "../src/daemon/babysit/comment-fetcher";
import * as worktreeManager from "../src/daemon/babysit/worktree-manager";
import * as prMetadata from "../src/daemon/babysit/pr-metadata";
import * as judge from "../src/daemon/babysit/judge";
import * as fixExecutor from "../src/daemon/babysit/fix-executor";
import * as verifier from "../src/daemon/babysit/verifier";
import * as gitPush from "../src/daemon/babysit/git-push";

let dbPath: string;
let tmpRoot: string;

const DEFAULT_DEPS = {
  sourceRepoPath: "/tmp/fake-repo",
  doerLineage: "anthropic",
  doerModel: "claude-haiku-4-5",
};

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-sm-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-sm-wt-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await _resetDbForTests();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort */
    }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  delete process.env.CHORUS_DB_PATH;
});

function stubMetadata(over: Partial<prMetadata.PrMetadata> = {}) {
  return vi.spyOn(prMetadata, "fetchPrMetadata").mockResolvedValue({
    ok: true,
    meta: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      title: "Fix the counter",
      headBranch: "feature/x",
      baseBranch: "main",
      defaultBranch: "main",
      state: "open",
      ...over,
    },
  });
}

describe("runJob — idle handler", () => {
  it("provisions a worktree and transitions to judging", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    stubMetadata();
    vi.spyOn(worktreeManager, "ensureWorktree").mockResolvedValue({
      ok: true,
      worktreePath: tmpRoot,
      created: true,
    });

    await runJob(job, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("judging");
    expect(after?.worktree_path).toBe(tmpRoot);
  });

  it("escalates when metadata fetch fails", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    vi.spyOn(prMetadata, "fetchPrMetadata").mockResolvedValue({
      ok: false,
      reason: "pr_not_found",
      detail: "PR 1 not found",
    });

    await runJob(job, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
    expect(after?.escalation_reason).toContain("metadata fetch failed");
  });

  it("escalates when worktree setup fails", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    stubMetadata();
    vi.spyOn(worktreeManager, "ensureWorktree").mockResolvedValue({
      ok: false,
      reason: "git_failure",
      detail: "branch not on remote",
    });

    await runJob(job, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
    expect(after?.escalation_reason).toContain("worktree setup failed");
  });
});

describe("runJob — judging handler", () => {
  it("transitions to quiet_check when no unjudged bot comments exist", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [], // empty PR
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("quiet_check");
  });

  it("transitions to fixing when a bot comment routes to apply-trivial", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 99,
          kind: "review",
          authorLogin: "coderabbitai[bot]",
          isBot: true,
          bot: "coderabbit",
          body: "this is an off-by-one",
          bodyHash: "f".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: "src/foo.ts",
          line: 12,
          htmlUrl: "https://github.com/o/r/pull/1#discussion_r99",
        },
      ],
    });
    vi.spyOn(judge, "judgeComment").mockResolvedValue({
      ok: true,
      judgement: {
        validity: "valid",
        category: "apply-trivial",
        confidence: 0.9,
        rationale: "real bug",
      },
      modelUsed: "claude-haiku-4-5",
      belowThreshold: false,
      rawText: "...",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("fixing");

    const decisions = await babysitDecisions.listForJob(job.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.category).toBe("apply-trivial");
  });

  it("escalates when the judge says defer-to-human", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 100,
          kind: "issue",
          authorLogin: "sourcery-ai[bot]",
          isBot: true,
          bot: "sourcery",
          body: "consider a major refactor here",
          bodyHash: "e".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: null,
          line: null,
          htmlUrl: "",
        },
      ],
    });
    vi.spyOn(judge, "judgeComment").mockResolvedValue({
      ok: true,
      judgement: {
        validity: "valid",
        category: "defer-to-human",
        confidence: 0.9,
        rationale: "too big for the loop",
      },
      modelUsed: "claude-haiku-4-5",
      belowThreshold: false,
      rawText: "...",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
  });

  it("transitions immediately to merged when PR was merged on GitHub", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata({ state: "merged" });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("merged");
  });

  it("ignores human comments — only bot reviewers feed the loop", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 50,
          kind: "issue",
          authorLogin: "human-dev",
          isBot: false,
          bot: null,
          body: "lgtm",
          bodyHash: "1".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: null,
          line: null,
          htmlUrl: "",
        },
      ],
    });
    const judgeSpy = vi.spyOn(judge, "judgeComment");

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    expect(judgeSpy).not.toHaveBeenCalled();
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("quiet_check");
  });
});

describe("runJob — verifying handler", () => {
  it("escalates on verify failure (no auto-retry)", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "verifying", {
      worktree_path: tmpRoot,
    });

    vi.spyOn(verifier, "runVerify").mockResolvedValue({
      ok: false,
      mode: "npm-test",
      output: "Tests failed: assertion mismatch",
      exitCode: 1,
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
    expect(after?.escalation_reason).toContain("verify failed");
    expect(after?.escalation_reason).toContain("assertion mismatch");
  });

  it("transitions to pushing on verify pass", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "verifying", {
      worktree_path: tmpRoot,
    });

    vi.spyOn(verifier, "runVerify").mockResolvedValue({
      ok: true,
      mode: "npm-test",
      output: "OK",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("pushing");
  });
});

describe("runJob — quiet_check handler", () => {
  it("transitions to merged when PR is merged on GitHub", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "quiet_check", {
      worktree_path: tmpRoot,
    });

    stubMetadata({ state: "merged" });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("merged");
  });

  it("re-enters judging when new bot comments arrive", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "quiet_check", {
      worktree_path: tmpRoot,
    });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 200,
          kind: "review",
          authorLogin: "coderabbitai[bot]",
          isBot: true,
          bot: "coderabbit",
          body: "another bug here",
          bodyHash: "b".repeat(64),
          createdAt: "2026-05-17T20:00:00Z",
          path: "src/a.ts",
          line: 1,
          htmlUrl: "",
        },
      ],
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("judging");
  });

  it("stays in quiet_check when nothing new", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "quiet_check", {
      worktree_path: tmpRoot,
    });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [],
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("quiet_check");
  });
});

describe("runJob — terminal states", () => {
  it("is a no-op for state=merged", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "merged");

    const fetchSpy = vi.spyOn(commentFetcher, "fetchPrComments");
    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("merged");
  });

  it("is a no-op for state=escalated", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "escalated");

    const fetchSpy = vi.spyOn(commentFetcher, "fetchPrComments");
    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
  });
});

describe("runJob — fixing → verifying", () => {
  it("invokes the doer and transitions to verifying on success", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "fixing", { worktree_path: tmpRoot });
    // Plant a pending fix decision so handleFixing has something to act on.
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 99,
      comment_author: "coderabbitai[bot]",
      comment_hash: "c".repeat(64),
      bot: "coderabbit",
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.9,
      judge_model: "claude-haiku-4-5",
    });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 99,
          kind: "review",
          authorLogin: "coderabbitai[bot]",
          isBot: true,
          bot: "coderabbit",
          body: "this is an off-by-one",
          bodyHash: "c".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: "src/foo.ts",
          line: 12,
          htmlUrl: "",
        },
      ],
    });
    vi.spyOn(fixExecutor, "applyFixForComment").mockResolvedValue({
      ok: true,
      filesChanged: ["src/foo.ts"],
      commitMessage: "fix: off-by-one",
      notes: null,
      rawText: "...",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("verifying");
    expect(after?.total_fix_calls).toBe(1);
  });

  it("escalates when the doer fails", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "fixing", { worktree_path: tmpRoot });
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 99,
      comment_author: "coderabbitai[bot]",
      comment_hash: "d".repeat(64),
      bot: "coderabbit",
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.9,
      judge_model: "claude-haiku-4-5",
    });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 99,
          kind: "review",
          authorLogin: "coderabbitai[bot]",
          isBot: true,
          bot: "coderabbit",
          body: "this is an off-by-one",
          bodyHash: "d".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: "src/foo.ts",
          line: 12,
          htmlUrl: "",
        },
      ],
    });
    vi.spyOn(fixExecutor, "applyFixForComment").mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      detail: "model returned malformed plan",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
    expect(after?.escalation_reason).toContain("doer failed");

    const decisions = await babysitDecisions.listForJob(job.id);
    expect(decisions[0]!.outcome).toBe("escalated");
  });
});

describe("runJob — pushing handler", () => {
  it("pushes and transitions to quiet_check on success", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "pushing", { worktree_path: tmpRoot });
    const dec = await babysitDecisions.create({
      job_id: job.id,
      comment_id: 1,
      comment_author: "coderabbitai[bot]",
      comment_hash: "9".repeat(64),
      bot: "coderabbit",
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.9,
      judge_model: "claude-haiku-4-5",
    });

    stubMetadata();
    vi.spyOn(gitPush, "commitAndPush").mockResolvedValue({
      ok: true,
      outcome: "pushed",
      commitSha: "abc123def456abc123def456abc123def456abcd",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("quiet_check");
    expect(after?.fix_commits).toBe(1);

    const updated = (await babysitDecisions.getById(dec.id))!;
    expect(updated.outcome).toBe("fixed");
    expect(updated.outcome_commit).toBe(
      "abc123def456abc123def456abc123def456abcd",
    );
  });

  it("escalates on push failure", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "pushing", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(gitPush, "commitAndPush").mockResolvedValue({
      ok: false,
      reason: "push_failure",
      detail: "remote rejected",
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("escalated");
    expect(after?.escalation_reason).toContain("push_failure");
  });
});

describe("runJob — reply path", () => {
  it("posts a reply via ghRequest and transitions to quiet_check", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "judging", { worktree_path: tmpRoot });

    stubMetadata();
    vi.spyOn(commentFetcher, "fetchPrComments").mockResolvedValue({
      ok: true,
      comments: [
        {
          id: 77,
          kind: "issue",
          authorLogin: "coderabbitai[bot]",
          isBot: true,
          bot: "coderabbit",
          body: "nice work",
          bodyHash: "7".repeat(64),
          createdAt: "2026-05-17T19:00:00Z",
          path: null,
          line: null,
          htmlUrl: "",
        },
      ],
    });
    vi.spyOn(judge, "judgeComment").mockResolvedValue({
      ok: true,
      judgement: {
        validity: "valid",
        category: "reply-ack",
        confidence: 0.95,
        rationale: "ack the praise",
        reply: "Thanks!",
      },
      modelUsed: "claude-haiku-4-5",
      belowThreshold: false,
      rawText: "...",
    });
    const ghSpy = vi.spyOn(ghClient, "ghRequest").mockResolvedValue({
      ok: true,
      authMode: "cli",
      status: 201,
      body: { id: 1 },
    });

    const refreshed = (await babysitJobs.getById(job.id))!;
    await runJob(refreshed, DEFAULT_DEPS);
    expect(ghSpy).toHaveBeenCalled();
    const call = ghSpy.mock.calls.find((c) => c[0].method === "POST");
    expect(call).toBeTruthy();
    expect(call?.[0].path).toContain("/issues/1/comments");
    const after = await babysitJobs.getById(job.id);
    expect(after?.state).toBe("quiet_check");
  });
});
