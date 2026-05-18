/**
 * Tests for commitAndPush. Uses a real local bare remote + working
 * clone so we exercise the actual git CLI behaviour (the helper is
 * mostly shellouts; mocking runAsync would make the tests vacuous).
 *
 * Scenarios covered:
 *   - happy path: staged changes → commit → push (outcome=pushed)
 *   - no changes after stage → outcome=no_changes, no commit
 *   - push failure (e.g. remote rejected) → reason=push_failure
 *   - default identity ("chorus-babysit") used unless overridden
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { commitAndPush } from "../src/daemon/babysit/git-push";

let tmp: string;
let remote: string;
let worktree: string;

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-push-"));
  remote = path.join(tmp, "remote.git");
  worktree = path.join(tmp, "wt");

  fs.mkdirSync(remote);
  git("init --bare --initial-branch=main", remote);

  fs.mkdirSync(worktree);
  git("init --initial-branch=main", worktree);
  git("config user.email seed@example.com", worktree);
  git("config user.name Seed", worktree);
  git(`remote add origin ${remote}`, worktree);
  fs.writeFileSync(path.join(worktree, "README.md"), "hello\n");
  git("add .", worktree);
  git("commit -m initial", worktree);
  git("push -u origin main", worktree);

  git("checkout -b feature/x", worktree);
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("commitAndPush", () => {
  it("commits + pushes when there are staged changes", async () => {
    fs.writeFileSync(path.join(worktree, "new.txt"), "added\n");
    const res = await commitAndPush({
      worktreePath: worktree,
      branch: "feature/x",
      commitMessage: "fix: address PR comment",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("pushed");
    if (res.outcome !== "pushed") return;
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the commit landed on the remote ref.
    const log = git(
      "--git-dir=" + remote + " log --pretty=%s feature/x",
      remote,
    );
    expect(log).toContain("fix: address PR comment");
  });

  it("uses the default chorus-babysit identity unless overridden", async () => {
    fs.writeFileSync(path.join(worktree, "id-check.txt"), "x");
    const res = await commitAndPush({
      worktreePath: worktree,
      branch: "feature/x",
      commitMessage: "fix: identity",
    });
    expect(res.ok).toBe(true);

    const author = git("log -1 --pretty='%an|%ae' feature/x", worktree).trim();
    expect(author).toContain("chorus-babysit");
    expect(author).toContain("noreply@chorus.dev");
  });

  it("honors custom author identity", async () => {
    fs.writeFileSync(path.join(worktree, "id2.txt"), "y");
    await commitAndPush({
      worktreePath: worktree,
      branch: "feature/x",
      commitMessage: "fix: custom",
      authorName: "Custom Bot",
      authorEmail: "bot@example.com",
    });
    const author = git("log -1 --pretty='%an|%ae' feature/x", worktree).trim();
    expect(author).toContain("Custom Bot");
    expect(author).toContain("bot@example.com");
  });

  it("returns no_changes when there's nothing staged", async () => {
    const res = await commitAndPush({
      worktreePath: worktree,
      branch: "feature/x",
      commitMessage: "should not be created",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("no_changes");
  });

  it("reports push_failure when push is rejected (bad branch ref)", async () => {
    fs.writeFileSync(path.join(worktree, "wont-land.txt"), "x");
    // Use a refspec that the bare remote will reject — there's no
    // pre-receive hook installed by default, but pushing a clearly-
    // invalid ref name fails at the push stage.
    const res = await commitAndPush({
      worktreePath: worktree,
      branch: "refs/heads/bogus..bad",
      commitMessage: "fix: should fail to push",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("push_failure");
  });
});
