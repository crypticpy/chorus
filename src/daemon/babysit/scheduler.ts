/**
 * Bounded-concurrency scheduler for the PR-babysit loop.
 *
 * One tick driver (setInterval) wakes up every `intervalMs` and walks
 * active babysit jobs, dispatching at most `maxConcurrent` of them to
 * the per-job runner at any time. The same job never has two ticks
 * in flight (a per-id Set acts as a mutex), and jobs in terminal
 * states are skipped without consuming a slot.
 *
 * Why this shape — concurrency invariants we need:
 *
 *   1. **Per-job serialization.** Two concurrent ticks on the same
 *      job race over the worktree, the babysit_decisions table, and
 *      the bot-reply outgoing comment. The `inFlight` Set, checked-
 *      and-set atomically (Node is single-threaded so `has`/`add` are
 *      effectively atomic with no awaits between them), prevents this.
 *   2. **Bounded global concurrency.** Each in-flight job holds
 *      potentially one judge model token + one doer model token +
 *      one worktree on disk + one open gh API connection. With
 *      `maxConcurrent` jobs at once we cap the resource pressure
 *      predictably regardless of how many PRs are registered.
 *   3. **Tick draining at shutdown.** SIGTERM in the middle of a fix
 *      cycle would leave the worktree mid-commit. `stop()` clears
 *      the interval and awaits all in-flight jobs before resolving.
 *
 * Configurable via constructor opts for tests. Production defaults
 * are tuned for the babysit cadence: 60s tick is fast enough to
 * respond to fresh bot comments within a minute, slow enough that we
 * don't beat on the GitHub API or the judge model quota.
 *
 * Wired into the daemon lifecycle by the registrar — see
 * src/daemon/index.ts where startBabysitScheduler() is called during
 * registerAll, and the shutdown hook awaits stop().
 */
import { babysitJobs, type BabysitJob } from "../../lib/db/index.js";

export interface SchedulerOptions {
  /** Milliseconds between tick attempts. Default 60_000 (1 min). */
  intervalMs?: number;
  /** Maximum jobs running concurrently. Default 3 — picks up fresh
   *  comments quickly without overwhelming the judge model quota. */
  maxConcurrent?: number;
  /** Per-job runner. Pure function: takes a job, performs one tick
   *  worth of state transitions, returns when done. Errors thrown
   *  from here are logged + swallowed (otherwise one bad PR would
   *  freeze the whole loop). */
  runJob: (job: BabysitJob) => Promise<void>;
  /** Optional logger for visibility. Default no-op so unit tests
   *  don't drown in console noise. */
  logger?: SchedulerLogger;
}

export interface SchedulerLogger {
  tickStart: (info: { eligible: number; inFlight: number }) => void;
  jobStart: (id: string) => void;
  jobEnd: (id: string, durationMs: number) => void;
  jobError: (id: string, err: unknown) => void;
}

const NOOP_LOGGER: SchedulerLogger = {
  tickStart: () => {},
  jobStart: () => {},
  jobEnd: () => {},
  jobError: () => {},
};

/** States that the scheduler should NOT dispatch — terminal or paused. */
const NON_DISPATCHABLE: readonly string[] = ["merged", "escalated", "paused"];

export class BabysitScheduler {
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private readonly runJob: (job: BabysitJob) => Promise<void>;
  private readonly logger: SchedulerLogger;

  private readonly inFlight = new Set<string>();
  /** Tracks the promise for each in-flight job so stop() can await
   *  them. Map (not array) so we can `.delete(id)` on completion. */
  private readonly inFlightPromises = new Map<string, Promise<void>>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Promise for the tick currently mid-dispatch (between listActive()
   *  awaits and the dispatch loop). stop() awaits this in addition to
   *  inFlightPromises so a tick that started just before stop() cannot
   *  spawn fresh jobs after stop() resolves. */
  private currentTickPromise: Promise<unknown> | null = null;

  constructor(opts: SchedulerOptions) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
    this.runJob = opts.runJob;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  /** Begin periodic ticking. Idempotent — second start is a no-op. */
  start(): void {
    if (this.intervalHandle !== null || this.stopped) return;
    // We don't fire an immediate tick — registration happens via the
    // route, and jobs registered before start() will be picked up on
    // the first scheduled tick. This avoids surprise concurrent
    // activity at daemon boot.
    this.intervalHandle = setInterval(() => {
      // Surface tick-level failures (e.g. transient DB read errors on
      // listActive()) through the logger instead of dropping them as
      // unhandled rejections — `void` would silently swallow them.
      this.tickOnce().catch((err: unknown) => {
        this.logger.jobError("(tick)", err);
      });
    }, this.intervalMs);
    // setInterval keeps the event loop alive; unref so the daemon can
    // shut down on SIGTERM without waiting for the next tick.
    if (typeof this.intervalHandle.unref === "function") {
      this.intervalHandle.unref();
    }
  }

  /** Stop periodic ticking + await in-flight jobs to drain. After
   *  stop() resolves, no further dispatches will happen. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // First, wait for any tick mid-await. Without this, a tick that
    // had already passed the `if (this.stopped)` guard at entry could
    // still be sitting in `await babysitJobs.listActive()` and would
    // dispatch fresh jobs after stop() resolved on inFlightPromises
    // alone.
    if (this.currentTickPromise) {
      await this.currentTickPromise.catch(() => {});
    }
    // Then drain in-flight jobs. Promise.allSettled rather than .all
    // because we don't want one failing job to make stop() reject.
    await Promise.allSettled(Array.from(this.inFlightPromises.values()));
  }

  /**
   * Public tick entrypoint. Used by tests to drive the loop
   * deterministically; production uses setInterval which calls this.
   *
   * Loads candidates, filters out non-dispatchable + already-in-flight
   * jobs, dispatches up to (maxConcurrent - inFlight) of them. Does
   * NOT await dispatched jobs — they run in the background and the
   * tick returns immediately. Use `waitForIdle()` in tests to await
   * completion of all dispatched work.
   */
  async tickOnce(): Promise<{ dispatched: string[] }> {
    if (this.stopped) return { dispatched: [] };
    const tickPromise = this.runTickBody();
    this.currentTickPromise = tickPromise;
    try {
      return await tickPromise;
    } finally {
      // Only clear if we're still the in-flight tick — under tests
      // a second tickOnce can be called before the first resolves,
      // and we don't want to leak a stale clear.
      if (this.currentTickPromise === tickPromise) {
        this.currentTickPromise = null;
      }
    }
  }

  private async runTickBody(): Promise<{ dispatched: string[] }> {
    const candidates = await babysitJobs.listActive();
    // Re-check stopped after the listActive() await — stop() may have
    // been called between entry and now, and we must not dispatch
    // fresh jobs after a stop has begun.
    if (this.stopped) return { dispatched: [] };
    const eligible = candidates.filter(
      (j) => !this.inFlight.has(j.id) && !NON_DISPATCHABLE.includes(j.state),
    );
    const slotsAvailable = Math.max(0, this.maxConcurrent - this.inFlight.size);
    const slice = eligible.slice(0, slotsAvailable);
    this.logger.tickStart({
      eligible: eligible.length,
      inFlight: this.inFlight.size,
    });
    const dispatched: string[] = [];
    for (const job of slice) {
      this.dispatch(job);
      dispatched.push(job.id);
    }
    return { dispatched };
  }

  /**
   * Wait for all currently in-flight jobs to finish. Useful in tests:
   *   await scheduler.tickOnce();
   *   await scheduler.waitForIdle();
   *   // now state assertions are deterministic
   */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled(Array.from(this.inFlightPromises.values()));
  }

  /** @internal — used by tests to introspect mutex state. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  private dispatch(job: BabysitJob): void {
    // Atomic claim — no await between has() and add(), so we can't
    // race with another concurrent tick. (In practice ticks run
    // serially under setInterval, but the contract has to hold under
    // tickOnce() called from tests too.)
    if (this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);
    const start = Date.now();
    this.logger.jobStart(job.id);
    const p = (async () => {
      try {
        await this.runJob(job);
        this.logger.jobEnd(job.id, Date.now() - start);
      } catch (err) {
        this.logger.jobError(job.id, err);
      } finally {
        this.inFlight.delete(job.id);
        this.inFlightPromises.delete(job.id);
      }
    })();
    this.inFlightPromises.set(job.id, p);
  }
}
