/**
 * Ship phase — open a GitHub PR with the doer's diff after reviewers agree.
 *
 * v0.5 scope (Option 2): branch + commit + push + `gh pr create`. STOPS
 * there. No auto-merge, no CI awaiting, no conflict auto-resolve. Those are
 * v0.6+. The pitch: chorus brings you a PR; a human clicks Merge.
 *
 * Lifecycle:
 *   1. detectGitContext(repoPath) — verify it's a repo, gh installed/authed,
 *      base branch resolvable, working tree state OK
 *   2. createShipBranch(...)     — branch off baseBranch
 *   3. commitChanges(...)         — stage + commit doer's diff
 *   4. pushBranch(...)            — push the chorus/<chatId> branch
 *   5. openPr(...)                — `gh pr create` against baseBranch
 *
 * On any failure: leave the repo as the user expects (no orphan branches
 * pushed without a PR; no hanging staging area). Caller flips chat status
 * to `blocked` and stores the error string.
 *
 * Graceful degrade: when chat has no repoPath, when gh isn't installed,
 * when there's no remote — caller skips ship and ends chat at `approved`.
 * Not an error.
 */

import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Sanitise git/gh stderr before persisting it into the chat row's ship_error
 * column or surfacing in the cockpit. The raw output may include the user's
 * home directory, ssh key paths, and full local repo paths — none of which
 * a non-author cockpit viewer should see. We:
 *   - replace HOME with `~`
 *   - replace any /Users/<name>/ or /home/<name>/ with `~/`
 *   - strip lines that mention `id_rsa`, `id_ed25519`, etc. entirely
 *   - cap at 600 chars so a runaway stderr can't blow up the DB row
 */
export function sanitizeStderr(raw: string): string {
  if (!raw) return "";
  const home = os.homedir();
  let s = raw;
  if (home && home.length > 3) {
    s = s.split(home).join("~");
  }
  // Unix homedirs.
  s = s.replace(/\/(?:Users|home)\/[^/\s:'"]+/g, "~");
  // Windows homedirs (C:\Users\foo\... or D:\Users\foo\...). Case-insensitive.
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s:'"]+/g, "~");
  s = s
    .split("\n")
    .filter((line) => !/\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i.test(line))
    .join("\n");
  s = s.trim();
  if (s.length > 600) s = s.slice(0, 600) + "… [truncated]";
  return s;
}

export interface GitContext {
  /** Absolute path to the repo. */
  repoPath: string;
  /** Detected default branch (origin/HEAD or origin/main fallback). */
  baseBranch: string;
  /** Current branch name when ship was invoked (so we can return to it on cleanup). */
  startingBranch: string;
  /** Remote URL (https or ssh) — informational, used for PR-URL inference. */
  remoteUrl: string;
}

export type GitContextResult =
  | { ok: true; context: GitContext }
  | { ok: false; reason: GitContextFailure; detail: string };

export type GitContextFailure =
  | "not_a_repo"
  | "no_remote"
  | "gh_not_installed"
  | "gh_not_authed"
  | "base_branch_unresolvable"
  | "dirty_working_tree";

/**
 * Validate the repo path is shippable. Read-only — never mutates the repo.
 *
 * Caller-controlled UX: when this returns `ok: false`, runner decides
 * whether to surface the issue (e.g. "gh not installed → ship skipped,
 * status=approved") or treat it as a hard fail. Currently every failure
 * mode here results in skip-ship-end-approved — Ship is opt-in by template
 * + repoPath, not a guarantee.
 */
export async function detectGitContext(
  repoPath: string,
  baseBranchOverride?: string,
): Promise<GitContextResult> {
  // 1. Path exists + is a directory. Sync fs ops are fine — they're
  // memory-cheap and the rest of detect bails fast if these fail.
  if (!fs.existsSync(repoPath)) {
    return {
      ok: false,
      reason: "not_a_repo",
      detail: `Path does not exist: ${repoPath}`,
    };
  }
  const stat = fs.statSync(repoPath);
  if (!stat.isDirectory()) {
    return {
      ok: false,
      reason: "not_a_repo",
      detail: `Not a directory: ${repoPath}`,
    };
  }

  // Probes 2-5 + 7 are independent — run them concurrently. Pre-fix the
  // five spawnSync calls were sequential at 60s timeout each, so a
  // network-bound `gh auth status` (most common slow probe) blocked
  // every following call → worst-case 360s before the runner even saw
  // a result. Now they run in parallel with a 15s per-probe cap, so
  // worst case is 15s aggregate.
  const [insideRepo, remotes, ghVersion, ghAuth, head] = await Promise.all([
    gitAsync(repoPath, ["rev-parse", "--is-inside-work-tree"]),
    gitAsync(repoPath, ["remote", "-v"]),
    runAsync("gh", ["--version"], { cwd: repoPath }),
    runAsync("gh", ["auth", "status"], { cwd: repoPath }),
    gitAsync(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  // Evaluate failure conditions in priority order so the user sees the
  // most actionable error first (e.g. "not a git repo" beats
  // "gh not authed").
  if (!insideRepo.ok || insideRepo.stdout.trim() !== "true") {
    return {
      ok: false,
      reason: "not_a_repo",
      detail: `Not a git repo: ${repoPath}`,
    };
  }
  if (!remotes.ok || remotes.stdout.trim().length === 0) {
    return {
      ok: false,
      reason: "no_remote",
      detail: "No git remote configured.",
    };
  }
  const remoteLines = remotes.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const originLine =
    remoteLines.find((l) => l.startsWith("origin\t")) ?? remoteLines[0];
  const remoteUrl = (originLine.split(/\s+/)[1] ?? "").trim();
  if (!remoteUrl) {
    return { ok: false, reason: "no_remote", detail: "Remote URL empty." };
  }
  if (!ghVersion.ok) {
    return {
      ok: false,
      reason: "gh_not_installed",
      detail: "gh CLI not on PATH. Install from https://cli.github.com.",
    };
  }
  if (!ghAuth.ok) {
    return {
      ok: false,
      reason: "gh_not_authed",
      detail: `gh not authenticated. Run \`gh auth login\` first. (${sanitizeStderr(ghAuth.stderr).split("\n")[0] ?? ""})`,
    };
  }

  // 6. Resolve base branch — explicit override > origin/HEAD > origin/main > main.
  const baseBranch =
    baseBranchOverride ?? (await detectDefaultBranch(repoPath));
  if (!baseBranch) {
    return {
      ok: false,
      reason: "base_branch_unresolvable",
      detail:
        "Could not detect default branch. Pass `template.ship.baseBranch` explicitly.",
    };
  }

  const startingBranch = head.ok ? head.stdout.trim() : baseBranch;

  return {
    ok: true,
    context: { repoPath, baseBranch, startingBranch, remoteUrl },
  };
}

/**
 * Detect the default branch by asking the remote. Prefers origin/HEAD
 * symref (set by `git clone`); falls back to common branch names. The
 * symref + fallback existence checks are independent and run in
 * parallel — we filter the symref result first and only fall back when
 * it's missing.
 */
async function detectDefaultBranch(
  repoPath: string,
): Promise<string | undefined> {
  const candidates = ["main", "master", "develop"] as const;
  const [symref, ...existsChecks] = await Promise.all([
    gitAsync(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
    ...candidates.map((c) =>
      gitAsync(repoPath, ["rev-parse", "--verify", `origin/${c}`]),
    ),
  ]);
  if (symref.ok) {
    const m = /refs\/remotes\/origin\/(.+)$/.exec(symref.stdout.trim());
    if (m) return m[1];
  }
  for (let i = 0; i < candidates.length; i++) {
    if (existsChecks[i]?.ok) return candidates[i];
  }
  return undefined;
}

export interface ShipOptions {
  context: GitContext;
  chatId: string;
  templateId: string;
  branchPattern: string; // e.g. 'chorus/{chatId}'
  titleTemplate: string; // e.g. 'chorus: {template} via #{chatId}'
  /** Short summary from the chat — used in commit message + PR body. */
  summary: string;
  /** Full doer answer text — included in the PR body for context. */
  doerOutput: string;
}

export type ShipResult =
  | { ok: true; prUrl: string; branch: string }
  | { ok: false; stage: ShipFailureStage; detail: string };

export type ShipFailureStage =
  | "no_changes_to_ship"
  | "branch_create_failed"
  | "commit_failed"
  | "push_failed"
  | "pr_create_failed";

/**
 * Run the full ship sequence. Idempotent on the branch name: if the chorus
 * branch already exists locally, we reuse it (allows retries without
 * stomping). If no diff vs base — return `no_changes_to_ship`.
 */
export function runShipPhase(opts: ShipOptions): ShipResult {
  const {
    context,
    chatId,
    templateId,
    branchPattern,
    titleTemplate,
    summary,
    doerOutput,
  } = opts;
  const branch = branchPattern.replace("{chatId}", chatId);

  // 1. Anything to ship? Compare working tree + index against base.
  const diff = git(context.repoPath, [
    "diff",
    "--name-only",
    `${context.baseBranch}...HEAD`,
  ]);
  const indexDiff = git(context.repoPath, ["status", "--porcelain"]);
  const hasCommittedChanges = diff.ok && diff.stdout.trim().length > 0;
  const hasUncommittedChanges =
    indexDiff.ok && indexDiff.stdout.trim().length > 0;

  if (!hasCommittedChanges && !hasUncommittedChanges) {
    return {
      ok: false,
      stage: "no_changes_to_ship",
      detail: `No diff vs ${context.baseBranch}; nothing to commit.`,
    };
  }

  // 2. Branch off base. Use checkout -B for idempotence (replaces if exists).
  // Fetch first so we branch off latest origin/<base>.
  git(context.repoPath, ["fetch", "origin", context.baseBranch]);

  const branchCreate = git(context.repoPath, [
    "checkout",
    "-B",
    branch,
    `origin/${context.baseBranch}`,
  ]);
  if (!branchCreate.ok) {
    return {
      ok: false,
      stage: "branch_create_failed",
      detail: `git checkout -B ${branch} failed: ${sanitizeStderr(branchCreate.stderr)}`,
    };
  }

  // After checkout -B, the working tree changes from the chat's edits are
  // re-applied (git carries them through as long as base + chat don't
  // conflict on the same files). If they did conflict, status will show
  // unmerged paths — we surface that as a commit failure below.

  // 3. Stage + commit. Skip if there's nothing to commit (already on
  // committed history from base — rare but possible if doer used `git commit`
  // directly inside the repo).
  const stage = git(context.repoPath, ["add", "-A"]);
  if (!stage.ok) {
    return {
      ok: false,
      stage: "commit_failed",
      detail: `git add -A failed: ${sanitizeStderr(stage.stderr)}`,
    };
  }

  const commitMsg = formatCommitMessage(templateId, chatId, summary);
  const commit = git(context.repoPath, [
    "commit",
    "-m",
    commitMsg,
    "--allow-empty",
  ]);
  if (!commit.ok) {
    return {
      ok: false,
      stage: "commit_failed",
      detail: `git commit failed: ${sanitizeStderr(commit.stderr)}`,
    };
  }

  // 4. Push.
  const push = git(context.repoPath, ["push", "-u", "origin", branch]);
  if (!push.ok) {
    return {
      ok: false,
      stage: "push_failed",
      detail: `git push failed: ${sanitizeStderr(push.stderr)}`,
    };
  }

  // 5. Open PR via gh.
  const prTitle = titleTemplate
    .replace("{template}", templateId)
    .replace("{chatId}", chatId)
    .replace("{summary}", summary.split("\n")[0]?.slice(0, 60) ?? "");
  const prBody = formatPrBody(templateId, chatId, summary, doerOutput);

  const prCreate = run(
    "gh",
    [
      "pr",
      "create",
      "--base",
      context.baseBranch,
      "--head",
      branch,
      "--title",
      prTitle,
      "--body",
      prBody,
    ],
    { cwd: context.repoPath },
  );

  if (!prCreate.ok) {
    return {
      ok: false,
      stage: "pr_create_failed",
      detail: `gh pr create failed: ${sanitizeStderr(prCreate.stderr) || sanitizeStderr(prCreate.stdout)}`,
    };
  }

  // gh prints the PR URL on success; capture it. Validate the shape so
  // an empty/malformed stdout doesn't get persisted as a "successful
  // ship" with prUrl='' — the chat row would record success but the
  // cockpit would render an unclickable empty link, and any downstream
  // automation (PR-comment write-back, notifications) would break.
  const prUrl = prCreate.stdout.trim().split("\n").pop() ?? "";
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(prUrl)) {
    return {
      ok: false,
      stage: "pr_create_failed",
      detail: `gh pr create returned exit 0 but stdout did not contain a PR URL. stdout=${sanitizeStderr(prCreate.stdout) || "(empty)"}`,
    };
  }
  return { ok: true, prUrl, branch };
}

function formatCommitMessage(
  templateId: string,
  chatId: string,
  summary: string,
): string {
  const firstLine =
    summary.split("\n")[0]?.slice(0, 70) ?? `chorus: ${templateId}`;
  return `${firstLine}\n\nGenerated by chorus chat ${chatId} (${templateId} template).\n`;
}

function formatPrBody(
  templateId: string,
  chatId: string,
  summary: string,
  doerOutput: string,
): string {
  const truncated =
    doerOutput.length > 8000
      ? `${doerOutput.slice(0, 8000)}\n\n_(truncated — full output in chat)_`
      : doerOutput;
  return [
    `Generated by [chorus](https://chorus.codes) — multi-LLM peer-reviewed PR.`,
    ``,
    `**Template:** \`${templateId}\``,
    `**Chat ID:** \`${chatId}\``,
    `**Summary:** ${summary.split("\n")[0] ?? "(no summary)"}`,
    ``,
    `---`,
    ``,
    `## Doer output`,
    ``,
    truncated,
  ].join("\n");
}

// ─── Process helpers ────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function git(repoPath: string, args: string[]): RunResult {
  return run("git", args, { cwd: repoPath });
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string },
): RunResult {
  try {
    const result = spawnSync(command, args, {
      cwd: opts.cwd,
      encoding: "utf-8",
      // 60s per command — covers a slow `gh pr create` against a heavy repo.
      timeout: 60_000,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: null,
    };
  }
}

/**
 * Async sibling of `run` — used when detectGitContext fans out probes in
 * parallel. spawnSync would block the event loop and serialise the
 * supposed-to-be-parallel work; spawn lets multiple subprocesses
 * actually overlap. Per-call timeout defaults to 15s (these are
 * metadata reads, not push/clone), bounded by the caller via
 * `timeoutMs`.
 *
 * Exported so other daemon modules (github-pr.ts) can fan out gh CLI
 * calls without re-implementing the spawn/timeout dance.
 */
export function runAsync(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let stdout = "";
    let stderr = "";
    // Pipe stdin only when the caller has data to send — leaves the
    // default ("inherit-like" no-op) behaviour for the legacy fan-out
    // callers that never write to stdin.
    const stdio: Array<"pipe" | "ignore"> =
      opts.input !== undefined
        ? ["pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"];
    const child = spawn(command, args, { cwd: opts.cwd, stdio });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\n[chorus] timed out after ${timeoutMs}ms`,
        code: null,
      });
    }, timeoutMs);
    if (opts.input !== undefined && child.stdin) {
      // EPIPE is possible if the child exits before stdin is drained
      // (e.g. it crashes on bad args). Swallow that here so the close
      // handler can still surface the real exit code/stderr.
      child.stdin.on("error", () => {});
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function gitAsync(
  repoPath: string,
  args: string[],
  timeoutMs?: number,
): Promise<RunResult> {
  return runAsync("git", args, { cwd: repoPath, timeoutMs });
}

// Suppress linter: execFileSync is imported for symmetry with other shims
// but currently unused here. Keep the import for future v0.6 work that
// pipes longer doer outputs via stdin.
void execFileSync;
void path;
