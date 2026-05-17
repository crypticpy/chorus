/**
 * Pull review + issue comments from a PR via `gh` and normalize them into
 * the shape the judge consumes. Each comment is keyed by a stable content
 * hash (sha256 of body) so the per-comment circuit breaker can recognise
 * "we've already judged this exact body N times for this PR" across
 * separate fetch passes.
 *
 * Author classification: GitHub flags bot accounts with `[bot]` in their
 * login. We additionally map well-known login slugs to a canonical `bot`
 * field (`coderabbit`, `sourcery`, `greptile`, `chatgpt-codex`) so the
 * judge prompt can route per-bot heuristics without re-doing regex on
 * the login.
 *
 * gh failure modes reuse the classifier from github-pr.ts via a tiny
 * shared helper kept inline here — duplicating two enums is cheaper than
 * cross-importing private internals.
 */
import * as crypto from "crypto";
import { runAsync } from "../ship.js";

export type CommentKind = "review" | "issue";

export interface RawPrComment {
  /** GitHub numeric comment id (stable across re-fetches). */
  id: number;
  kind: CommentKind;
  /** GitHub login of the author, verbatim (e.g. "coderabbitai[bot]"). */
  authorLogin: string;
  /** True when GitHub itself flags the account as a bot, OR when the
   *  login matches a known-bot slug. Humans always false. */
  isBot: boolean;
  /** Canonical bot slug for routing: coderabbit / sourcery / greptile /
   *  chatgpt-codex / null (human or unknown bot). */
  bot: KnownBot | null;
  /** Raw markdown body the bot/human wrote. */
  body: string;
  /** sha256(body) — used for dedup + per-comment attempt counting. */
  bodyHash: string;
  /** ISO 8601 timestamp from GitHub. */
  createdAt: string;
  /** Review comments are line-anchored; issue comments aren't. */
  path: string | null;
  line: number | null;
  /** Direct link to the comment on github.com (for replies + audit). */
  htmlUrl: string;
}

export type KnownBot = "coderabbit" | "sourcery" | "greptile" | "chatgpt-codex";

export type CommentFetchFailReason =
  | "gh_not_installed"
  | "gh_not_authed"
  | "pr_not_found"
  | "network_failure"
  | "unknown";

export type FetchCommentsResult =
  | { ok: true; comments: RawPrComment[] }
  | { ok: false; reason: CommentFetchFailReason; detail: string };

interface GhReviewCommentJson {
  id: number;
  user: { login: string; type?: string } | null;
  body: string;
  created_at: string;
  path?: string | null;
  line?: number | null;
  html_url?: string;
}

interface GhIssueCommentJson {
  id: number;
  user: { login: string; type?: string } | null;
  body: string;
  created_at: string;
  html_url?: string;
}

const BOT_LOGIN_MAP: ReadonlyArray<[RegExp, KnownBot]> = [
  [/^coderabbitai(\[bot\])?$/i, "coderabbit"],
  [/^sourcery-ai(\[bot\])?$/i, "sourcery"],
  [/^greptile(-apps?)?(\[bot\])?$/i, "greptile"],
  [/^chatgpt-codex(\[bot\])?$/i, "chatgpt-codex"],
  [/^codex(\[bot\])?$/i, "chatgpt-codex"],
];

export function classifyAuthor(
  login: string,
  githubType?: string,
): {
  isBot: boolean;
  bot: KnownBot | null;
} {
  for (const [re, slug] of BOT_LOGIN_MAP) {
    if (re.test(login)) return { isBot: true, bot: slug };
  }
  // GitHub flags App-installed bots with user.type === "Bot" — catches
  // bots we haven't enumerated above (custom CI bots, smaller code-review
  // services). We still surface them so the judge sees them, just with
  // bot=null so per-bot heuristics don't fire.
  const looksLikeBot =
    githubType === "Bot" || /\[bot\]$/i.test(login) || /-bot$/i.test(login);
  return { isBot: looksLikeBot, bot: null };
}

export function hashCommentBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf-8").digest("hex");
}

/**
 * Fetch both review (line-anchored) and issue (conversation) comments for
 * a PR, normalize them, and return one merged list sorted oldest-first.
 *
 * cwd matters: gh resolves auth + default repo from the working dir. For
 * a babysit job we pass the worktree path; for a one-off MCP invocation
 * we pass process.cwd().
 */
export async function fetchPrComments(args: {
  owner: string;
  repo: string;
  prNumber: number;
  cwd: string;
  /** When set, only fetch comments newer than this ISO timestamp.
   *  Used by the polling loop to avoid re-hashing the full comment list
   *  every tick. GitHub's REST API supports `since=` directly. */
  since?: string;
}): Promise<FetchCommentsResult> {
  const { owner, repo, prNumber, cwd, since } = args;
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";

  const reviewPath = `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100${sinceQuery}`;
  const issuePath = `repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100${sinceQuery}`;

  const [reviewRes, issueRes] = await Promise.all([
    runAsync("gh", ["api", reviewPath], { cwd, timeoutMs: 20_000 }),
    runAsync("gh", ["api", issuePath], { cwd, timeoutMs: 20_000 }),
  ]);

  // If both calls failed with the same reason, surface it. If one fails
  // and the other succeeds, prefer the success — partial comment data
  // is more useful than nothing.
  if (!reviewRes.ok && !issueRes.ok) {
    const reason =
      classifyGhFailure(reviewRes.stderr) ?? classifyGhFailure(issueRes.stderr);
    return {
      ok: false,
      reason: reason ?? "unknown",
      detail: (reviewRes.stderr || issueRes.stderr || "").trim(),
    };
  }

  const reviewComments = reviewRes.ok
    ? safeParseArray<GhReviewCommentJson>(reviewRes.stdout)
    : [];
  const issueComments = issueRes.ok
    ? safeParseArray<GhIssueCommentJson>(issueRes.stdout)
    : [];

  const out: RawPrComment[] = [];
  for (const c of reviewComments) {
    out.push(normalize(c, "review"));
  }
  for (const c of issueComments) {
    out.push(normalize(c, "issue"));
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ok: true, comments: out };
}

function normalize(
  raw: GhReviewCommentJson | GhIssueCommentJson,
  kind: CommentKind,
): RawPrComment {
  const login = raw.user?.login ?? "(unknown)";
  const { isBot, bot } = classifyAuthor(login, raw.user?.type);
  const body = raw.body ?? "";
  return {
    id: Number(raw.id),
    kind,
    authorLogin: login,
    isBot,
    bot,
    body,
    bodyHash: hashCommentBody(body),
    createdAt: raw.created_at ?? "",
    path:
      kind === "review" ? ((raw as GhReviewCommentJson).path ?? null) : null,
    line:
      kind === "review" ? ((raw as GhReviewCommentJson).line ?? null) : null,
    htmlUrl: raw.html_url ?? "",
  };
}

function safeParseArray<T>(stdout: string): T[] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function classifyGhFailure(stderr: string): CommentFetchFailReason | null {
  const s = (stderr ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (
    s.includes("command not found") ||
    s.includes("gh: command not found") ||
    s.includes("is not recognized")
  ) {
    return "gh_not_installed";
  }
  if (
    s.includes("gh auth login") ||
    s.includes("not logged into") ||
    s.includes("no oauth token") ||
    s.includes("authentication required") ||
    s.includes("bad credentials")
  ) {
    return "gh_not_authed";
  }
  if (
    s.includes("could not resolve to a pullrequest") ||
    s.includes("not found") ||
    s.includes("404")
  ) {
    return "pr_not_found";
  }
  if (
    s.includes("connection refused") ||
    s.includes("could not resolve host") ||
    s.includes("network is unreachable") ||
    s.includes("eai_again")
  ) {
    return "network_failure";
  }
  return "unknown";
}
