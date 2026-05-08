/**
 * Pull a GitHub PR via `gh` CLI and synthesize a single-string artifact
 * suitable for the `review-only` template. Used by:
 *   - POST /chats/from-pr (cockpit "Review a GitHub PR" tab)
 *   - MCP tool `review_pr`
 *
 * v1 scope: read-only — fetch PR meta, diff, and existing comments;
 * compose Markdown; return. Posting chorus's verdict back to the PR
 * (`gh pr comment`) is a separate, opt-in flow.
 *
 * Auth model: we shell out to whatever `gh` is on PATH and assume the
 * user has already run `gh auth login`. No tokens stored, no OAuth
 * dance. If gh is missing or unauthed we surface a typed failure
 * reason; the route can render an actionable error to the user.
 *
 * Caps:
 *   - Diff: 200 KB. Bigger diffs truncate with a visible marker. The
 *     full reviewer-artifact cap is 256 KB (see prompt-builder.ts);
 *     200 KB leaves headroom for description + comments.
 *   - Existing comments: pulls the first 100 of each kind (review +
 *     issue) without paginating. PRs with >100 comments are rare
 *     enough that the simpler shell-out wins; we surface a note in the
 *     artifact when we hit the cap.
 */
import { sanitizeStderr } from "./ship.js";
import { runAsync } from "./ship.js";

export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
}

export interface PrMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** Markdown body the author wrote. May be empty. */
  body: string;
  baseBranch: string;
  headBranch: string;
  authorLogin: string;
  additions: number;
  deletions: number;
  labels: string[];
}

export type PrFailReason =
  | "invalid_url"
  | "gh_not_installed"
  | "gh_not_authed"
  | "pr_not_found"
  | "network_failure"
  | "unknown";

export type FetchPrResult =
  | { ok: true; artifact: string; meta: PrMeta }
  | { ok: false; reason: PrFailReason; detail: string };

/** Cap individual diff text at this size before we splice it into the
 *  artifact. Leaves room under prompt-builder.ts's 256 KB
 *  ARTIFACT_PROMPT_CAP_BYTES for description + comments. */
const DIFF_CAP_BYTES = 200 * 1024;

/** GitHub PR URL pattern. Accepts trailing path/query (`/files`,
 *  `?diff=split`) — we strip them and key off owner/repo/number. */
const PR_URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/;

/**
 * Parse a GitHub PR URL. Returns null for anything that isn't a valid
 * `https://github.com/<owner>/<repo>/pull/<n>` URL — the caller
 * surfaces this as `invalid_url` to the user.
 */
export function parsePrUrl(url: string): ParsedPr | null {
  const m = PR_URL_RE.exec(url.trim());
  if (!m) return null;
  const number = parseInt(m[3], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner: m[1], repo: m[2], number };
}

interface GhPrViewJson {
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  author: { login: string } | null;
  additions: number;
  deletions: number;
  labels: { name: string }[];
}

interface GhCommentJson {
  user: { login: string } | null;
  body: string;
  created_at: string;
  /** Present on review comments (line-anchored), absent on issue comments. */
  path?: string;
  /** Present on review comments. */
  line?: number | null;
}

/**
 * Fetch the PR via gh and assemble a single Markdown artifact:
 * meta header → description → existing comments → capped diff.
 *
 * All four gh calls run concurrently — they're independent. On any
 * gh-level failure we surface a typed reason; the route renders an
 * actionable error rather than dumping raw stderr.
 */
export async function fetchPrArtifact(
  parsed: ParsedPr,
  cwd?: string,
): Promise<FetchPrResult> {
  const ghCwd = cwd ?? process.cwd();
  const url = `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;

  const viewArgs = [
    "pr",
    "view",
    url,
    "--json",
    "title,body,baseRefName,headRefName,author,additions,deletions,labels",
  ];
  const diffArgs = ["pr", "diff", url];
  const reviewCommentsPath = `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments?per_page=100`;
  const issueCommentsPath = `repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=100`;

  const [viewRes, diffRes, reviewRes, issueRes] = await Promise.all([
    runAsync("gh", viewArgs, { cwd: ghCwd, timeoutMs: 20_000 }),
    runAsync("gh", diffArgs, { cwd: ghCwd, timeoutMs: 30_000 }),
    runAsync("gh", ["api", reviewCommentsPath], {
      cwd: ghCwd,
      timeoutMs: 20_000,
    }),
    runAsync("gh", ["api", issueCommentsPath], {
      cwd: ghCwd,
      timeoutMs: 20_000,
    }),
  ]);

  // gh exits with code 0 on success. On failure, classify against
  // stderr signatures so the route can show a useful error.
  if (!viewRes.ok) {
    const cls = classifyGhFailure(viewRes.stderr);
    return {
      ok: false,
      reason: cls,
      detail: `gh pr view failed: ${sanitizeStderr(viewRes.stderr)}`,
    };
  }

  let view: GhPrViewJson;
  try {
    view = JSON.parse(viewRes.stdout) as GhPrViewJson;
  } catch (err) {
    return {
      ok: false,
      reason: "unknown",
      detail: `gh pr view returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const meta: PrMeta = {
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    title: view.title ?? "",
    body: view.body ?? "",
    baseBranch: view.baseRefName ?? "",
    headBranch: view.headRefName ?? "",
    authorLogin: view.author?.login ?? "(unknown)",
    additions: view.additions ?? 0,
    deletions: view.deletions ?? 0,
    labels: (view.labels ?? []).map((l) => l.name),
  };

  // Diff, comments — soft failures (artifact still useful without them).
  const diff = diffRes.ok ? diffRes.stdout : "";
  const reviewComments = reviewRes.ok
    ? safeParseCommentArray(reviewRes.stdout)
    : [];
  const issueComments = issueRes.ok
    ? safeParseCommentArray(issueRes.stdout)
    : [];

  const artifact = composeArtifact({
    meta,
    diff,
    reviewComments,
    issueComments,
    diffFetchOk: diffRes.ok,
    diffFetchErr: diffRes.ok ? null : sanitizeStderr(diffRes.stderr),
  });

  return { ok: true, artifact, meta };
}

function safeParseCommentArray(stdout: string): GhCommentJson[] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as GhCommentJson[]) : [];
  } catch {
    return [];
  }
}

/**
 * Map gh stderr to a typed reason. The signatures come from real `gh`
 * output as of v2.x — kept inline rather than a regex catalog because
 * gh doesn't expose machine-readable error codes and the strings are
 * stable enough across versions.
 */
function classifyGhFailure(stderr: string): PrFailReason {
  const s = (stderr ?? "").toLowerCase();
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

interface ComposeArgs {
  meta: PrMeta;
  diff: string;
  reviewComments: GhCommentJson[];
  issueComments: GhCommentJson[];
  diffFetchOk: boolean;
  diffFetchErr: string | null;
}

function composeArtifact(args: ComposeArgs): string {
  const {
    meta,
    diff,
    reviewComments,
    issueComments,
    diffFetchOk,
    diffFetchErr,
  } = args;
  const lines: string[] = [];

  lines.push(`# PR #${meta.number}: ${meta.title}`);
  lines.push("");
  lines.push(`**Repo:** \`${meta.owner}/${meta.repo}\``);
  lines.push(`**Author:** @${meta.authorLogin}`);
  lines.push(
    `**Base:** \`${meta.baseBranch}\` ← **Head:** \`${meta.headBranch}\``,
  );
  lines.push(`**Diff size:** +${meta.additions} / -${meta.deletions}`);
  if (meta.labels.length > 0) {
    lines.push(`**Labels:** ${meta.labels.map((l) => `\`${l}\``).join(", ")}`);
  }
  lines.push("");

  lines.push("## Description");
  lines.push(
    meta.body.trim().length > 0 ? meta.body.trim() : "_(no description)_",
  );
  lines.push("");

  // Existing review comments (line-anchored). Sort newest-first; cap
  // the rendered list at 50 to keep the artifact tractable. Reviewers
  // are smart enough not to need every historical reply.
  if (reviewComments.length > 0) {
    lines.push(`## Existing review comments (${reviewComments.length})`);
    const sorted = [...reviewComments].sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
    const shown = sorted.slice(0, 50);
    for (const c of shown) {
      const loc = c.path
        ? ` on \`${c.path}\`${c.line ? `:${c.line}` : ""}`
        : "";
      lines.push(
        `> **@${c.user?.login ?? "(unknown)"}**${loc}: ${oneLine(c.body)}`,
      );
    }
    if (sorted.length > shown.length) {
      lines.push(
        `_(${sorted.length - shown.length} older review comments omitted)_`,
      );
    }
    lines.push("");
  }

  if (issueComments.length > 0) {
    lines.push(`## Existing conversation comments (${issueComments.length})`);
    const sorted = [...issueComments].sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
    const shown = sorted.slice(0, 50);
    for (const c of shown) {
      lines.push(`> **@${c.user?.login ?? "(unknown)"}**: ${oneLine(c.body)}`);
    }
    if (sorted.length > shown.length) {
      lines.push(`_(${sorted.length - shown.length} older comments omitted)_`);
    }
    lines.push("");
  }

  lines.push("## Diff");
  if (!diffFetchOk) {
    lines.push(`_(diff unavailable: ${diffFetchErr ?? "unknown error"})_`);
  } else if (diff.trim().length === 0) {
    lines.push("_(no diff content returned)_");
  } else {
    const byteLen = Buffer.byteLength(diff, "utf-8");
    lines.push("```diff");
    if (byteLen <= DIFF_CAP_BYTES) {
      lines.push(diff);
    } else {
      // Walk back to a UTF-8 start byte before slicing — same
      // technique as buildReviewerAsk for the artifact cap.
      const buf = Buffer.from(diff, "utf-8");
      let cut = DIFF_CAP_BYTES;
      while (cut > 0 && (buf[cut] & 0b1100_0000) === 0b1000_0000) cut--;
      lines.push(buf.subarray(0, cut).toString("utf-8"));
      lines.push(
        `... (truncated — full diff was ${byteLen} bytes, cap is ${DIFF_CAP_BYTES} bytes)`,
      );
    }
    lines.push("```");
  }

  return lines.join("\n");
}

/** Collapse any comment body to a single line for inline rendering. */
function oneLine(text: string): string {
  return (text ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
