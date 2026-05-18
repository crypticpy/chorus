/**
 * Tests for the App-vs-CLI routing GitHub client.
 *
 * Auth selection is the most failure-prone bit, so the tests are
 * organized around the routing table:
 *
 *   installationId yes + config yes → App
 *   installationId yes + config no  → CLI
 *   installationId no  + config yes → CLI
 *   installationId no  + config no  → CLI
 *
 * On top of that we cover:
 *   - 401 → token-cache wipe → one retry
 *   - 5xx → one transparent backoff retry
 *   - 4xx (not 401) → no retry
 *   - body serialization on App path
 *   - bodies on CLI path → typed error (limitation, surfaced loudly)
 *   - status extraction from gh stderr on CLI failures
 */
import * as crypto from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearTokenCacheForTests,
  type GhAppConfig,
  type GhAppFetcher,
} from "../src/daemon/babysit/gh-app";
import { ghRequest } from "../src/daemon/babysit/gh-client";

let testConfig: GhAppConfig;

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  testConfig = { appId: "12345", privateKey, webhookSecret: "wh" };
  _clearTokenCacheForTests();
});

/** Build a fetcher that returns a scripted sequence of responses.
 *  Token-exchange responses are recognised by URL and served from a
 *  separate counter — callers script the *API* responses only. */
function scriptedFetcher(
  apiResponses: Array<{ ok: boolean; status: number; body: string }>,
): {
  fetcher: GhAppFetcher;
  apiCalls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string };
  }>;
} {
  let apiIdx = 0;
  let tokenIdx = 0;
  const apiCalls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string };
  }> = [];
  const fetcher: GhAppFetcher = async (url, init) => {
    if (url.includes("/app/installations/") && url.endsWith("/access_tokens")) {
      tokenIdx += 1;
      const body = JSON.stringify({
        token: `tok-${tokenIdx}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return {
        ok: true,
        status: 201,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }
    const next = apiResponses[apiIdx++];
    if (!next)
      throw new Error(
        `fetcher ran out of scripted responses at call ${apiIdx}`,
      );
    apiCalls.push({
      url,
      init: init as {
        method: string;
        headers: Record<string, string>;
        body?: string;
      },
    });
    return {
      ok: next.ok,
      status: next.status,
      text: async () => next.body,
      json: async () => JSON.parse(next.body),
    };
  };
  return { fetcher, apiCalls };
}

describe("ghRequest — auth routing", () => {
  it("uses App auth when installationId + config are both present", async () => {
    const { fetcher, apiCalls } = scriptedFetcher([
      { ok: true, status: 200, body: '{"id":7}' },
    ]);
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r/pulls/7",
        cwd: "/tmp/anywhere",
        installationId: 999,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(true);
    expect(res.authMode).toBe("app");
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.url).toBe("https://api.github.com/repos/o/r/pulls/7");
    expect(apiCalls[0]!.init.headers.Authorization).toMatch(/^Bearer tok-/);
  });

  it("falls back to gh CLI when installationId is absent", async () => {
    let calledWith: { args: string[]; cwd: string } | null = null;
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r/pulls/7",
        cwd: "/tmp/wt",
      },
      {
        loadConfig: async () => testConfig,
        runCli: async (_cmd, args, opts) => {
          calledWith = { args, cwd: opts.cwd };
          return { ok: true, stdout: '{"id":7}', stderr: "", code: 0 };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.authMode).toBe("cli");
    expect(calledWith).toEqual({
      args: ["api", "--method", "GET", "repos/o/r/pulls/7"],
      cwd: "/tmp/wt",
    });
  });

  it("falls back to gh CLI when installationId is set but App config is missing", async () => {
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r/pulls/7",
        cwd: "/tmp/wt",
        installationId: 999,
      },
      {
        loadConfig: async () => null,
        runCli: async () => ({ ok: true, stdout: "{}", stderr: "", code: 0 }),
      },
    );
    expect(res.authMode).toBe("cli");
  });

  it("strips a leading slash from the path on both paths", async () => {
    // App path
    const app = scriptedFetcher([{ ok: true, status: 200, body: "{}" }]);
    await ghRequest(
      { method: "GET", path: "/repos/o/r", cwd: "/tmp", installationId: 1 },
      { loadConfig: async () => testConfig, fetcher: app.fetcher },
    );
    expect(app.apiCalls[0]!.url).toBe("https://api.github.com/repos/o/r");

    // CLI path
    let cliArgs: string[] = [];
    await ghRequest(
      { method: "GET", path: "/repos/o/r", cwd: "/tmp" },
      {
        loadConfig: async () => null,
        runCli: async (_c, a) => {
          cliArgs = a;
          return { ok: true, stdout: "{}", stderr: "", code: 0 };
        },
      },
    );
    expect(cliArgs[cliArgs.length - 1]).toBe("repos/o/r");
  });
});

describe("ghRequest — App-path retries", () => {
  it("retries once on 401 after wiping the token cache", async () => {
    // First call 401, second succeeds with a different token
    const { fetcher, apiCalls } = scriptedFetcher([
      { ok: false, status: 401, body: '{"message":"Bad credentials"}' },
      { ok: true, status: 200, body: "{}" },
    ]);
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r",
        cwd: "/tmp",
        installationId: 999,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(true);
    expect(apiCalls).toHaveLength(2);
    // Second call should carry a freshly-minted token, distinct from
    // the first (since the cache was cleared between calls).
    const tok1 = apiCalls[0]!.init.headers.Authorization;
    const tok2 = apiCalls[1]!.init.headers.Authorization;
    expect(tok1).not.toBe(tok2);
  });

  it("surfaces a second 401 as an error after the single retry", async () => {
    const { fetcher } = scriptedFetcher([
      { ok: false, status: 401, body: '{"message":"Bad credentials"}' },
      { ok: false, status: 401, body: '{"message":"Bad credentials"}' },
    ]);
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r",
        cwd: "/tmp",
        installationId: 999,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it("retries once on 502 with backoff", async () => {
    const { fetcher, apiCalls } = scriptedFetcher([
      { ok: false, status: 502, body: "bad gateway" },
      { ok: true, status: 200, body: "{}" },
    ]);
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r",
        cwd: "/tmp",
        installationId: 999,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(true);
    expect(apiCalls).toHaveLength(2);
  });

  it("does NOT retry on 4xx that isn't 401 (e.g. 422 validation)", async () => {
    const { fetcher, apiCalls } = scriptedFetcher([
      { ok: false, status: 422, body: '{"message":"Validation failed"}' },
    ]);
    const res = await ghRequest(
      {
        method: "POST",
        path: "repos/o/r/issues/1/comments",
        body: { body: "hi" },
        cwd: "/tmp",
        installationId: 999,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
    expect(apiCalls).toHaveLength(1);
  });
});

describe("ghRequest — body handling", () => {
  it("serializes JSON body + adds Content-Type on the App path", async () => {
    const { fetcher, apiCalls } = scriptedFetcher([
      { ok: true, status: 201, body: '{"id":99}' },
    ]);
    await ghRequest(
      {
        method: "POST",
        path: "repos/o/r/issues/1/comments",
        body: { body: "thanks bot" },
        cwd: "/tmp",
        installationId: 1,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(apiCalls[0]!.init.method).toBe("POST");
    expect(apiCalls[0]!.init.headers["Content-Type"]).toBe("application/json");
    expect(apiCalls[0]!.init.body).toBe(JSON.stringify({ body: "thanks bot" }));
  });

  it("returns null body for 204 No Content on the App path", async () => {
    const { fetcher } = scriptedFetcher([{ ok: true, status: 204, body: "" }]);
    const res = await ghRequest(
      {
        method: "DELETE",
        path: "repos/o/r/issues/comments/99",
        cwd: "/tmp",
        installationId: 1,
      },
      { loadConfig: async () => testConfig, fetcher },
    );
    expect(res.ok).toBe(true);
    expect((res as { body: unknown }).body).toBeNull();
  });

  it("returns a typed error when the CLI path is asked to send a body", async () => {
    const res = await ghRequest(
      {
        method: "POST",
        path: "repos/o/r/issues/1/comments",
        body: { body: "hi" },
        cwd: "/tmp",
      },
      {
        loadConfig: async () => null,
        runCli: async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.authMode).toBe("cli");
    expect((res as { errorText: string }).errorText).toMatch(
      /does not support request bodies/,
    );
  });
});

describe("ghRequest — CLI error parsing", () => {
  it("extracts HTTP status from gh stderr 'HTTP 404' line", async () => {
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r/pulls/9999",
        cwd: "/tmp",
      },
      {
        loadConfig: async () => null,
        runCli: async () => ({
          ok: false,
          stdout: "",
          stderr:
            "HTTP 404: Not Found (https://api.github.com/repos/o/r/pulls/9999)",
          code: 1,
        }),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect((res as { errorText: string }).errorText).toContain("HTTP 404");
  });

  it("returns status=0 when gh stderr doesn't carry an HTTP line", async () => {
    const res = await ghRequest(
      {
        method: "GET",
        path: "repos/o/r",
        cwd: "/tmp",
      },
      {
        loadConfig: async () => null,
        runCli: async () => ({
          ok: false,
          stdout: "",
          stderr: "gh: command not found",
          code: 127,
        }),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });
});
