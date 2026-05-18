/**
 * Stage → commit → push helper for the babysit fix loop.
 *
 * Three operations the runner performs after a fix executor has
 * dropped edits into the worktree:
 *
 *   1. `git add -A` to stage everything the doer touched.
 *   2. `git commit -m <message>` with babysit identity. If the doer
 *      left no actual changes (idempotent rewrite of the same
 *      contents), git refuses with exit code 1 — we treat that as a
 *      `no_changes` outcome, not a failure.
 *   3. `git push origin HEAD:<branch>` against whatever credentials
 *      git has configured. For App-auth pushes the daemon host must
 *      have `gh auth setup-git` (or equivalent credential helper)
 *      configured — we do NOT yet inject the installation token
 *      into git's credential helper from here; that's a future
 *      hardening item.
 *
 * Identity: we set `user.name` + `user.email` per-call (via -c flags
 * so we don't mutate the worktree's git config). Defaults the bot
 * identity ("chorus-babysit <noreply@chorus.dev>") unless the caller
 * overrides — useful when a configured GitHub App provides its own
 * "chorus-babysit[bot]" account.
 *
 * The push step does NOT use --force. If GitHub refuses because
 * someone landed a separate commit on the PR head, the runner's next
 * tick will pullLatest() and re-attempt — never silently overwrite
 * concurrent work.
 */
import { runAsync } from "../ship.js";

export interface CommitAndPushArgs {
  worktreePath: string;
  branch: string;
  commitMessage: string;
  /** Optional override. Default "chorus-babysit". */
  authorName?: string;
  /** Optional override. Default "noreply@chorus.dev". */
  authorEmail?: string;
  /** Per-step timeout. Defaults: stage 15s, commit 15s, push 60s. */
  timeoutMs?: {
    stage?: number;
    commit?: number;
    push?: number;
  };
}

export type CommitAndPushResult =
  | {
      ok: true;
      outcome: "pushed";
      commitSha: string;
    }
  | {
      ok: true;
      outcome: "no_changes";
    }
  | {
      ok: false;
      reason: "stage_failure" | "commit_failure" | "push_failure";
      detail: string;
    };

const DEFAULT_AUTHOR_NAME = "chorus-babysit";
const DEFAULT_AUTHOR_EMAIL = "noreply@chorus.dev";

export async function commitAndPush(
  args: CommitAndPushArgs,
): Promise<CommitAndPushResult> {
  const stage = await runAsync("git", ["add", "-A"], {
    cwd: args.worktreePath,
    timeoutMs: args.timeoutMs?.stage ?? 15_000,
  });
  if (!stage.ok) {
    return {
      ok: false,
      reason: "stage_failure",
      detail: stage.stderr.trim(),
    };
  }

  // Detect no-op early — `git diff --cached --quiet` exits 0 if there
  // are no staged changes. Avoids relying on parsing `git commit`'s
  // exit-code-1 "nothing to commit" path, which has changed wording
  // across git versions.
  const diffCheck = await runAsync("git", ["diff", "--cached", "--quiet"], {
    cwd: args.worktreePath,
    timeoutMs: 5_000,
  });
  if (diffCheck.ok) {
    // ok=true means exit code 0 means no staged diff.
    return { ok: true, outcome: "no_changes" };
  }

  const name = args.authorName ?? DEFAULT_AUTHOR_NAME;
  const email = args.authorEmail ?? DEFAULT_AUTHOR_EMAIL;
  const commit = await runAsync(
    "git",
    [
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-m",
      args.commitMessage,
    ],
    {
      cwd: args.worktreePath,
      timeoutMs: args.timeoutMs?.commit ?? 15_000,
    },
  );
  if (!commit.ok) {
    return {
      ok: false,
      reason: "commit_failure",
      detail: commit.stderr.trim() || commit.stdout.trim(),
    };
  }

  const sha = await runAsync("git", ["rev-parse", "HEAD"], {
    cwd: args.worktreePath,
    timeoutMs: 5_000,
  });
  const commitSha = sha.ok ? sha.stdout.trim() : "";

  const push = await runAsync(
    "git",
    ["push", "origin", `HEAD:${args.branch}`],
    {
      cwd: args.worktreePath,
      timeoutMs: args.timeoutMs?.push ?? 60_000,
    },
  );
  if (!push.ok) {
    return {
      ok: false,
      reason: "push_failure",
      detail: push.stderr.trim() || push.stdout.trim(),
    };
  }

  return { ok: true, outcome: "pushed", commitSha };
}
