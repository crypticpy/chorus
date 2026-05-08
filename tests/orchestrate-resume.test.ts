/**
 * Tests for POST /chats/:id/resume — the audit→orchestrate handoff.
 *
 * Validation surface:
 *   - chat must be `blocked` (anything else → validation error)
 *   - body.answer must be JSON-encoded `string[]`
 *   - every selected id must exist in `<chatDir>/audit-output.json`
 *
 * Side effects on success:
 *   - persists `<chatDir>/audit-selected-ids.json`
 *   - flips chat row to status='drafting' + current_phase_idx=<orchestrate-idx>
 *   - re-fires the runner (mocked here so we don't actually spawn workers)
 *
 * The runner-multiplex re-fire is mocked via vi.mock so the test stays
 * a pure HTTP/DB exercise — no subprocesses, no LLM calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";

// IMPORTANT: vi.mock is hoisted — declare mocks BEFORE importing the
// route registrar, otherwise the real runWithMultiplex pulls in the
// runner (and through it tmux + agents). Stubbing returns a minimal
// activeRun-shaped object so the route can call .promise.catch() safely.
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

// Lazy-import after mock so the registrar picks up the stub.
import {
  _resetDbForTests,
  chats,
  getDb,
  templates as templatesDb,
} from "../src/lib/db";
import { registerChatRoutes } from "../src/daemon/routes/chats";
import type { TmuxManager } from "../src/daemon/tmux-types";
import type { ErrorDetector } from "../src/daemon/error-detector";

// Stubs for the runtime args registerChatRoutes wants. The resume handler
// only ever passes them through to runWithMultiplex (which we mock).
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
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-resume-"));
  process.env.HOME = fakeHome;
  fs.mkdirSync(path.join(fakeHome, ".chorus", "chats"), { recursive: true });

  dbPath = path.join(os.tmpdir(), `chorus-resume-${randomUUID()}.db`);
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

/** Create a chat in `blocked` state with an audit-output.json on disk
 *  carrying the given item ids. */
async function makeBlockedChatWithAudit(itemIds: string[]): Promise<string> {
  const chat = await chats.create({
    work: "test work",
    template_id: "audit-test",
    repo_path: "/tmp/fake-repo",
  });
  await chats.update(chat.id, { status: "blocked" });

  const chatDir = path.join(fakeHome, ".chorus", "chats", chat.id);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "audit-output.json"),
    JSON.stringify({
      preset: "code-review",
      phaseId: "audit",
      items: itemIds.map((id) => ({
        id,
        summary: `summary-${id}`,
        complexity: "medium",
        files: [],
        rationale: "",
      })),
      generatedAt: Date.now(),
    }),
  );
  return chat.id;
}

describe("POST /chats/:id/resume — validation", () => {
  it("rejects when chat is not blocked", async () => {
    const chat = await chats.create({
      work: "w",
      template_id: "audit-test",
    });
    // chat.status defaults to 'drafting'
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${chat.id}/resume`,
      payload: { answer: JSON.stringify([]) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toMatch(/not blocked/);
  });

  it("rejects when chat does not exist", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/01HQQH8QZA5JGPNXWQX5J8YK00/resume`,
      payload: { answer: JSON.stringify([]) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an empty answer string", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: "" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("validation");
  });

  it("rejects when answer is not JSON", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: "not-json-at-all" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/not valid JSON/);
  });

  it("rejects when answer parses to a non-array", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: JSON.stringify({ ids: ["fix-1"] }) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/array of strings/);
  });

  it("rejects when answer parses to an array with non-string entries", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: JSON.stringify(["fix-1", 42]) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/array of strings/);
  });

  it("rejects when a selected id is not in audit-output.json", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1", "fix-2"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: JSON.stringify(["fix-1", "fix-bogus"]) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/unknown audit item ids/);
    expect(body.error.message).toMatch(/fix-bogus/);
  });

  it("rejects when audit-output.json is missing", async () => {
    const chat = await chats.create({
      work: "w",
      template_id: "audit-test",
    });
    await chats.update(chat.id, { status: "blocked" });
    // Deliberately do NOT create audit-output.json.
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${chat.id}/resume`,
      payload: { answer: JSON.stringify(["whatever"]) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/audit-output\.json/);
  });
});

describe("POST /chats/:id/resume — happy path", () => {
  it("persists selected ids, flips status, sets phase idx, re-fires runner", async () => {
    const id = await makeBlockedChatWithAudit(["fix-1", "fix-2", "fix-3"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: JSON.stringify(["fix-1", "fix-3"]) },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    // Status flipped to drafting; phase idx points at orchestrate (idx 1).
    expect(body.data.status).toBe("drafting");
    expect(body.data.current_phase_idx).toBe(1);

    // audit-selected-ids.json was written.
    const selectedPath = path.join(
      fakeHome,
      ".chorus",
      "chats",
      id,
      "audit-selected-ids.json",
    );
    const persisted = JSON.parse(fs.readFileSync(selectedPath, "utf-8"));
    expect(persisted.ids).toEqual(["fix-1", "fix-3"]);
    expect(typeof persisted.submittedAt).toBe("number");

    // Runner was re-fired exactly once.
    const { runWithMultiplex } = await import("../src/daemon/runner-multiplex");
    expect(runWithMultiplex).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty selection (user trimmed everything)", async () => {
    // Edge case: user opens checklist, deselects every item, hits
    // approve. The body validator only requires a parseable string[];
    // the orchestrate phase will simply find no items to dispatch.
    const id = await makeBlockedChatWithAudit(["fix-1"]);
    const res = await fastify.inject({
      method: "POST",
      url: `/chats/${id}/resume`,
      payload: { answer: JSON.stringify([]) },
    });
    expect(res.statusCode).toBe(200);

    const selectedPath = path.join(
      fakeHome,
      ".chorus",
      "chats",
      id,
      "audit-selected-ids.json",
    );
    const persisted = JSON.parse(fs.readFileSync(selectedPath, "utf-8"));
    expect(persisted.ids).toEqual([]);
  });
});
