/**
 * Tests for the per-PR worktree manager. These tests use real git —
 * we create a source-repo + "remote" pair in tmp per test, push a
 * branch into the remote, and exercise the manager against the source
 * repo so `origin/<branch>` resolves.
 *
 * Two reasons for real git rather than mocking:
 *   - The manager is mostly composition of git commands; mocking
 *     runAsync would leave 90% of the surface untested.
 *   - Git's behaviour around `worktree add` / `reset --hard` is the
 *     interesting bit. Mocks would miss the actual contract.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import {
  _setWorktreeRootForTests,
  ensureWorktree,
  pullLatest,
  removeWorktree,
  validateBranchName,
  worktreePathFor,
} from "../src/daemon/babysit/worktree-manager";

let tmpRoot: string;
let remoteDir: string;
let sourceRepo: string;
let worktreeRoot: string;

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-wt-"));
  remoteDir = path.join(tmpRoot, "remote.git");
  sourceRepo = path.join(tmpRoot, "source");
  worktreeRoot = path.join(tmpRoot, "worktrees");

  // 1. Bare remote.
  fs.mkdirSync(remoteDir);
  git("init --bare --initial-branch=main", remoteDir);

  // 2. Source clone with a commit on main + a feature branch.
  fs.mkdirSync(sourceRepo);
  git("init --initial-branch=main", sourceRepo);
  git("config user.email test@example.com", sourceRepo);
  git("config user.name Test", sourceRepo);
  git(`remote add origin ${remoteDir}`, sourceRepo);
  fs.writeFileSync(path.join(sourceRepo, "README.md"), "hello\n");
  git("add .", sourceRepo);
  git("commit -m initial", sourceRepo);
  git("push -u origin main", sourceRepo);

  // 3. Create + push a PR branch.
  git("checkout -b feature/pr-42", sourceRepo);
  fs.writeFileSync(path.join(sourceRepo, "feature.txt"), "v1\n");
  git("add .", sourceRepo);
  git("commit -m feature-v1", sourceRepo);
  git("push -u origin feature/pr-42", sourceRepo);
  git("checkout main", sourceRepo);

  _setWorktreeRootForTests(worktreeRoot);
});

afterEach(() => {
  _setWorktreeRootForTests(null);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("worktreePathFor", () => {
  it("flattens owner/name to avoid nested upstream namespacing", () => {
    const p = worktreePathFor("anthropics/claude-code", 42);
    expect(p.endsWith(path.join("anthropics__claude-code", "pr-42"))).toBe(
      true,
    );
  });
});

describe("validateBranchName", () => {
  it("accepts standard branch names", () => {
    for (const b of ["main", "feature/foo", "fix/issue-123", "release-v1.2"]) {
      expect(validateBranchName(b).valid).toBe(true);
    }
  });

  it("rejects branches that start with '-'", () => {
    expect(validateBranchName("-evil").valid).toBe(false);
  });

  it("rejects branches containing shell metacharacters", () => {
    for (const b of [
      "feat;rm -rf /",
      "feat\\foo",
      "feat foo",
      "feat?",
      "feat~1",
    ]) {
      expect(validateBranchName(b).valid).toBe(false);
    }
  });

  it("rejects path-traversal sequences", () => {
    for (const b of ["../escape", "foo/../bar", "foo//bar", "foo@{1}"]) {
      expect(validateBranchName(b).valid).toBe(false);
    }
  });

  it("rejects empty / overlong branches", () => {
    expect(validateBranchName("").valid).toBe(false);
    expect(validateBranchName("x".repeat(256)).valid).toBe(false);
  });
});

describe("ensureWorktree", () => {
  it("creates a fresh worktree and checks out the PR branch", async () => {
    const res = await ensureWorktree({
      repo: "anthropics/claude-code",
      prNumber: 42,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(fs.existsSync(path.join(res.worktreePath, "feature.txt"))).toBe(
      true,
    );
    const branch = git("rev-parse --abbrev-ref HEAD", res.worktreePath).trim();
    expect(branch).toBe("feature/pr-42");
  });

  it("is idempotent — a second call reuses + returns created=false", async () => {
    const first = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    expect(first.ok).toBe(true);

    const second = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(first.ok && second.worktreePath).toBe(
      first.ok ? first.worktreePath : "",
    );
  });

  it("rebuilds when the target directory exists but isn't a valid worktree", async () => {
    const target = worktreePathFor("o/r", 7);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "stale.txt"), "leftover from a crash");

    const res = await ensureWorktree({
      repo: "o/r",
      prNumber: 7,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    // Stale file should be gone; PR head content should be present.
    expect(fs.existsSync(path.join(res.worktreePath, "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(res.worktreePath, "feature.txt"))).toBe(
      true,
    );
  });

  it("rejects an invalid branch name without touching git", async () => {
    const res = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "-deletefoo",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid_branch");
  });

  it("returns source_repo_missing when sourceRepoPath does not exist", async () => {
    const res = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: path.join(tmpRoot, "no-such-dir"),
      branch: "feature/pr-42",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("source_repo_missing");
  });

  it("surfaces git_failure when the branch isn't on the remote", async () => {
    const res = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/does-not-exist",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("git_failure");
  });
});

describe("pullLatest", () => {
  it("fast-forwards an existing worktree to the latest remote head", async () => {
    const ensure = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    expect(ensure.ok).toBe(true);
    if (!ensure.ok) return;

    // Land a new commit on the remote out-of-band. We can't use the
    // source repo because the worktree now owns the branch there;
    // clone the bare remote fresh, commit, push.
    const otherClone = path.join(tmpRoot, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    git("config user.email test@example.com", otherClone);
    git("config user.name Test", otherClone);
    git("checkout feature/pr-42", otherClone);
    fs.writeFileSync(path.join(otherClone, "feature.txt"), "v2\n");
    git("commit -am feature-v2", otherClone);
    git("push origin feature/pr-42", otherClone);

    const pull = await pullLatest({
      worktreePath: ensure.worktreePath,
      branch: "feature/pr-42",
    });
    expect(pull.ok).toBe(true);
    const content = fs.readFileSync(
      path.join(ensure.worktreePath, "feature.txt"),
      "utf-8",
    );
    expect(content).toBe("v2\n");
  });

  it("surfaces git_failure when the branch is gone from the remote", async () => {
    const ensure = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    if (!ensure.ok) throw new Error("setup failed");
    // Delete the branch on the bare remote.
    git("push origin --delete feature/pr-42", sourceRepo);

    const pull = await pullLatest({
      worktreePath: ensure.worktreePath,
      branch: "feature/pr-42",
    });
    expect(pull.ok).toBe(false);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory and prunes the git admin entry", async () => {
    const ensure = await ensureWorktree({
      repo: "o/r",
      prNumber: 1,
      sourceRepoPath: sourceRepo,
      branch: "feature/pr-42",
    });
    if (!ensure.ok) throw new Error("setup failed");

    const rm = await removeWorktree({
      worktreePath: ensure.worktreePath,
      sourceRepoPath: sourceRepo,
    });
    expect(rm.ok).toBe(true);
    if (!rm.ok) return;
    expect(rm.removed).toBe(true);
    expect(fs.existsSync(ensure.worktreePath)).toBe(false);

    // git worktree list shouldn't reference the removed path.
    const list = git("worktree list", sourceRepo);
    expect(list).not.toContain(ensure.worktreePath);
  });

  it("is idempotent — removing an already-absent worktree succeeds", async () => {
    const phantom = path.join(worktreeRoot, "nope", "pr-1");
    const rm = await removeWorktree({
      worktreePath: phantom,
      sourceRepoPath: sourceRepo,
    });
    expect(rm.ok).toBe(true);
    if (!rm.ok) return;
    expect(rm.removed).toBe(false);
  });
});
