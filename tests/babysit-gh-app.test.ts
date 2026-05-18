/**
 * Tests for the GitHub App auth module:
 *
 *   - JWT signing (RS256) — verify against the public key, check claims
 *   - Config load/save round trip
 *   - Installation-token cache: mints on first call, returns cached on
 *     warm call, re-mints when within refresh buffer of expiry
 *   - Error surface: 401 from GitHub bubbles up; missing config returns null
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  _clearTokenCacheForTests,
  GITHUB_APP_PROVIDER,
  type GhAppConfig,
  type GhAppFetcher,
  getInstallationToken,
  loadGhAppConfig,
  mintAppJwt,
  saveGhAppConfig,
} from "../src/daemon/babysit/gh-app";
import { _resetDbForTests, getDb, secrets } from "../src/lib/db";

let dbPath: string;
let testKeys: { privateKey: string; publicKey: string };

function generateRsaKeyPair(): { privateKey: string; publicKey: string } {
  // Real RS256 keys so JWT signature verification is end-to-end honest.
  // 2048 bits is GitHub's minimum; matches the App-generated keys.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-ghapp-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
  _clearTokenCacheForTests();
  testKeys = generateRsaKeyPair();
});

afterEach(async () => {
  await _resetDbForTests();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort */
    }
  }
  delete process.env.CHORUS_DB_PATH;
  _clearTokenCacheForTests();
});

describe("config storage", () => {
  it("returns null when no config row exists", async () => {
    expect(await loadGhAppConfig()).toBeNull();
  });

  it("returns null when the row has a non-gh_app kind", async () => {
    await secrets.set(GITHUB_APP_PROVIDER, "api_key", "not-json");
    expect(await loadGhAppConfig()).toBeNull();
  });

  it("returns null when the stored JSON is malformed", async () => {
    await secrets.set(GITHUB_APP_PROVIDER, "gh_app", "{ not json");
    expect(await loadGhAppConfig()).toBeNull();
  });

  it("returns null when the JSON is missing required fields", async () => {
    await secrets.set(
      GITHUB_APP_PROVIDER,
      "gh_app",
      JSON.stringify({ appId: "123" }), // missing privateKey
    );
    expect(await loadGhAppConfig()).toBeNull();
  });

  it("round-trips a complete config", async () => {
    const config: GhAppConfig = {
      appId: "12345",
      privateKey: testKeys.privateKey,
      webhookSecret: "shh",
    };
    await saveGhAppConfig(config);
    const loaded = await loadGhAppConfig();
    expect(loaded).toEqual(config);
  });

  it("treats missing webhookSecret as empty string", async () => {
    await secrets.set(
      GITHUB_APP_PROVIDER,
      "gh_app",
      JSON.stringify({ appId: "1", privateKey: testKeys.privateKey }),
    );
    const loaded = await loadGhAppConfig();
    expect(loaded?.webhookSecret).toBe("");
  });
});

describe("mintAppJwt", () => {
  it("produces a JWT verifiable with the matching public key", () => {
    const config: GhAppConfig = {
      appId: "999",
      privateKey: testKeys.privateKey,
      webhookSecret: "",
    };
    const jwt = mintAppJwt(config);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64).toBeTruthy();
    expect(payloadB64).toBeTruthy();
    expect(sigB64).toBeTruthy();

    // Verify signature against the public key.
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = Buffer.from(
      sigB64.replace(/-/g, "+").replace(/_/g, "/") +
        "===".slice((sigB64.length + 3) % 4),
      "base64",
    );
    const verified = crypto
      .createVerify("RSA-SHA256")
      .update(signingInput)
      .verify(testKeys.publicKey, sig);
    expect(verified).toBe(true);
  });

  it("backdates iat by 60s to absorb clock skew", () => {
    const config: GhAppConfig = {
      appId: "1",
      privateKey: testKeys.privateKey,
      webhookSecret: "",
    };
    const now = 1_700_000_000;
    const jwt = mintAppJwt(config, now);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf-8"),
    );
    expect(payload.iat).toBe(now - 60);
    expect(payload.iss).toBe("1");
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(11 * 60); // <= 11 min
  });

  it("sets iss to the appId verbatim (so it survives string IDs)", () => {
    const config: GhAppConfig = {
      appId: "Iv1.abc123",
      privateKey: testKeys.privateKey,
      webhookSecret: "",
    };
    const jwt = mintAppJwt(config);
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf-8"),
    );
    expect(payload.iss).toBe("Iv1.abc123");
  });
});

describe("getInstallationToken", () => {
  const config: GhAppConfig = {
    appId: "1",
    privateKey: "", // overwritten in beforeEach
    webhookSecret: "",
  };

  beforeEach(() => {
    config.privateKey = testKeys.privateKey;
  });

  function makeFetcher(
    responses: Array<{
      status: number;
      body: unknown;
    }>,
  ): { fetcher: GhAppFetcher; calls: number } {
    let i = 0;
    const state = { calls: 0 };
    const fetcher: GhAppFetcher = async (_url, _init) => {
      state.calls++;
      const r = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () =>
          typeof r.body === "string" ? r.body : JSON.stringify(r.body),
        json: async () => r.body,
      };
    };
    return { fetcher, calls: state.calls };
  }

  it("mints a fresh token on first call", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { fetcher } = makeFetcher([
      { status: 201, body: { token: "ghs_abc", expires_at: expiresAt } },
    ]);
    const r = await getInstallationToken({
      installationId: 42,
      config,
      fetcher,
    });
    expect(r.token).toBe("ghs_abc");
    expect(r.expiresAt).toBe(Date.parse(expiresAt));
  });

  it("returns cached token on subsequent call (no second mint)", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const state = { calls: 0 };
    const fetcher: GhAppFetcher = async () => {
      state.calls++;
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({ token: "ghs_first", expires_at: expiresAt }),
      };
    };
    await getInstallationToken({ installationId: 1, config, fetcher });
    const second = await getInstallationToken({
      installationId: 1,
      config,
      fetcher,
    });
    expect(second.token).toBe("ghs_first");
    expect(state.calls).toBe(1);
  });

  it("re-mints when cached token is within 5 minutes of expiry", async () => {
    const now = Date.now();
    // Cached token expires in 2 min — inside the 5-min refresh buffer.
    const cachedExpiry = new Date(now + 2 * 60 * 1000).toISOString();
    const freshExpiry = new Date(now + 60 * 60 * 1000).toISOString();
    let call = 0;
    const fetcher: GhAppFetcher = async () => {
      call++;
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({
          token: `ghs_${call}`,
          expires_at: call === 1 ? cachedExpiry : freshExpiry,
        }),
      };
    };
    const first = await getInstallationToken({
      installationId: 7,
      config,
      fetcher,
      now,
    });
    expect(first.token).toBe("ghs_1");
    const second = await getInstallationToken({
      installationId: 7,
      config,
      fetcher,
      now,
    });
    expect(second.token).toBe("ghs_2");
    expect(call).toBe(2);
  });

  it("keeps separate cache entries per installationId", async () => {
    const fresh = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let call = 0;
    const fetcher: GhAppFetcher = async () => {
      call++;
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({ token: `ghs_${call}`, expires_at: fresh }),
      };
    };
    const a = await getInstallationToken({
      installationId: 1,
      config,
      fetcher,
    });
    const b = await getInstallationToken({
      installationId: 2,
      config,
      fetcher,
    });
    expect(a.token).toBe("ghs_1");
    expect(b.token).toBe("ghs_2");
    expect(call).toBe(2);
  });

  it("throws on a 401 from GitHub with the body in the message", async () => {
    const fetcher: GhAppFetcher = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"message":"Bad credentials"}',
      json: async () => ({ message: "Bad credentials" }),
    });
    await expect(
      getInstallationToken({ installationId: 1, config, fetcher }),
    ).rejects.toThrow(/HTTP 401.*Bad credentials/);
  });

  it("throws when the response is missing token/expires_at", async () => {
    const fetcher: GhAppFetcher = async () => ({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ wrong: "shape" }),
    });
    await expect(
      getInstallationToken({ installationId: 1, config, fetcher }),
    ).rejects.toThrow(/missing token\/expires_at/);
  });

  it("sends an Authorization: Bearer <jwt> header", async () => {
    const captured: { headers?: Record<string, string> } = {};
    const fetcher: GhAppFetcher = async (_url, init) => {
      captured.headers = init.headers;
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({
          token: "x",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      };
    };
    await getInstallationToken({ installationId: 99, config, fetcher });
    expect(captured.headers?.Authorization).toMatch(
      /^Bearer eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(captured.headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("hits the right URL for the installation ID", async () => {
    let observedUrl = "";
    const fetcher: GhAppFetcher = async (url, _init) => {
      observedUrl = url;
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({
          token: "x",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      };
    };
    await getInstallationToken({ installationId: 12345, config, fetcher });
    expect(observedUrl).toBe(
      "https://api.github.com/app/installations/12345/access_tokens",
    );
  });
});

describe("saveGhAppConfig", () => {
  it("clears the token cache so a rotated key doesn't serve stale tokens", async () => {
    const cfg: GhAppConfig = {
      appId: "1",
      privateKey: testKeys.privateKey,
      webhookSecret: "",
    };
    // Seed cache
    const fetcher: GhAppFetcher = async () => ({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        token: "stale",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    await getInstallationToken({ installationId: 1, config: cfg, fetcher });
    // Rotate key
    const newKeys = generateRsaKeyPair();
    await saveGhAppConfig({ ...cfg, privateKey: newKeys.privateKey });
    // Next call must re-mint, not return "stale".
    let returnedToken = "";
    const fresh: GhAppFetcher = async () => ({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        token: "fresh-after-rotate",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    const r = await getInstallationToken({
      installationId: 1,
      config: { ...cfg, privateKey: newKeys.privateKey },
      fetcher: fresh,
    });
    returnedToken = r.token;
    expect(returnedToken).toBe("fresh-after-rotate");
  });
});
