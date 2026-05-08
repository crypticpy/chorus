/**
 * Tests for the four diff-apply daemon routes:
 *
 *   GET  /chats/:id/audit-items
 *   GET  /chats/:id/orchestrate-manifest
 *   POST /chats/:id/workers/:idx/checkout
 *   POST /chats/:id/workers/:idx/open-pr
 *
 * Strategy:
 *   - Spin a Fastify instance with `registerChatRoutes`, mocking
 *     runner-multiplex (matches `orchestrate-resume.test.ts`).
 *   - Stub HOME so chat-dir reads/writes hit a tmpdir.
 *   - For checkout/open-pr, build a real tmp git repo so `git status`
 *     / `git rev-parse` / `git checkout` are honest. `gh` is exercised
 *     via the real binary path; we don't mock execFile (the routes
 *     bucket failures we can trigger by just not having gh in PATH or
 *     by giving it bogus repos). For "gh succeeds" we'd need to mock
 *     network; the open-pr happy path is therefore covered as a
 *     reasoned failure (gh_not_installed) when PATH is empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";

// Hoisted mock — pin runner-multiplex before importing the registrar so
// the route file doesn't pull in the real runner / tmux / agents stack.
vi.mock("../src/daemon/runner-multiplex", () => ({
  runWithMultiplex: vi.fn(() => ({
    promise: Promise.resolve(),
    subscribers: new Set(),
    abortController: new AbortController(),
  })),
  abortActiveRun: vi.fn(() => false),
  getActiveRun: vi.fn(() => undefined),
  activeRunsSnapshot: vi.fn(() => []),
  activeRunsCount: vi.fn(() => 0),
}));

import {
  _resetDbForTests,
  chats,
  getDb,
  templates as templatesDb,
} from "../src/lib/db";
import { registerChatRoutes } from "../src/daemon/routes/chats";
import type { TmuxManager } from "../src/daemon/tmux-types";
import type { ErrorDetector } from "../src/daemon/error-detector";

const tmuxMgr = {
  acquire: vi.fn(),
  list: vi.fn(() => []),
  kill: vi.fn(),
  sendKeys: vi.fn(),
  pasteBuffer: vi.fn(),
  capturePane: vi.fn(() => ""),
} as unknown as TmuxManager;

const errorDetector = {
  inspect: vi.fn(() => null),
} as unknown as ErrorDetector;

const TEMPLATE_YAML = `
id: audit-test
name: Audit Test
description: Test template with audit + orchestrate phases
agreementThreshold: 0.66
onThresholdMet: ask
maxRounds: 1
phases:
  - id: audit
    kind: audit
    title: Audit
    preset: code-review
    reviewer:
      lineage: anthropic
      models:
        - claude-opus-4-7
    inputs:
      include: []
      exclude: []
  - id: orchestrate
    kind: orchestrate
    title: Workers
    workers:
      - lineage: anthropic
        models:
          - claude-opus-4-7
    branchPrefix: "chorus/{chatId}/worker-{idx}"
    maxConcurrentWorkers: 1
    inputs:
      include: []
      exclude: []
`;

let dbPath: string;
let fakeHome: string;
let realHome: string | undefined;
let fastify: FastifyInstance;

beforeEach(async () => {
  realHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-manifest-"));
  process.env.HOME = fakeHome;
  fs.mkdirSync(path.join(fakeHome, ".chorus", "chats"), { recursive: true });

  dbPath = path.join(os.tmpdir(), `chorus-manifest-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();

  await templatesDb.create("audit-test", TEMPLATE_YAML, "user", true);

  fastify = Fastify({ logger: false });
  registerChatRoutes(fastify, { tmuxMgr, errorDetector });
  await fastify.ready();
});

afterEach(async () => {
  await fastify.close();
  await _resetDbForTests();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort */
    }
  }
  delete process.env.CHORUS_DB_PATH;
  if (realHome) process.env.HOME = realHome;
  else delete process.env.HOME;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** Create a chat with an associated chat dir; optionally write the
 *  audit-output.json + orchestrate-manifest.json sidecars. Returns the
 *  chat id. */
async function makeChat(opts: {
  audit?: { items: string[] };
  manifest?: {
    workers: Array<{
      idx: number;
      itemId: string;
      voiceId: string;
      branch: string;
      diffStat: string;
      status: "completed" | "failed";
      error?: string;
    }>;
  };
  repoPath?: string;
}): Promise<string> {
  const chat = await chats.create({
    work: "test work",
    template_id: "audit-test",
    repo_path: opts.repoPath,
  });
  const chatDir = path.join(fakeHome, ".chorus", "chats", chat.id);
  fs.mkdirSync(chatDir, { recursive: true });
  if (opts.audit) {
    fs.writeFileSync(
      path.join(chatDir, "audit-output.json"),
      JSON.stringify({
        preset: "code-review",
        phaseId: "audit",
        items: opts.audit.items.map((id) => ({
          id,
          summary: `summary-${id}`,
          complexity: "medium",
          files: [],
          rationale: "",
        })),
        generatedAt: Date.now(),
      }),
    );
  }
  if (opts.manifest) {
    fs.writeFileSync(
      path.join(chatDir, "orchestrate-manifest.json"),
      JSON.stringify({
        workers: opts.manifest.workers,
        completedAt: Date.now(),
      }),
    );
  }
  return chat.id;
}

/** Build a real local git repo with a working "main" branch and a
 *  side branch with one commit, so checkout has something real to point
 *  at. Returns the repo path. */
function makeGitRepo(branchName: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-gitrepo-"));
  const opts = { cwd: repo };
  execFileSync("git", ["init", "-q", "-b", "main"], opts);
  // Identity is required for commits; set per-repo so we don't trample
  // any global config.
  execFileSync("git", ["config", "user.email", "test@chorus.local"], opts);
  execFileSync("git", ["config", "user.name", "chorus-test"], opts);
  fs.writeFileSync(path.join(repo, "README.md"), "# baseline\n");
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    ...opts,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });
  execFileSync("git", ["checkout", "-q", "-b", branchName], opts);
  fs.writeFileSync(path.join(repo, "WORKER.md"), "worker did stuff\n");
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-q", "-m", "worker change"], opts);
  execFileSync("git", ["checkout", "-q", "main"], opts);
  return repo;
}

describe("GET /chats/:id/audit-items", () => {
  it("returns 404 when audit-output.json is absent", async () => {
    const id = await makeChat({});
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/${id}/audit-items`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns the parsed items + metadata when present", async () => {
    const id = await makeChat({ audit: { items: ["fix-1", "fix-2"] } });
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/${id}/audit-items`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0].id).toBe("fix-1");
    expect(body.data.preset).toBe("code-review");
    expect(body.data.phaseId).toBe("audit");
    expect(typeof body.data.generatedAt).toBe("number");
  });

  it("returns 400 when audit-output.json is malformed JSON", async () => {
    const id = await makeChat({});
    const chatDir = path.join(fakeHome, ".chorus", "chats", id);
    fs.writeFileSync(path.join(chatDir, "audit-output.json"), "{not json");
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/${id}/audit-items`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid chat id", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/!!!!/audit-items`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /chats/:id/orchestrate-manifest", () => {
  it("returns 404 when orchestrate-manifest.json is absent", async () => {
    const id = await makeChat({});
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/${id}/orchestrate-manifest`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns the parsed manifest when present", async () => {
    const id = await makeChat({
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "claude-opus-4-7",
            branch: `chorus/test/worker-0`,
            diffStat: " a | 1 +\n",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "GET",
      url: `/chats/${id}/orchestrate-manifest`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.workers).toHaveLength(1);
    expect(body.data.workers[0].itemId).toBe("fix-1");
  });
});

describe("POST /chats/:id/workers/:idx/checkout", () => {
  it("404s when manifest is absent", async () => {
    const repo = makeGitRepo("chorus/test/worker-0");
    const id = await makeChat({ repoPath: repo });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(404);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects when chat has no repo_path", async () => {
    const id = await makeChat({
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch: "x",
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/repo_path/);
  });

  it("rejects an out-of-range idx", async () => {
    const repo = makeGitRepo("chorus/test/worker-0");
    const id = await makeChat({
      repoPath: repo,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch: "chorus/test/worker-0",
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/5/checkout`,
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/not in manifest/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects a non-numeric idx", async () => {
    const id = await makeChat({});
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/abc/checkout`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects when worker.status !== 'completed'", async () => {
    const repo = makeGitRepo("chorus/test/worker-0");
    const id = await makeChat({
      repoPath: repo,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch: "chorus/test/worker-0",
            diffStat: "",
            status: "failed",
            error: "timed out",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/not completed/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects on a dirty working tree", async () => {
    const branch = "chorus/test/worker-0";
    const repo = makeGitRepo(branch);
    // Dirty the tree.
    fs.writeFileSync(path.join(repo, "DIRTY.txt"), "uncommitted\n");
    const id = await makeChat({
      repoPath: repo,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch,
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/dirty/);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("returns validation when repo_path no longer resolves (symlink-swap defense)", async () => {
    // Build a real repo, point a symlink at it, persist the symlink as
    // repo_path, then break the link before calling checkout. Without
    // realpath at the route layer, the handler would happily pass the
    // dangling path to `git status` (cwd) and emit a confusing
    // db_error from the shell. With the realpath guard, we get a
    // structured validation error.
    const branch = "chorus/test/worker-0";
    const realRepo = makeGitRepo(branch);
    const symlink = path.join(os.tmpdir(), `chorus-repo-link-${randomUUID()}`);
    fs.symlinkSync(realRepo, symlink);
    const id = await makeChat({
      repoPath: symlink,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch,
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    // Break the symlink — target gone.
    fs.rmSync(realRepo, { recursive: true, force: true });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/repo_path no longer resolves/);
    fs.rmSync(symlink, { force: true });
  });

  it("checks out the worker branch on the happy path", async () => {
    const branch = "chorus/test/worker-0";
    const repo = makeGitRepo(branch);
    const id = await makeChat({
      repoPath: repo,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch,
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/checkout`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.branch).toBe(branch);
    expect(typeof body.data.head).toBe("string");
    expect(body.data.head.length).toBeGreaterThan(0);
    // Verify the repo really moved to that branch.
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
    })
      .toString()
      .trim();
    expect(head).toBe(branch);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("POST /chats/:id/workers/:idx/open-pr", () => {
  it("404s when manifest is absent", async () => {
    const repo = makeGitRepo("chorus/test/worker-0");
    const id = await makeChat({ repoPath: repo });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/open-pr`,
    });
    expect(res.statusCode).toBe(404);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects when chat has no repo_path", async () => {
    const id = await makeChat({
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch: "x",
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/workers/0/open-pr`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/repo_path/);
  });

  it("buckets gh_not_installed when PATH is stripped", async () => {
    const branch = "chorus/test/worker-0";
    const repo = makeGitRepo(branch);
    const id = await makeChat({
      repoPath: repo,
      manifest: {
        workers: [
          {
            idx: 0,
            itemId: "fix-1",
            voiceId: "v",
            branch,
            diffStat: "",
            status: "completed",
          },
        ],
      },
    });
    const realPath = process.env.PATH;
    process.env.PATH = ""; // ensures gh resolves to ENOENT
    try {
      const res = await fastify.inject({
        method: "POST",
        url: `/chats/${id}/workers/0/open-pr`,
      });
      // gh missing → validation, not 500.
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.message).toMatch(/gh CLI not installed/);
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
