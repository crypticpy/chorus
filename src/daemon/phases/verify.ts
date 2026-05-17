/**
 * Verify phase runner.
 *
 * Runs the project's `chorus.verify` command (declared in `package.json`)
 * in `repoPath`, captures stdout/stderr/exit code, fences the output
 * into a synthetic doer answer, then routes the artifact through the
 * existing reviewer flow so the reviewer judges whether the run passed.
 *
 * No LLM doer is spawned — the "doer" here is execFile. Pairs with the
 * TDD loop: a failing verify produces a structured artifact a later
 * implement phase can be re-prompted with.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import type {
  StandardPhase,
  Template,
  VerifyPhase,
} from "../../lib/template-schema.js";
import type { ErrorDetector } from "../error-detector.js";
import { runDoer } from "../runner/doer-driver.js";
import { runReviewers } from "../runner/reviewer-driver.js";
import type { RunnerEvent } from "../runner/types.js";
import type { TmuxManager } from "../tmux-types.js";

const OUTPUT_TRUNCATE_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Result of one verify-command run. `timedOut` is true when the
 * subprocess was killed at the timeout boundary; `exitCode` is null
 * in that case because the process didn't exit normally.
 */
export interface VerifyCommandResult {
  command: string;
  argv: ReadonlyArray<string>;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Read `chorus.verify` from `<repoPath>/package.json`. Returns null when
 * the file is missing, unparseable, or doesn't declare the field. The
 * field must be a string — arrays/objects are rejected with null so
 * upstream emits a clear `verify_no_command` event instead of guessing.
 */
export function readVerifyCommand(repoPath: string): string | null {
  const pkgPath = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const chorusBlock = (parsed as Record<string, unknown>).chorus;
  if (!chorusBlock || typeof chorusBlock !== "object") return null;
  const verify = (chorusBlock as Record<string, unknown>).verify;
  if (typeof verify !== "string") return null;
  const trimmed = verify.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whitespace-tokenise a command string into [exec, ...args]. Intentionally
 * NOT a full POSIX shell-words split — we don't want to invoke a shell,
 * and templates that need pipes or quoting should put them behind a
 * package.json script (`npm test`) where the shell lives.
 *
 * Rejects empty input by returning null so the caller can surface a
 * clean `verify_no_command` event.
 */
export function splitCommand(
  cmd: string,
): { exec: string; args: string[] } | null {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { exec: parts[0], args: parts.slice(1) };
}

/**
 * Spawn the verify command and capture stdout/stderr/exit code. Streams
 * are buffered and clipped at OUTPUT_TRUNCATE_BYTES per stream so a
 * runaway test suite can't OOM the daemon; the `truncated` flags let the
 * reviewer prompt mark the cut.
 */
export async function runVerifyCommand(opts: {
  exec: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<VerifyCommandResult> {
  const { exec, args, cwd, timeoutMs } = opts;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const child = execFile(
      exec,
      args,
      {
        cwd,
        timeout: timeoutMs,
        // Cap node's internal buffer; we still clip per-stream below to
        // surface a clean truncated flag instead of an ERR_CHILD_PROCESS_STDIO_MAXBUFFER throw.
        maxBuffer: OUTPUT_TRUNCATE_BYTES * 4,
        // Drop inherited env that could leak credentials into the
        // captured artifact — only PATH + HOME / common locale bits make
        // sense for running a project's test/typecheck script.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANG: process.env.LANG ?? "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "",
          NODE_ENV: process.env.NODE_ENV ?? "test",
        },
      },
      (err, stdoutBuf: string | Buffer, stderrBuf: string | Buffer) => {
        // execFile signals timeout by killing the child with SIGTERM and
        // setting err.killed=true. err.code is "ETIMEDOUT" on some
        // platforms but unreliable — node sometimes leaves it as null and
        // only sets signal. Match both shapes so platform drift doesn't
        // silently turn timeouts into "exit code null, didn't time out."
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          if (
            e.code === "ETIMEDOUT" ||
            (e.killed === true && e.signal === "SIGTERM")
          ) {
            timedOut = true;
          }
        }
        const stdoutRaw = Buffer.isBuffer(stdoutBuf)
          ? stdoutBuf.toString("utf-8")
          : stdoutBuf;
        const stderrRaw = Buffer.isBuffer(stderrBuf)
          ? stderrBuf.toString("utf-8")
          : stderrBuf;
        if (stdoutRaw.length > OUTPUT_TRUNCATE_BYTES) {
          stdout = stdoutRaw.slice(0, OUTPUT_TRUNCATE_BYTES);
          stdoutTruncated = true;
        } else {
          stdout = stdoutRaw;
        }
        if (stderrRaw.length > OUTPUT_TRUNCATE_BYTES) {
          stderr = stderrRaw.slice(0, OUTPUT_TRUNCATE_BYTES);
          stderrTruncated = true;
        } else {
          stderr = stderrRaw;
        }
        // err.code on a non-zero exit is the exit code (number); on
        // signal-kill (incl. timeout SIGTERM) it's null and err.signal is
        // set. Match either to a stable exitCode | null contract.
        const exitCode =
          err && typeof err === "object" && "code" in err
            ? typeof (err as { code: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : null
            : 0;
        resolve({
          command: [exec, ...args].join(" "),
          argv: [exec, ...args],
          exitCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      },
    );

    // execFile already enforces the timeout; this handler is a belt for
    // platforms where the SIGTERM doesn't actually kill the process tree.
    child.on("error", () => {
      // The callback above will resolve with the error, no double-resolve.
    });
  });
}

/**
 * Format a verify result as a markdown artifact a reviewer can judge.
 * The reviewer is told to approve when the run passed and request_changes
 * with a digest when it failed. Output is small and structured so the
 * downstream TDD loop can re-prompt the implement doer with it.
 */
export function formatVerifyArtifact(
  command: string,
  result: VerifyCommandResult,
): string {
  const lines: string[] = [];
  const status = result.timedOut
    ? "TIMED OUT"
    : result.exitCode === 0
      ? "PASSED (exit 0)"
      : `FAILED (exit ${result.exitCode ?? "killed"})`;

  lines.push("# Verify run");
  lines.push("");
  lines.push(`**Command:** \`${command}\``);
  lines.push(`**Status:** ${status}`);
  lines.push(`**Duration:** ${result.durationMs} ms`);
  lines.push("");

  lines.push("## stdout");
  if (result.stdout.trim().length === 0) {
    lines.push("_(empty)_");
  } else {
    lines.push("```");
    lines.push(result.stdout);
    lines.push("```");
    if (result.stdoutTruncated) {
      lines.push(`_(truncated to ${OUTPUT_TRUNCATE_BYTES} bytes)_`);
    }
  }
  lines.push("");

  lines.push("## stderr");
  if (result.stderr.trim().length === 0) {
    lines.push("_(empty)_");
  } else {
    lines.push("```");
    lines.push(result.stderr);
    lines.push("```");
    if (result.stderrTruncated) {
      lines.push(`_(truncated to ${OUTPUT_TRUNCATE_BYTES} bytes)_`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export interface RunVerifyPhaseArgs {
  chatDir: string;
  chatId: string;
  phase: VerifyPhase;
  phaseIdx: number;
  work: string;
  repoPath: string;
  filesBlock: string;
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
  /**
   * Full template — needed to resolve `phase.feedbackPhase` (TDD loop)
   * back to its config so we can re-fire its doer with the verify
   * failure as priorRoundFeedback.
   */
  template: Template;
  templateFallbackReviewer?: ReadonlyArray<{
    lineage: string;
    models: string[];
  }>;
  templateFallbackDoer?: ReadonlyArray<{
    lineage: string;
    models: string[];
  }>;
}

export interface VerifyPhaseOutcome {
  completed: boolean;
  passed: boolean;
  allReviewersFailed: boolean;
  /** Reviewer summary string for downstream chat_done. */
  summary: string;
  /** Raw verify result so the TDD loop can re-prompt the implement doer. */
  command?: VerifyCommandResult;
  /** Number of verify iterations actually run (1 if no TDD loop fired). */
  iterations: number;
}

/**
 * Synthetic round offset for verify TDD iterations. Sits well above any
 * realistic `iterate.maxRounds` so the round dirs we create
 * (round-1001, round-1002, …) can't collide with the prior implement
 * phase's rounds (round-1, round-2, …) in the same chat dir. The
 * scheme also makes the cockpit's run page obviously surface "this
 * round is part of the TDD loop, not the original implement loop."
 */
const TDD_ROUND_OFFSET = 1000;

/**
 * Wrap a verify failure into the priorRoundFeedback shape that buildAsk
 * expects (markdown block with a top-level "## Prior round feedback"
 * heading). Re-uses the prompt-builder contract so the implement doer
 * sees the verify failure in the same slot it'd see reviewer-disagreement
 * feedback in a normal iterate loop.
 */
export function formatVerifyFailureFeedback(
  command: string,
  result: VerifyCommandResult,
  iteration: number,
): string {
  const status = result.timedOut
    ? "TIMED OUT"
    : `exit ${result.exitCode ?? "killed"}`;
  return [
    "## Prior round feedback",
    "",
    `The verify step (\`${command}\`) failed on iteration ${iteration} ` +
      `with ${status}. The captured output is below — diagnose the failure ` +
      `and revise your implementation so the next verify run passes. Do ` +
      `not re-emit unchanged code.`,
    "",
    "### Verify output",
    "",
    formatVerifyArtifact(command, result),
    "",
  ].join("\n");
}

/**
 * Run the verify command, persist the captured artifact, and route it
 * through `runReviewers`. When the phase declares a `feedbackPhase`
 * (TDD loop) and verify fails, re-prompt the named phase's doer with
 * the verify output and retry — up to `maxIterations` total verify
 * runs.
 *
 * The reviewer runs only on the LAST iteration (success or final
 * failure). Intermediate iterations skip the reviewer pass: exit code
 * is the loop signal, and asking the reviewer N times to judge the
 * same kind of failure would just burn tokens for nothing.
 */
export async function runVerifyPhase(
  args: RunVerifyPhaseArgs,
): Promise<VerifyPhaseOutcome> {
  const {
    chatDir,
    chatId,
    phase,
    phaseIdx,
    work,
    repoPath,
    filesBlock,
    tmuxMgr,
    errorDetector,
    onEvent,
    abortSignal,
    template,
    templateFallbackReviewer,
    templateFallbackDoer,
  } = args;

  if (abortSignal.aborted) {
    return {
      completed: false,
      passed: false,
      allReviewersFailed: false,
      summary: "Aborted before verify phase started",
      iterations: 0,
    };
  }

  onEvent({
    chatId,
    type: "phase_start",
    payload: {
      phaseId: phase.id,
      phaseIdx,
      kind: phase.kind,
      round: 1,
      role: "verify",
    },
    ts: Date.now(),
  });

  const command = readVerifyCommand(repoPath);
  if (!command) {
    onEvent({
      chatId,
      type: "phase_failed",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: phase.kind,
        role: "verify",
        reason: "no_verify_command",
        message:
          'No `chorus.verify` field in package.json. Add `"chorus": {"verify": "npm test"}` (or similar) to enable the verify phase.',
      },
      ts: Date.now(),
    });
    return {
      completed: false,
      passed: false,
      allReviewersFailed: false,
      summary: "package.json missing chorus.verify command",
      iterations: 0,
    };
  }

  const split = splitCommand(command);
  if (!split) {
    onEvent({
      chatId,
      type: "phase_failed",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: phase.kind,
        role: "verify",
        reason: "empty_verify_command",
        message: "`chorus.verify` exists but is empty after tokenisation.",
      },
      ts: Date.now(),
    });
    return {
      completed: false,
      passed: false,
      allReviewersFailed: false,
      summary: "chorus.verify is empty",
      iterations: 0,
    };
  }

  // Resolve the feedback phase up-front so a misconfigured template
  // fails immediately, not after iteration 1's verify burns time.
  let feedbackStdPhase: StandardPhase | null = null;
  if (phase.feedbackPhase) {
    const fb = template.phases.find((p) => p.id === phase.feedbackPhase);
    if (!fb) {
      onEvent({
        chatId,
        type: "phase_failed",
        payload: {
          phaseId: phase.id,
          phaseIdx,
          kind: phase.kind,
          role: "verify",
          reason: "feedback_phase_not_found",
          message: `feedbackPhase "${phase.feedbackPhase}" not found in template.phases.`,
        },
        ts: Date.now(),
      });
      return {
        completed: false,
        passed: false,
        allReviewersFailed: false,
        summary: `feedbackPhase ${phase.feedbackPhase} not found`,
        iterations: 0,
      };
    }
    // Only standard phases have a doer we can re-fire. review_only,
    // audit, orchestrate, and another verify can't be the feedback
    // target.
    if (
      fb.kind === "review_only" ||
      fb.kind === "audit" ||
      fb.kind === "orchestrate" ||
      fb.kind === "verify"
    ) {
      onEvent({
        chatId,
        type: "phase_failed",
        payload: {
          phaseId: phase.id,
          phaseIdx,
          kind: phase.kind,
          role: "verify",
          reason: "feedback_phase_not_standard",
          message: `feedbackPhase "${phase.feedbackPhase}" is kind=${fb.kind}; only standard phases (plan/spec/tests/implement/review/divergence) can be TDD-fed.`,
        },
        ts: Date.now(),
      });
      return {
        completed: false,
        passed: false,
        allReviewersFailed: false,
        summary: `feedbackPhase ${phase.feedbackPhase} is not a standard phase`,
        iterations: 0,
      };
    }
    feedbackStdPhase = fb;
  }

  const maxIterations = phase.maxIterations ?? 5;
  const commandTimeoutMs = phase.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  let lastResult: VerifyCommandResult | null = null;
  let lastArtifact = "";
  let iter = 0;

  while (iter < maxIterations) {
    if (abortSignal.aborted) break;
    iter++;
    const round = TDD_ROUND_OFFSET + iter;

    lastResult = await runVerifyCommand({
      exec: split.exec,
      args: split.args,
      cwd: repoPath,
      timeoutMs: commandTimeoutMs,
    });
    lastArtifact = formatVerifyArtifact(command, lastResult);

    // Persist the captured artifact per-iteration so the cockpit can
    // walk the TDD history. Each iteration lives in its own round dir
    // (TDD_ROUND_OFFSET+iter) — well above any real phase's rounds.
    const roundDir = path.join(chatDir, `round-${round}`);
    const verifyDir = path.join(roundDir, "doer-verify-runner");
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(verifyDir, "answer.md"),
      lastArtifact + "\n## DONE\n",
      "utf-8",
    );

    onEvent({
      chatId,
      type: "phase_progress",
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: "verify_command",
        iteration: iter,
        round,
        command,
        exitCode: lastResult.exitCode,
        timedOut: lastResult.timedOut,
        durationMs: lastResult.durationMs,
        stdoutTruncated: lastResult.stdoutTruncated,
        stderrTruncated: lastResult.stderrTruncated,
      },
      ts: Date.now(),
    });

    const commandPassed = !lastResult.timedOut && lastResult.exitCode === 0;

    // Success: break the loop and let the reviewer pass below decide
    // the final verdict (catches "tests passed but with concerning
    // warnings" patterns).
    if (commandPassed) break;

    // Failure path. If no feedback phase OR we've hit the cap, fall
    // through to the reviewer pass with the failing artifact.
    if (!feedbackStdPhase || iter >= maxIterations) break;

    // Re-fire the feedback phase doer with verify output as
    // priorRoundFeedback. Reusing runDoer keeps semaphore + fallback +
    // headless/tmux dispatch + persona resolution + cli-warning events
    // all consistent with how the original implement phase ran.
    const feedback = formatVerifyFailureFeedback(command, lastResult, iter);
    await runDoer(
      chatDir,
      chatId,
      feedbackStdPhase,
      phaseIdx,
      round,
      work,
      filesBlock,
      tmuxMgr,
      errorDetector,
      onEvent,
      abortSignal,
      repoPath,
      templateFallbackDoer,
      feedback,
    );
    // runDoer's return value is intentionally not inspected here:
    // whether the doer produced an answer or not, the NEXT verify run
    // is the truth signal. A doer that fails to produce output just
    // means the next verify will likely still fail and we'll iterate
    // again (or hit the cap and escalate).
  }

  if (!lastResult) {
    // Should be unreachable — the loop always runs at least once
    // before exiting — but keeps the type system + abort race safe.
    return {
      completed: false,
      passed: false,
      allReviewersFailed: false,
      summary: "verify aborted before first run",
      iterations: iter,
    };
  }

  // Final reviewer pass on the last iteration's artifact. Round number
  // matches the iteration's round so cockpit timeline grouping works.
  const finalRound = TDD_ROUND_OFFSET + iter;
  const reviewOutcome = await runReviewers(
    chatDir,
    chatId,
    phase as unknown as Parameters<typeof runReviewers>[2],
    phaseIdx,
    finalRound,
    lastArtifact,
    work,
    filesBlock,
    tmuxMgr,
    errorDetector,
    onEvent,
    abortSignal,
    templateFallbackReviewer,
    repoPath,
  );

  const commandPassed = !lastResult.timedOut && lastResult.exitCode === 0;
  const passed = commandPassed && reviewOutcome.agreed;

  return {
    completed: true,
    passed,
    allReviewersFailed: reviewOutcome.allFailed,
    summary: passed
      ? reviewOutcome.summary
      : `${reviewOutcome.summary} (verify failed after ${iter} iteration${iter === 1 ? "" : "s"})`,
    command: lastResult,
    iterations: iter,
  };
}
