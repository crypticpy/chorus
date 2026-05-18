/**
 * Per-PR worktree manager for the babysit fix loop.
 *
 * Every babysit job that ever needs to push a commit owns a dedicated
 * git worktree pinned to the PR's head branch. Why a worktree per job
 * instead of mutating the user's main checkout:
 *
 *   - The babysit loop runs unattended. We can't assume the operator's
 *     working tree is clean, nor can we hold its branch hostage across
 *     a multi-minute fix cycle.
 *   - Multiple PRs across different repos may be babysat concurrently.
 *     Worktrees give each one its own checkout for cheap (cost: a
 *     directory + an entry in .git/worktrees, no full clone).
 *   - On merge / escalation we want a tidy teardown — `git worktree
 *     remove` is the one-shot equivalent of `rm -rf + git prune`.
 *
 * Layout:
 *   ~/.chorus/worktrees/<repo-slug>/pr-<n>/
 *
 * `<repo-slug>` flattens "owner/name" to "owner__name" so we never
 * create nested directories that mirror upstream namespaces (which
 * would conflict if two upstreams shared a name across owners).
 *
 * Lifecycle:
 *   ensureWorktree({ repo, prNumber, sourceRepoPath, branch })
 *     -> creates / reuses the worktree, runs `git fetch + checkout`,
 *        returns the absolute path.
 *   pullLatest({ worktreePath })
 *     -> fetches the PR branch HEAD and fast-forwards. Used between
 *        iterations of the fix loop.
 *   removeWorktree({ worktreePath })
 *     -> tears down on merge / escalation. Tolerates the worktree
 *        already being absent (idempotent).
 *
 * Branch validation: the babysit registrar may receive arbitrary
 * branch names from GitHub webhook payloads. We refuse to pass any
 * branch through to git that contains shell metacharacters, leading
 * dashes, or path-traversal sequences. The validator is shared with
 * the orchestrate manifest path; see [[branch-validation]] in the
 * hardening commit (e93ce00).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAsync } from "../ship.js";

const HOME = os.homedir();
const WORKTREE_ROOT = path.join(HOME, ".chorus", "worktrees");

/** Override hook for tests — point WORKTREE_ROOT at a tmp dir. */
export function _setWorktreeRootForTests(rootOverride: string | null): void {
  // We mutate a module-local instead of recomputing on every call so the
  // production path stays a constant. The setter is intentionally only
  // exposed for tests.
  _testRoot = rootOverride;
}
let _testRoot: string | null = null;
function worktreeRoot(): string {
  return _testRoot ?? WORKTREE_ROOT;
}

export interface EnsureWorktreeArgs {
  repo: string; // "owner/name"
  prNumber: number;
  /** Absolute path to the user's primary checkout of the repo. We
   *  re-use its `.git` rather than cloning fresh — saves bandwidth +
   *  keeps the user's local refs available for diff/blame. */
  sourceRepoPath: string;
  /** Branch name of the PR head. Validated before being passed to git. */
  branch: string;
}

export type EnsureWorktreeResult =
  | { ok: true; worktreePath: string; created: boolean }
  | { ok: false; reason: EnsureFailReason; detail: string };

export type EnsureFailReason =
  | "invalid_branch"
  | "source_repo_missing"
  | "git_failure"
  | "filesystem_failure";

/**
 * Idempotent create-or-reuse. If the directory exists and `git
 * rev-parse --git-dir` succeeds inside it, we treat it as a valid
 * worktree and just fetch/checkout. Otherwise we wipe and recreate —
 * a stale directory from a previous half-failed run is more dangerous
 * than rebuilding from scratch.
 */
export async function ensureWorktree(
  args: EnsureWorktreeArgs,
): Promise<EnsureWorktreeResult> {
  const branchCheck = validateBranchName(args.branch);
  if (!branchCheck.valid) {
    return {
      ok: false,
      reason: "invalid_branch",
      detail: branchCheck.reason,
    };
  }

  if (!fs.existsSync(args.sourceRepoPath)) {
    return {
      ok: false,
      reason: "source_repo_missing",
      detail: `sourceRepoPath does not exist: ${args.sourceRepoPath}`,
    };
  }

  const target = worktreePathFor(args.repo, args.prNumber);
  let created = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: "filesystem_failure",
      detail: (err as Error).message,
    };
  }

  const alreadyValid = await isValidWorktree(target);
  if (!alreadyValid) {
    // Wipe any stale dir from a previous half-failed run.
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        return {
          ok: false,
          reason: "filesystem_failure",
          detail: `failed to remove stale worktree dir: ${(err as Error).message}`,
        };
      }
    }
    // `git worktree add -B <branch>` checks the branch out, creating
    // it locally if absent. We pair it with an upfront fetch so the
    // ref the operator hasn't yet seen still resolves.
    const fetch = await runAsync("git", ["fetch", "origin", args.branch], {
      cwd: args.sourceRepoPath,
      timeoutMs: 60_000,
    });
    if (!fetch.ok) {
      return {
        ok: false,
        reason: "git_failure",
        detail: `git fetch origin ${args.branch}: ${fetch.stderr.trim()}`,
      };
    }
    const add = await runAsync(
      "git",
      ["worktree", "add", "-B", args.branch, target, `origin/${args.branch}`],
      { cwd: args.sourceRepoPath, timeoutMs: 60_000 },
    );
    if (!add.ok) {
      return {
        ok: false,
        reason: "git_failure",
        detail: `git worktree add: ${add.stderr.trim()}`,
      };
    }
    created = true;
  } else {
    // Reusing an existing worktree — bring it up to date with the
    // PR head before the runner does anything in it.
    const pull = await pullLatest({
      worktreePath: target,
      branch: args.branch,
    });
    if (!pull.ok) return pull;
  }

  return { ok: true, worktreePath: target, created };
}

export interface PullLatestArgs {
  worktreePath: string;
  branch: string;
}

export type PullLatestResult =
  | { ok: true; worktreePath: string; created: false }
  | { ok: false; reason: "git_failure"; detail: string };

/**
 * Bring the worktree up to date with the PR head. We use
 * `git fetch + git reset --hard origin/<branch>` rather than a merge
 * or rebase because the babysit loop owns this worktree — there can
 * never be local commits we'd be discarding that weren't already
 * pushed (the runner pushes every commit it makes).
 *
 * Reset --hard is appropriate ONLY because of that invariant. If the
 * runner ever stages a commit without pushing, this helper must be
 * revisited to avoid eating work.
 */
export async function pullLatest(
  args: PullLatestArgs,
): Promise<PullLatestResult> {
  const fetch = await runAsync("git", ["fetch", "origin", args.branch], {
    cwd: args.worktreePath,
    timeoutMs: 60_000,
  });
  if (!fetch.ok) {
    return {
      ok: false,
      reason: "git_failure",
      detail: `git fetch origin ${args.branch}: ${fetch.stderr.trim()}`,
    };
  }
  const reset = await runAsync(
    "git",
    ["reset", "--hard", `origin/${args.branch}`],
    { cwd: args.worktreePath, timeoutMs: 30_000 },
  );
  if (!reset.ok) {
    return {
      ok: false,
      reason: "git_failure",
      detail: `git reset --hard origin/${args.branch}: ${reset.stderr.trim()}`,
    };
  }
  return { ok: true, worktreePath: args.worktreePath, created: false };
}

export interface RemoveWorktreeArgs {
  /** Absolute path to the worktree. */
  worktreePath: string;
  /** Source repo path (where `.git` lives) — needed for `git worktree
   *  remove` to clean up the metadata entry. If omitted, we still
   *  rm the directory but skip the git-level prune; the next ensure
   *  call will reconcile. */
  sourceRepoPath?: string;
}

export type RemoveWorktreeResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: "filesystem_failure"; detail: string };

/**
 * Idempotent teardown. Always returns ok=true unless the rm itself
 * fails — a missing worktree is success, not a fault.
 */
export async function removeWorktree(
  args: RemoveWorktreeArgs,
): Promise<RemoveWorktreeResult> {
  const existed = fs.existsSync(args.worktreePath);
  if (args.sourceRepoPath && fs.existsSync(args.sourceRepoPath)) {
    // Use git's own remove so the .git/worktrees admin entry is also
    // pruned. `--force` tolerates a dirty tree (we're about to nuke
    // the dir anyway).
    await runAsync(
      "git",
      ["worktree", "remove", "--force", args.worktreePath],
      { cwd: args.sourceRepoPath, timeoutMs: 30_000 },
    );
  }
  // Belt-and-suspenders: even if git worktree remove succeeded, also
  // rm the directory in case the user's git is older than 2.17 and
  // didn't actually delete it.
  if (fs.existsSync(args.worktreePath)) {
    try {
      fs.rmSync(args.worktreePath, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        reason: "filesystem_failure",
        detail: (err as Error).message,
      };
    }
  }
  return { ok: true, removed: existed };
}

/** Compute the canonical worktree path for a (repo, prNumber) pair.
 *  Exported so callers can predict the path without invoking ensure
 *  (e.g. for logging or for the babysit DB to record). */
export function worktreePathFor(repo: string, prNumber: number): string {
  const slug = repo.replace(/\//g, "__");
  return path.join(worktreeRoot(), slug, `pr-${prNumber}`);
}

async function isValidWorktree(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  const res = await runAsync("git", ["rev-parse", "--git-dir"], {
    cwd: dir,
    timeoutMs: 5_000,
  });
  return res.ok;
}

/** Branch-name validator. Refuses anything that could be interpreted
 *  by git as a flag, by the shell as a metacharacter, or by the
 *  filesystem as a traversal. We mirror the rules git itself applies
 *  in `git check-ref-format` plus a few belt-and-suspenders extras
 *  (no leading dash so git never reads it as an option). */
export function validateBranchName(branch: string): {
  valid: boolean;
  reason: string;
} {
  if (typeof branch !== "string" || branch.length === 0) {
    return { valid: false, reason: "branch name is empty" };
  }
  if (branch.length > 255) {
    return { valid: false, reason: "branch name exceeds 255 chars" };
  }
  if (branch.startsWith("-")) {
    return { valid: false, reason: "branch name may not start with '-'" };
  }
  // git check-ref-format forbids: spaces, ASCII control chars, ~ ^ : ? *
  // [ \\, leading or trailing /, double-slash, double-dot, trailing
  // .lock, .. anywhere, @{
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch)) {
    return { valid: false, reason: "branch name contains forbidden chars" };
  }
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    branch.endsWith(".")
  ) {
    return {
      valid: false,
      reason: "branch name violates git ref-format rules",
    };
  }
  return { valid: true, reason: "" };
}
