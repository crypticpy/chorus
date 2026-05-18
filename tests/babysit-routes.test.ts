/**
 * Tests for the Phase A babysit daemon routes:
 *
 *   POST /babysit/jobs       — register / idempotent re-register
 *   GET  /babysit/jobs       — list (with state + active filters)
 *   GET  /babysit/jobs/:id   — single job + recent decisions
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";

import {
  _resetDbForTests,
  babysitDecisions,
  babysitJobs,
  getDb,
} from "../src/lib/db";
import { registerBabysitRoutes } from "../src/daemon/routes/babysit";

let dbPath: string;
let fastify: FastifyInstance;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-babysit-route-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();

  fastify = Fastify({ logger: false });
  registerBabysitRoutes(fastify);
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
});

describe("POST /babysit/jobs", () => {
  it("creates a new idle job for a valid PR URL", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: { url: "https://github.com/anthropics/claude-code/pull/42" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.created).toBe(true);
    expect(body.data.job.id).toBe("anthropics/claude-code#42");
    expect(body.data.job.state).toBe("idle");
    expect(body.data.job.repo).toBe("anthropics/claude-code");
    expect(body.data.job.pr_number).toBe(42);
  });

  it("is idempotent — second call returns existing job with created=false", async () => {
    const first = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: { url: "https://github.com/o/r/pull/1" },
    });
    expect(first.json().data.created).toBe(true);

    // Mutate the job state — the idempotent path must not reset it.
    await babysitJobs.setState("o/r#1", "judging");

    const second = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: { url: "https://github.com/o/r/pull/1" },
    });
    const body = second.json();
    expect(body.data.created).toBe(false);
    expect(body.data.job.state).toBe("judging");
  });

  it("rejects when url is missing", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation");
  });

  it("rejects when url is not a GitHub PR URL", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: { url: "https://example.com/foo/bar" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("GitHub PR URL");
  });

  it("rejects when url points to an issue, not a PR", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: { url: "https://github.com/o/r/issues/1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists installationId when supplied", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: {
        url: "https://github.com/o/r/pull/7",
        installationId: 12345,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.installation_id).toBe(12345);
  });

  it("treats a non-numeric installationId as null", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/babysit/jobs",
      payload: {
        url: "https://github.com/o/r/pull/8",
        installationId: "not-a-number" as unknown as number,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.installation_id).toBeNull();
  });
});

describe("GET /babysit/jobs", () => {
  it("returns empty list when no jobs exist", async () => {
    const res = await fastify.inject({ method: "GET", url: "/babysit/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ items: [], total: 0 });
  });

  it("returns all jobs by default, newest-first", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    const res = await fastify.inject({ method: "GET", url: "/babysit/jobs" });
    const body = res.json();
    expect(body.data.total).toBe(2);
    expect(body.data.items.map((j: { id: string }) => j.id)).toEqual([
      "o/b#2",
      "o/a#1",
    ]);
  });

  it("filters by ?active=true", async () => {
    const a = await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    await babysitJobs.setState(a.id, "merged");
    const res = await fastify.inject({
      method: "GET",
      url: "/babysit/jobs?active=true",
    });
    const ids = res.json().data.items.map((j: { id: string }) => j.id);
    expect(ids).toEqual(["o/b#2"]);
  });

  it("filters by ?state=judging", async () => {
    const a = await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    await babysitJobs.setState(a.id, "judging");
    const res = await fastify.inject({
      method: "GET",
      url: "/babysit/jobs?state=judging",
    });
    expect(res.json().data.total).toBe(1);
    expect(res.json().data.items[0].id).toBe("o/a#1");
  });
});

describe("PATCH /babysit/jobs/:id", () => {
  it("pauses an active job (idle → paused)", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "pause" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.job.state).toBe("paused");
  });

  it("is idempotent when pausing an already-paused job", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "paused");
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "pause" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.state).toBe("paused");
  });

  it("resumes a paused job (paused → idle) and clears ended_at", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "paused");
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "resume" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.state).toBe("idle");
    expect(res.json().data.job.ended_at).toBeNull();
  });

  it("rejects pause on a terminal (merged) job with conflict", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "merged");
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "pause" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });

  it("rejects pause on a terminal (escalated) job with conflict", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitJobs.setState(job.id, "escalated");
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "pause" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects resume on a non-paused job with conflict", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "resume" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("paused");
  });

  it("rejects unknown actions with validation", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    const res = await fastify.inject({
      method: "PATCH",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
      payload: { action: "cancel" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation");
  });

  it("returns 404 when patching an unknown job", async () => {
    const res = await fastify.inject({
      method: "PATCH",
      url: "/babysit/jobs/missing%23999",
      payload: { action: "pause" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /babysit/jobs/:id", () => {
  it("returns 404 for an unknown job", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/babysit/jobs/missing%23999",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns job + decision list in chronological order", async () => {
    const job = await babysitJobs.create({ repo: "o/r", pr_number: 1 });
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 1,
      comment_author: "coderabbitai[bot]",
      comment_hash: "a".repeat(64),
      bot: "coderabbit",
      validity: "valid",
      category: "apply-trivial",
      confidence: 0.9,
      judge_model: "claude-haiku-4-5",
    });
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: 2,
      comment_author: "sourcery-ai[bot]",
      comment_hash: "b".repeat(64),
      bot: "sourcery",
      validity: "invalid",
      category: "reply-disagree",
      confidence: 0.8,
      judge_model: "claude-haiku-4-5",
    });

    const res = await fastify.inject({
      method: "GET",
      url: `/babysit/jobs/${encodeURIComponent(job.id)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.job.id).toBe(job.id);
    expect(body.decisions).toHaveLength(2);
    expect(body.decisions[0].comment_id).toBe(1);
    expect(body.decisions[0].bot).toBe("coderabbit");
    expect(body.decisions[1].comment_id).toBe(2);
  });
});
