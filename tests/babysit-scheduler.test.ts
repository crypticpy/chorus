/**
 * Tests for BabysitScheduler.
 *
 * Coverage hits the three concurrency invariants we care about:
 *   1. Per-job serialization (same id never has two ticks in flight)
 *   2. Bounded global concurrency (never more than maxConcurrent at once)
 *   3. Clean drain on stop() — no orphaned in-flight work
 *
 * Plus the routine behaviours: filter non-dispatchable, skip in-flight,
 * idempotent start, logger callbacks.
 *
 * The runJob is a Promise-deferred stub so each test can hold a tick
 * mid-execution and assert intermediate state.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetDbForTests, babysitJobs, getDb } from "../src/lib/db";
import {
  BabysitScheduler,
  type SchedulerLogger,
} from "../src/daemon/babysit/scheduler";
import type { BabysitJob } from "../src/lib/db/babysit-jobs";

let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-sched-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
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
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}
function defer(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BabysitScheduler.tickOnce", () => {
  it("dispatches all eligible jobs up to maxConcurrent", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    await babysitJobs.create({ repo: "o/c", pr_number: 3 });

    const calls: string[] = [];
    const hold = defer();
    const sched = new BabysitScheduler({
      maxConcurrent: 2,
      runJob: async (job) => {
        calls.push(job.id);
        await hold.promise;
      },
    });

    const { dispatched } = await sched.tickOnce();
    expect(dispatched).toHaveLength(2);
    expect(sched.inFlightCount()).toBe(2);

    hold.resolve();
    await sched.waitForIdle();
    expect(calls).toHaveLength(2);
  });

  it("never dispatches the same job twice if a previous tick is still in flight", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });

    const calls: string[] = [];
    const hold = defer();
    const sched = new BabysitScheduler({
      maxConcurrent: 3,
      runJob: async (job) => {
        calls.push(job.id);
        await hold.promise;
      },
    });

    const t1 = await sched.tickOnce();
    expect(t1.dispatched).toEqual(["o/a#1"]);

    // Second tick while the first is still in flight — should be a no-op.
    const t2 = await sched.tickOnce();
    expect(t2.dispatched).toEqual([]);
    expect(sched.inFlightCount()).toBe(1);

    hold.resolve();
    await sched.waitForIdle();
    expect(calls).toHaveLength(1);
  });

  it("skips jobs in terminal/paused states", async () => {
    const j1 = await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    const j2 = await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    const j3 = await babysitJobs.create({ repo: "o/c", pr_number: 3 });
    await babysitJobs.setState(j1.id, "merged");
    await babysitJobs.setState(j2.id, "escalated");
    // j3 stays idle

    const dispatchedIds: string[] = [];
    const sched = new BabysitScheduler({
      maxConcurrent: 5,
      runJob: async (job) => {
        dispatchedIds.push(job.id);
      },
    });

    await sched.tickOnce();
    await sched.waitForIdle();
    expect(dispatchedIds).toEqual([j3.id]);
  });

  it("skips paused jobs without consuming a slot", async () => {
    const j1 = await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    const j2 = await babysitJobs.create({ repo: "o/b", pr_number: 2 });
    await babysitJobs.setState(j1.id, "paused");

    const dispatched: string[] = [];
    const sched = new BabysitScheduler({
      maxConcurrent: 1,
      runJob: async (job) => {
        dispatched.push(job.id);
      },
    });

    await sched.tickOnce();
    await sched.waitForIdle();
    expect(dispatched).toEqual([j2.id]);
  });

  it("respects maxConcurrent strictly across overlapping job durations", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await babysitJobs.create({ repo: "o/r", pr_number: i + 1 });
      ids.push(job.id);
    }

    const inFlight = new Set<string>();
    let peak = 0;
    const holds: Deferred[] = ids.map(() => defer());
    const sched = new BabysitScheduler({
      maxConcurrent: 2,
      runJob: async (job) => {
        inFlight.add(job.id);
        peak = Math.max(peak, inFlight.size);
        const idx = ids.indexOf(job.id);
        await holds[idx]!.promise;
        inFlight.delete(job.id);
      },
    });

    // First tick fills both slots.
    await sched.tickOnce();
    expect(sched.inFlightCount()).toBe(2);

    // Second tick while both are still running — should add nothing.
    await sched.tickOnce();
    expect(sched.inFlightCount()).toBe(2);

    // Release one; next tick should fill the freed slot.
    holds[0]!.resolve();
    // Yield so the .finally bookkeeping runs.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await sched.tickOnce();
    expect(sched.inFlightCount()).toBe(2);

    // Release the rest.
    for (const h of holds) h.resolve();
    await sched.waitForIdle();
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("BabysitScheduler error isolation", () => {
  it("swallows + logs errors from runJob without poisoning the scheduler", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });
    await babysitJobs.create({ repo: "o/b", pr_number: 2 });

    const errors: Array<{ id: string; err: unknown }> = [];
    const succeeded: string[] = [];
    const logger: SchedulerLogger = {
      tickStart: () => {},
      jobStart: () => {},
      jobEnd: () => {},
      jobError: (id, err) => errors.push({ id, err }),
    };
    const sched = new BabysitScheduler({
      maxConcurrent: 5,
      logger,
      runJob: async (job: BabysitJob) => {
        if (job.id === "o/a#1") throw new Error("boom");
        succeeded.push(job.id);
      },
    });

    await sched.tickOnce();
    await sched.waitForIdle();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe("o/a#1");
    expect(succeeded).toEqual(["o/b#2"]);
    expect(sched.inFlightCount()).toBe(0);
  });

  it("releases the mutex even when runJob throws (job stays dispatchable next tick)", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });

    let calls = 0;
    const sched = new BabysitScheduler({
      maxConcurrent: 1,
      runJob: async () => {
        calls += 1;
        throw new Error("transient");
      },
    });

    await sched.tickOnce();
    await sched.waitForIdle();
    expect(sched.inFlightCount()).toBe(0);

    await sched.tickOnce();
    await sched.waitForIdle();
    expect(calls).toBe(2);
  });
});

describe("BabysitScheduler lifecycle", () => {
  it("start() is idempotent", () => {
    const sched = new BabysitScheduler({
      runJob: async () => {},
    });
    sched.start();
    sched.start();
    // No throw, no second interval — we can't observe the second
    // interval directly, but stop() drains cleanly which is the
    // observable contract.
    return sched.stop();
  });

  it("stop() awaits in-flight jobs before resolving", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });

    const hold = defer();
    let finished = false;
    const sched = new BabysitScheduler({
      maxConcurrent: 1,
      runJob: async () => {
        await hold.promise;
        finished = true;
      },
    });

    await sched.tickOnce();
    expect(sched.inFlightCount()).toBe(1);

    const stopPromise = sched.stop();
    // Resolve after a delay so we can prove stop() waited.
    setTimeout(() => hold.resolve(), 20);
    await stopPromise;
    expect(finished).toBe(true);
  });

  it("stop() prevents further dispatches", async () => {
    await babysitJobs.create({ repo: "o/a", pr_number: 1 });

    let calls = 0;
    const sched = new BabysitScheduler({
      maxConcurrent: 5,
      runJob: async () => {
        calls += 1;
      },
    });

    await sched.stop();
    const { dispatched } = await sched.tickOnce();
    expect(dispatched).toEqual([]);
    expect(calls).toBe(0);
  });
});
