/**
 * Tiny shim over `gh pr view` / GitHub REST to read the PR metadata
 * the state machine needs to drive a job: head branch (for worktree
 * checkout + push target), base branch (for context in the judge
 * prompt), and title (also for the judge prompt).
 *
 * Separate module from `comment-fetcher.ts` so the runner can fetch
 * metadata once at the start of a job and reuse it for the duration —
 * fetcher pulls the comment delta on every tick, metadata is stable
 * across the PR's lifetime.
 *
 * Implementation just calls the gh client (App-auth when installation
 * id known, CLI fallback otherwise) and projects out the fields we
 * need. The full GitHub PR object has dozens of fields; pinning the
 * subset here keeps the rest of the babysit code from coupling to
 * GitHub's schema surface.
 */
import { ghRequest, type GhClientDeps } from "./gh-client.js";

export interface PrMetadata {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** Repository default branch — useful when the PR base differs. */
  defaultBranch: string;
  /** "open" | "closed" | "merged" — the state machine treats merged as
   *  the terminal happy path. */
  state: "open" | "closed" | "merged";
}

export type FetchPrMetadataResult =
  | { ok: true; meta: PrMetadata }
  | { ok: false; reason: FetchMetaFailReason; detail: string };

export type FetchMetaFailReason =
  | "pr_not_found"
  | "gh_failure"
  | "malformed_response";

interface GhPrResponse {
  number?: number;
  title?: string;
  head?: { ref?: string };
  base?: { ref?: string };
  state?: string;
  merged?: boolean;
  base_repo?: unknown;
}

interface GhRepoResponse {
  default_branch?: string;
}

export async function fetchPrMetadata(
  args: {
    owner: string;
    repo: string;
    prNumber: number;
    cwd: string;
    installationId?: number | null;
  },
  deps: GhClientDeps = {},
): Promise<FetchPrMetadataResult> {
  // PR + repo lookups are independent — fan them out so a slow
  // GitHub doesn't double the tick latency.
  const [prRes, repoRes] = await Promise.all([
    ghRequest(
      {
        method: "GET",
        path: `repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`,
        cwd: args.cwd,
        installationId: args.installationId ?? undefined,
      },
      deps,
    ),
    ghRequest(
      {
        method: "GET",
        path: `repos/${args.owner}/${args.repo}`,
        cwd: args.cwd,
        installationId: args.installationId ?? undefined,
      },
      deps,
    ),
  ]);

  if (!prRes.ok) {
    if (prRes.status === 404) {
      return {
        ok: false,
        reason: "pr_not_found",
        detail: prRes.errorText || `PR ${args.prNumber} not found`,
      };
    }
    return { ok: false, reason: "gh_failure", detail: prRes.errorText };
  }
  if (!repoRes.ok) {
    return { ok: false, reason: "gh_failure", detail: repoRes.errorText };
  }

  const pr = prRes.body as GhPrResponse | null;
  const repoBody = repoRes.body as GhRepoResponse | null;
  if (
    !pr ||
    typeof pr.title !== "string" ||
    !pr.head ||
    typeof pr.head.ref !== "string" ||
    !pr.base ||
    typeof pr.base.ref !== "string"
  ) {
    return {
      ok: false,
      reason: "malformed_response",
      detail: "PR JSON missing title/head/base",
    };
  }
  if (!repoBody || typeof repoBody.default_branch !== "string") {
    return {
      ok: false,
      reason: "malformed_response",
      detail: "repo JSON missing default_branch",
    };
  }

  const state: PrMetadata["state"] = pr.merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : "open";

  return {
    ok: true,
    meta: {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      title: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      defaultBranch: repoBody.default_branch,
      state,
    },
  };
}
