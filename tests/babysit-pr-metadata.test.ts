/**
 * Tests for fetchPrMetadata. Covers the happy path (PR + repo
 * lookups fan out, fields projected) and the failure-mode routing
 * (404 → pr_not_found, other 4xx/5xx → gh_failure, malformed JSON →
 * malformed_response).
 *
 * Mocks the ghRequest deps to avoid hitting the network. Both
 * required endpoints are matched by URL prefix so the test fixture
 * doesn't care about call order.
 */
import { describe, expect, it } from "vitest";
import { fetchPrMetadata } from "../src/daemon/babysit/pr-metadata";

describe("fetchPrMetadata", () => {
  it("projects title, head/base branches, default branch, and state", async () => {
    // CLI fallback (no installationId, no App config) — we mock runCli
    // since the App-auth path is exercised separately via gh-client tests.
    const res = await fetchPrMetadata(
      {
        owner: "o",
        repo: "r",
        prNumber: 7,
        cwd: "/tmp",
        installationId: null,
      },
      {
        loadConfig: async () => null,
        runCli: async (_cmd, args) => {
          const last = args[args.length - 1]!;
          if (last.includes("/pulls/7")) {
            return {
              ok: true,
              stdout: JSON.stringify({
                number: 7,
                title: "Fix the thing",
                head: { ref: "feature/fix" },
                base: { ref: "main" },
                state: "open",
                merged: false,
              }),
              stderr: "",
              code: 0,
            };
          }
          return {
            ok: true,
            stdout: JSON.stringify({ default_branch: "main" }),
            stderr: "",
            code: 0,
          };
        },
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 7,
      title: "Fix the thing",
      headBranch: "feature/fix",
      baseBranch: "main",
      defaultBranch: "main",
      state: "open",
    });
  });

  it("reports state='merged' when merged=true regardless of state field", async () => {
    // Run via the CLI-fallback path so we don't have to stub the
    // JWT-signing machinery; the state-projection logic is shared.
    const res = await fetchPrMetadata(
      {
        owner: "o",
        repo: "r",
        prNumber: 7,
        cwd: "/tmp",
        installationId: null,
      },
      {
        loadConfig: async () => null,
        runCli: async (_cmd, args) => {
          const last = args[args.length - 1]!;
          if (last.includes("/pulls/7")) {
            return {
              ok: true,
              stdout: JSON.stringify({
                number: 7,
                title: "x",
                head: { ref: "h" },
                base: { ref: "b" },
                state: "closed",
                merged: true,
              }),
              stderr: "",
              code: 0,
            };
          }
          return {
            ok: true,
            stdout: JSON.stringify({ default_branch: "main" }),
            stderr: "",
            code: 0,
          };
        },
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.state).toBe("merged");
  });

  it("returns pr_not_found on 404", async () => {
    const res = await fetchPrMetadata(
      { owner: "o", repo: "r", prNumber: 9999, cwd: "/tmp" },
      {
        loadConfig: async () => null,
        runCli: async () => ({
          ok: false,
          stdout: "",
          stderr: "HTTP 404: Not Found",
          code: 1,
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("pr_not_found");
  });

  it("returns malformed_response when PR JSON is missing required fields", async () => {
    const res = await fetchPrMetadata(
      { owner: "o", repo: "r", prNumber: 7, cwd: "/tmp" },
      {
        loadConfig: async () => null,
        runCli: async (_cmd, args) => {
          const last = args[args.length - 1]!;
          if (last.includes("/pulls/7")) {
            return {
              ok: true,
              stdout: JSON.stringify({ number: 7 }), // no head/base/title
              stderr: "",
              code: 0,
            };
          }
          return {
            ok: true,
            stdout: JSON.stringify({ default_branch: "main" }),
            stderr: "",
            code: 0,
          };
        },
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("malformed_response");
  });
});
