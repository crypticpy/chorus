/**
 * GitHub App authentication for the PR-babysit loop.
 *
 * Two-tier auth model:
 *   1. App JWT — short-lived (10 min), RS256-signed with the App's
 *      private key. Used ONLY to exchange for installation tokens; never
 *      used to call repo-level endpoints directly.
 *   2. Installation token — 1-hour bearer token scoped to a single
 *      installation. Used for all read/write against repos that the
 *      installation owns. Cached in-memory with a 5-min refresh buffer so
 *      we never present a token that's about to expire.
 *
 * Why no `jsonwebtoken` dep: Node's built-in crypto does RS256 with a
 * 6-line helper, and the JWT contains no nested claims we'd otherwise
 * have to construct. Skipping the dep also keeps the npm install lean
 * (the daemon ships standalone via `npm i -g chorus`).
 *
 * Config storage: one row in `secrets` with `provider='github_app'`,
 * `kind='gh_app'`, `value=JSON.stringify({appId, privateKey, webhookSecret})`.
 * Single global config — chorus is single-tenant today; the App is owned
 * by the daemon operator and serves whatever PRs they babysit.
 */
import * as crypto from "crypto";
import { secrets } from "../../lib/db/index.js";

export const GITHUB_APP_PROVIDER = "github_app";

/** Buffer before token expiry at which we consider the cache stale and
 *  mint a new one. 5 minutes leaves room for slow GitHub API responses
 *  and clock skew without ever shipping a token that expires mid-call. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** JWT lifetime — GitHub allows up to 10 min, but using the full window
 *  reduces the rate of JWT mints under sustained polling. */
const JWT_LIFETIME_SEC = 9 * 60; // 9 min, 60s under the GH cap to absorb clock skew

export interface GhAppConfig {
  /** Numeric App ID assigned by GitHub at App creation. */
  appId: string;
  /** PKCS#8 PEM private key downloaded from the App settings page. Must
   *  include the `-----BEGIN PRIVATE KEY-----` envelope. */
  privateKey: string;
  /** Random secret entered when configuring the App's webhook URL. Used
   *  by webhook-verify.ts to validate `X-Hub-Signature-256` headers.
   *  Empty string when webhooks aren't configured. */
  webhookSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** In-memory installation-token cache. Per-process; survives until daemon
 *  restart. Restart re-mints lazily on first call. */
const tokenCache = new Map<number, CachedToken>();

/** @internal — test reset. */
export function _clearTokenCacheForTests(): void {
  tokenCache.clear();
}

/**
 * Load the App config from the secrets table. Returns null when no row
 * is configured — callers (gh-client) use this to decide whether to fall
 * back to `gh` CLI auth.
 */
export async function loadGhAppConfig(): Promise<GhAppConfig | null> {
  const row = await secrets.get(GITHUB_APP_PROVIDER);
  if (!row || row.kind !== "gh_app") return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<GhAppConfig>;
    if (
      typeof parsed.appId !== "string" ||
      typeof parsed.privateKey !== "string" ||
      parsed.appId.length === 0 ||
      parsed.privateKey.length === 0
    ) {
      return null;
    }
    return {
      appId: parsed.appId,
      privateKey: parsed.privateKey,
      webhookSecret:
        typeof parsed.webhookSecret === "string" ? parsed.webhookSecret : "",
    };
  } catch {
    return null;
  }
}

/**
 * Persist a new App config. Overwrites any existing config (single global
 * row). Caller is responsible for wiping the in-memory token cache via
 * `_clearTokenCacheForTests` or by waiting for natural expiry — though in
 * practice you'd never rotate the config while the daemon is running.
 */
export async function saveGhAppConfig(config: GhAppConfig): Promise<void> {
  await secrets.set(GITHUB_APP_PROVIDER, "gh_app", JSON.stringify(config));
  // Rotating the private key invalidates any cached tokens minted under
  // the old config. Drop the cache so the next call mints fresh.
  tokenCache.clear();
}

/** base64url-encode without padding (JWT spec). */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint a GitHub App JWT (RS256). Pure crypto — no network. The `iat`
 * field is intentionally backdated 60s to absorb clock skew between the
 * daemon host and GitHub's servers (the App rejects JWTs with `iat` in
 * the future, even by 1 second).
 */
export function mintAppJwt(config: GhAppConfig, nowSec?: number): string {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + JWT_LIFETIME_SEC,
    iss: config.appId,
  };
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(config.privateKey);
  return `${signingInput}.${base64url(sig)}`;
}

/** Shape of the response from POST /app/installations/:id/access_tokens. */
interface InstallationTokenResponse {
  token: string;
  /** ISO 8601 timestamp, e.g. "2026-05-17T19:30:00Z". */
  expires_at: string;
}

/** Injectable fetcher for tests. Default uses globalThis.fetch (Node 18+). */
export type GhAppFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/**
 * Get a valid installation token for the given installation ID. Uses the
 * in-memory cache when the cached token is still fresh; otherwise mints
 * a new App JWT and exchanges it for a fresh token via GitHub's
 * installation-tokens endpoint.
 *
 * The token cache is keyed by installation ID only — multiple PRs in the
 * same installation share a token, which matches GitHub's intent.
 *
 * On a 401 from GitHub (rotated private key, revoked App, expired JWT
 * due to extreme clock skew) we throw with the underlying error body
 * verbatim so the caller can surface it.
 */
export async function getInstallationToken(args: {
  installationId: number;
  config: GhAppConfig;
  fetcher?: GhAppFetcher;
  now?: number;
}): Promise<{ token: string; expiresAt: number }> {
  const now = args.now ?? Date.now();
  const cached = tokenCache.get(args.installationId);
  if (cached && cached.expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  const fetcher = args.fetcher ?? defaultFetcher;
  const jwt = mintAppJwt(args.config, Math.floor(now / 1000));
  const url = `https://api.github.com/app/installations/${args.installationId}/access_tokens`;

  const res = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chorus-babysit",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `installation token exchange failed: HTTP ${res.status} ${body}`,
    );
  }

  const parsed = (await res.json()) as InstallationTokenResponse;
  if (
    typeof parsed.token !== "string" ||
    typeof parsed.expires_at !== "string"
  ) {
    throw new Error(
      "installation token response missing token/expires_at fields",
    );
  }
  const expiresAt = Date.parse(parsed.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new Error(
      `installation token expires_at not parseable: ${parsed.expires_at}`,
    );
  }

  tokenCache.set(args.installationId, { token: parsed.token, expiresAt });
  return { token: parsed.token, expiresAt };
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
