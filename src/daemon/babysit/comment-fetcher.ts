/**
 * Pull review + issue comments from a PR and normalize them into the
 * shape the judge consumes. Each comment is keyed by a stable content
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
 * Auth: we route through the shared `ghRequest` shim so App auth is
 * used when an installation id is available (production daemons where
 * `gh` is not installed for any human), with the gh CLI as the local-dev
 * fallback. Failure modes are mapped back to the existing classifier so
 * the state machine's escalation strings stay stable.
 */
import * as crypto from "crypto";
import { ghRequest, type GhClientDeps } from "./gh-client.js";

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
 * cwd matters: when we fall back to the gh CLI it resolves auth + default
 * repo from the working dir. For a babysit job we pass the worktree path;
 * for a one-off MCP invocation we pass process.cwd().
 *
 * `installationId` opts the call onto App auth when a GitHub App is
 * configured for the daemon — required on headless hosts where no human
 * has `gh auth login`'d.
 */
/**
 * Cap pages-per-endpoint when paginating. Busy PRs can have hundreds of
 * comments; this still bounds wall-clock + memory while in practice
 * covering every PR we'd realistically babysit. (At 100/page that's
 * 1000 comments across two endpoints — well past the comment-volume
 * any active PR would generate.)
 */
const MAX_PAGES_PER_ENDPOINT = 10;

export async function fetchPrComments(
  args: {
    owner: string;
    repo: string;
    prNumber: number;
    cwd: string;
    /** When set, only fetch comments newer than this ISO timestamp.
     *  Used by the polling loop to avoid re-hashing the full comment list
     *  every tick. GitHub's REST API supports `since=` directly. */
    since?: string;
    /** GitHub App installation id; opts into App auth when paired with a
     *  configured App. Falls back to gh CLI when absent. */
    installationId?: number | null;
  },
  deps: GhClientDeps = {},
): Promise<FetchCommentsResult> {
  const { owner, repo, prNumber, cwd, since, installationId } = args;
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";

  const reviewBasePath = `repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const issueBasePath = `repos/${owner}/${repo}/issues/${prNumber}/comments`;

  // Walk pages until a short page tells us we're done OR we hit the
  // safety cap. Per-endpoint independently so a slow page on one
  // endpoint doesn't starve the other.
  const [reviewPaged, issuePaged] = await Promise.all([
    fetchAllPages<GhReviewCommentJson>(
      reviewBasePath,
      sinceQuery,
      cwd,
      installationId,
      deps,
    ),
    fetchAllPages<GhIssueCommentJson>(
      issueBasePath,
      sinceQuery,
      cwd,
      installationId,
      deps,
    ),
  ]);

  // Fail closed — autonomous judging on partial input is unsafe. If the
  // review endpoint failed but the issue endpoint succeeded, the judge
  // would miss line-level bot comments entirely and potentially merge a
  // PR with unaddressed P1 review feedback. The state machine retries
  // failed fetches next tick, so transient errors recover; surfacing the
  // failure here is the right safety boundary.
  if (!reviewPaged.ok || !issuePaged.ok) {
    // Pick the actually-failed page to extract status/errorText from.
    // The discriminant union forces narrowing via a typed local — a
    // ternary on .ok loses the narrowing because the result type is
    // the union, not the failure-only branch.
    const failed: { status: number; errorText: string } = !reviewPaged.ok
      ? { status: reviewPaged.status, errorText: reviewPaged.errorText }
      : !issuePaged.ok
        ? { status: issuePaged.status, errorText: issuePaged.errorText }
        : { status: 0, errorText: "" };
    const reason =
      classifyGhFailureResult({
        status: failed.status,
        errorText: failed.errorText,
      }) ?? "unknown";
    return {
      ok: false,
      reason,
      detail: failed.errorText.trim(),
    };
  }

  const reviewComments = reviewPaged.items;
  const issueComments = issuePaged.items;

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

type PageResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; status: number; errorText: string };

async function fetchAllPages<T>(
  basePath: string,
  sinceQuery: string,
  cwd: string,
  installationId: number | null | undefined,
  deps: GhClientDeps,
): Promise<PageResult<T>> {
  const collected: T[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_ENDPOINT; page++) {
    const path = `${basePath}?per_page=100&page=${page}${sinceQuery}`;
    const res = await ghRequest(
      {
        method: "GET",
        path,
        cwd,
        timeoutMs: 20_000,
        installationId: installationId ?? undefined,
      },
      deps,
    );
    if (!res.ok) {
      // Whole-endpoint failure on the FIRST page → fail the endpoint
      // so the caller's partial-data logic can still prefer the other
      // endpoint. Failure on page 2+ is treated as "return what we
      // have so far" — losing the tail is better than losing the head.
      if (page === 1) {
        return { ok: false, status: res.status, errorText: res.errorText };
      }
      break;
    }
    const items = coerceArray<T>(res.body);
    collected.push(...items);
    if (items.length < 100) break;
  }
  return { ok: true, items: collected };
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

function coerceArray<T>(body: unknown): T[] {
  // ghRequest already JSON-parses the response body when the server
  // returns JSON. Accept either a parsed array directly (App path,
  // normal CLI 200) or a raw string for the rare cases where parsing
  // fell through to the string fallback.
  if (Array.isArray(body)) return body as T[];
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function classifyGhFailureResult(res: {
  status: number;
  errorText: string;
}): CommentFetchFailReason | null {
  // Prefer HTTP status when ghRequest could pull one out — both the App
  // path and the CLI fallback surface a parsed status. Fall through to
  // stderr-string matching for the gh-not-installed / network classes
  // where there's no HTTP exchange at all.
  if (res.status === 404) return "pr_not_found";
  if (res.status === 401 || res.status === 403) return "gh_not_authed";
  const s = (res.errorText ?? "").toLowerCase();
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
