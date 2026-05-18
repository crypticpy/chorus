/**
 * Unified GitHub request shim for the PR-babysit loop.
 *
 * Two code paths share one surface:
 *
 *   1. **App auth** — when an installation ID is known AND the App config
 *      is persisted. We mint/recycle an installation token via gh-app.ts
 *      and hit the REST API directly with `Authorization: Bearer <token>`.
 *      This is the production path: the daemon may run on a host where
 *      no human is logged into `gh`, so we can't depend on CLI auth.
 *
 *   2. **gh CLI fallback** — when either side of the App pair is missing
 *      (no installation ID on the job, no App config in secrets). We
 *      shell out to `gh api` from the worktree path, which inherits
 *      whatever auth the developer running chorus locally has set up.
 *      This is the dev-loop path and the on-ramp for users who haven't
 *      gone through App registration yet.
 *
 * The runner never needs to know which path fired — it asks for a
 * request and gets a normalized response. Callers do, however, need to
 * pass `installationId` and `cwd` correctly:
 *
 *   - `installationId` comes from the babysit_jobs row (set when the
 *     job was registered; the registrar populates it from the webhook
 *     payload, or it's null and we fall back to CLI auth).
 *   - `cwd` is the per-PR worktree path. Pass it even on the App-auth
 *     path — we don't use it there, but always populating it keeps the
 *     call sites uniform and protects future refactors.
 *
 * Retry behaviour:
 *
 *   - On App-auth 401: tokens are cached with a 5-min buffer so 401s in
 *     practice mean the App's private key was rotated or the installation
 *     was suspended. We refresh once (forcing a fresh JWT mint) and
 *     retry; a second 401 surfaces to the caller. We do NOT retry on
 *     other 4xx — those are application errors and re-trying them won't
 *     help.
 *   - On 5xx: one retry with a small backoff. GitHub's REST API
 *     occasionally returns 502/504 under load; the babysit loop runs
 *     unattended so a single transparent retry is appropriate.
 *   - On CLI fallback failures: no in-process retry. The CLI itself
 *     already handles transient retries internally, and re-shelling
 *     just adds latency.
 */
import { runAsync } from "../ship.js";
import {
  getInstallationToken,
  loadGhAppConfig,
  type GhAppConfig,
  type GhAppFetcher,
} from "./gh-app.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GhRequestArgs {
  method: HttpMethod;
  /** Path relative to https://api.github.com — e.g. "repos/o/r/pulls/7".
   *  Leading slash is tolerated but unnecessary. */
  path: string;
  /** JSON body for POST/PATCH/PUT. Pass undefined for GET/DELETE.
   *  We JSON.stringify it ourselves to keep the surface uniform. */
  body?: unknown;
  /** When set AND App config is persisted, use App auth. Otherwise
   *  fall back to gh CLI. The fallback path is always valid; App auth
   *  only triggers when both sides of the pair are present. */
  installationId?: number | null;
  /** Worktree path. Required even for App-auth callers (we don't read
   *  it there) so call sites stay uniform. */
  cwd: string;
  /** Caller-supplied request timeout. Default 30s — webhook-driven
   *  requests want fast failure; polling loops can override. */
  timeoutMs?: number;
}

export type GhAuthMode = "app" | "cli";

export interface GhResponseOk {
  ok: true;
  authMode: GhAuthMode;
  status: number;
  /** Parsed JSON when the response body parses, raw string otherwise.
   *  Empty body (204 No Content) yields `null`. */
  body: unknown;
}

export interface GhResponseErr {
  ok: false;
  authMode: GhAuthMode;
  status: number;
  /** Raw error body verbatim. Surfaces the GitHub error message so
   *  the caller can echo it into a PR comment or escalation note. */
  errorText: string;
}

export type GhResponse = GhResponseOk | GhResponseErr;

/** Injectable deps for tests. Default uses globalThis.fetch + the
 *  process-wide gh-app config loader. */
export interface GhClientDeps {
  loadConfig?: () => Promise<GhAppConfig | null>;
  fetcher?: GhAppFetcher;
  /** Stub for the gh CLI shellout — same signature as ship.runAsync.
   *  `input` is piped to the child's stdin when present (used for
   *  POST/PATCH/PUT bodies via `gh api --input -`). */
  runCli?: (
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs?: number; input?: string },
  ) => Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
  }>;
}

/**
 * Make a GitHub API request, picking auth mode from the inputs. See the
 * file-level doc-comment for the routing table.
 */
export async function ghRequest(
  args: GhRequestArgs,
  deps: GhClientDeps = {},
): Promise<GhResponse> {
  const loadConfig = deps.loadConfig ?? loadGhAppConfig;
  const config = args.installationId ? await loadConfig() : null;

  if (config && args.installationId) {
    return appRequest(args, config, args.installationId, deps);
  }
  return cliRequest(args, deps);
}

async function appRequest(
  args: GhRequestArgs,
  config: GhAppConfig,
  installationId: number,
  deps: GhClientDeps,
): Promise<GhResponse> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  // First attempt — uses cached token when fresh.
  let res = await issueAppCall(args, config, installationId, fetcher);
  if (res.status === 401) {
    // Token may have been invalidated by a key rotation. Drop the
    // cache and try once more.
    const { _clearTokenCacheForTests } = await import("./gh-app.js");
    _clearTokenCacheForTests();
    res = await issueAppCall(args, config, installationId, fetcher);
  } else if (
    res.status >= 500 &&
    res.status < 600 &&
    isIdempotent(args.method)
  ) {
    // GitHub occasionally returns 502/504 under load. We only retry
    // idempotent methods — re-issuing a POST/PATCH risks duplicating
    // a comment that GitHub already applied before the gateway error.
    await sleep(500);
    res = await issueAppCall(args, config, installationId, fetcher);
  }
  return res;
}

function isIdempotent(method: HttpMethod): boolean {
  return method === "GET" || method === "DELETE" || method === "PUT";
}

async function issueAppCall(
  args: GhRequestArgs,
  config: GhAppConfig,
  installationId: number,
  fetcher: GhAppFetcher,
): Promise<GhResponse> {
  const { token } = await getInstallationToken({
    installationId,
    config,
    fetcher,
  });
  const cleanedPath = args.path.startsWith("/")
    ? args.path.slice(1)
    : args.path;
  const url = `https://api.github.com/${cleanedPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "chorus-babysit",
  };
  let init: { method: string; headers: Record<string, string>; body?: string };
  if (args.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init = {
      method: args.method,
      headers,
      body: JSON.stringify(args.body),
    };
  } else {
    init = { method: args.method, headers };
  }
  const res = await fetcher(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    return { ok: false, authMode: "app", status: res.status, errorText: text };
  }
  // 204 No Content — return null body, ok: true.
  if (res.status === 204) {
    return { ok: true, authMode: "app", status: 204, body: null };
  }
  const text = await res.text();
  return {
    ok: true,
    authMode: "app",
    status: res.status,
    body: tryParseJson(text),
  };
}

async function cliRequest(
  args: GhRequestArgs,
  deps: GhClientDeps,
): Promise<GhResponse> {
  const run = deps.runCli ?? runAsync;
  const cleanedPath = args.path.startsWith("/")
    ? args.path.slice(1)
    : args.path;
  const cliArgs: string[] = ["api", "--method", args.method, cleanedPath];
  // For POST/PATCH/PUT we pipe the JSON body to `gh api --input -`. gh
  // reads stdin, parses it as JSON, and forwards it as the request
  // body — which is what we want for write actions (reply posts, etc.)
  // when no GitHub App is configured. Without this the reply path
  // silently no-ops in CLI-only deployments and the babysit loop
  // burns retries until the per-comment cap fires.
  let input: string | undefined;
  if (args.body !== undefined) {
    cliArgs.push("--input", "-");
    input = JSON.stringify(args.body);
  }
  const res = await run("gh", cliArgs, {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs ?? 30_000,
    input,
  });
  if (!res.ok) {
    return {
      ok: false,
      authMode: "cli",
      status: parseHttpStatusFromGhStderr(res.stderr),
      errorText: (res.stderr || res.stdout || "").trim(),
    };
  }
  return {
    ok: true,
    authMode: "cli",
    status: 200,
    body: tryParseJson(res.stdout),
  };
}

/** Extract an HTTP status from a `gh` stderr line like
 *  "HTTP 404: Not Found (https://api.github.com/...)" — used so the
 *  caller's switch on status still works on the CLI path. */
function parseHttpStatusFromGhStderr(stderr: string): number {
  const m = /HTTP\s+(\d{3})/.exec(stderr ?? "");
  return m ? Number(m[1]) : 0;
}

function tryParseJson(text: string): unknown {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const defaultFetcher: GhAppFetcher = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    json: () => res.json(),
  };
};
