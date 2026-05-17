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
import type { VerifyPhase } from "../../lib/template-schema.js";
import type { ErrorDetector } from "../error-detector.js";
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
  templateFallbackReviewer?: ReadonlyArray<{
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
}

/**
 * Run the verify command, persist the captured artifact into the chat
 * directory (so the cockpit can render it the same way it renders a
 * doer answer), then route the artifact through `runReviewers`. The
 * standard reviewer flow handles its own events / persistence /
 * fallbacks; we just feed it the synthetic doer output.
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
    templateFallbackReviewer,
  } = args;

  if (abortSignal.aborted) {
    return {
      completed: false,
      passed: false,
      allReviewersFailed: false,
      summary: "Aborted before verify phase started",
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
    };
  }

  const result = await runVerifyCommand({
    exec: split.exec,
    args: split.args,
    cwd: repoPath,
    timeoutMs: phase.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });

  const artifact = formatVerifyArtifact(command, result);

  // Persist the captured artifact next to where a doer's answer.md would
  // live so the cockpit can render it identically. The synthetic doer is
  // labelled `verify-runner` to make the source clear in the timeline.
  const roundDir = path.join(chatDir, `round-1`);
  const doerDir = path.join(roundDir, `doer-verify-runner`);
  fs.mkdirSync(doerDir, { recursive: true });
  fs.writeFileSync(
    path.join(doerDir, "answer.md"),
    artifact + "\n## DONE\n",
    "utf-8",
  );

  // Surface the command-level outcome on the existing phase_progress
  // channel — saves wiring a brand-new event type through the SSE
  // multiplex and DB persister just for the verify subcommand. The
  // `kind: "verify_command"` discriminator inside the payload is the
  // hook cockpits filter on.
  onEvent({
    chatId,
    type: "phase_progress",
    payload: {
      phaseId: phase.id,
      phaseIdx,
      kind: "verify_command",
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
    ts: Date.now(),
  });

  // Hand the artifact to the standard reviewer flow. Reviewers get the
  // fenced output and decide approve vs request_changes — they'll often
  // catch deprecation warnings or flaky-test patterns that a pure exit-
  // code check would miss.
  const reviewOutcome = await runReviewers(
    chatDir,
    chatId,
    // The reviewer driver only inspects `phase.reviewer`, `phase.id`,
    // `phase.title`, and `phase.description` — all of which exist on
    // VerifyPhase. The wider StandardPhase shape is structurally satisfied
    // for the fields the driver actually reads.
    phase as unknown as Parameters<typeof runReviewers>[2],
    phaseIdx,
    1,
    artifact,
    work,
    filesBlock,
    tmuxMgr,
    errorDetector,
    onEvent,
    abortSignal,
    templateFallbackReviewer,
    repoPath,
  );

  const passed =
    !result.timedOut && result.exitCode === 0 && reviewOutcome.agreed;

  return {
    completed: true,
    passed,
    allReviewersFailed: reviewOutcome.allFailed,
    summary: reviewOutcome.summary,
    command: result,
  };
}
