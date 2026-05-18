/**
 * Verify-step shellout for the babysit fix loop.
 *
 * After the doer applies a fix, we need to know whether the worktree
 * still compiles + passes tests before we push. The choice of verify
 * command is project-specific, so we resolve it from the project
 * itself rather than hard-coding `npm test`:
 *
 *   1. If `package.json` has `scripts.test`, run `npm test`.
 *   2. Else if `package.json` has `scripts.typecheck`, run that.
 *   3. Else if tsconfig.json exists, fall back to `npx tsc --noEmit`.
 *   4. Else: there's no automated verify gate available — return ok
 *      with a `none_available` flag so the runner can decide what
 *      to do (default: push anyway with a flag in the commit msg).
 *
 * The output is captured (stdout+stderr) and truncated at 16 KiB so a
 * test suite that floods on failure doesn't bloat the babysit_jobs
 * table when we record the verify failure in the escalation reason.
 *
 * Caller may override the command entirely via `command` — useful for
 * projects with custom verify scripts and for tests.
 */
import * as fs from "fs";
import * as path from "path";
import { runAsync } from "../ship.js";

const OUTPUT_TRUNCATE_BYTES = 16 * 1024;

export interface VerifyArgs {
  worktreePath: string;
  /** If supplied, runs this exact command instead of resolving from
   *  package.json. Shape: [command, ...args]. */
  command?: [string, ...string[]];
  /** Per-run timeout. Default 5 min — long enough for a small test
   *  suite, short enough that a hang doesn't park a worker forever. */
  timeoutMs?: number;
}

export type VerifyResult =
  | {
      ok: true;
      mode: VerifyMode;
      output: string;
    }
  | {
      ok: false;
      mode: VerifyMode;
      output: string;
      exitCode: number | null;
    };

export type VerifyMode =
  | "custom"
  | "npm-test"
  | "npm-typecheck"
  | "tsc-noemit"
  | "none_available";

export async function runVerify(args: VerifyArgs): Promise<VerifyResult> {
  const resolved = args.command
    ? { mode: "custom" as const, argv: args.command }
    : resolveVerifyCommand(args.worktreePath);

  if (resolved.mode === "none_available") {
    return { ok: true, mode: "none_available", output: "" };
  }

  const [cmd, ...rest] = resolved.argv;
  const res = await runAsync(cmd, rest, {
    cwd: args.worktreePath,
    timeoutMs: args.timeoutMs ?? 5 * 60_000,
  });
  const combined = truncate(
    `${res.stdout || ""}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`.trim(),
    OUTPUT_TRUNCATE_BYTES,
  );
  if (res.ok) {
    return { ok: true, mode: resolved.mode, output: combined };
  }
  return {
    ok: false,
    mode: resolved.mode,
    output: combined,
    exitCode: res.code,
  };
}

function resolveVerifyCommand(worktreePath: string):
  | {
      mode: "npm-test" | "npm-typecheck" | "tsc-noemit";
      argv: [string, ...string[]];
    }
  | { mode: "none_available"; argv: [] } {
  const pkgPath = path.join(worktreePath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts: Record<string, string> = pkg.scripts ?? {};
      if (typeof scripts.test === "string" && scripts.test.trim()) {
        return { mode: "npm-test", argv: ["npm", "test", "--silent"] };
      }
      if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
        return {
          mode: "npm-typecheck",
          argv: ["npm", "run", "typecheck", "--silent"],
        };
      }
    } catch {
      // Malformed package.json — fall through to tsc detection.
    }
  }
  if (fs.existsSync(path.join(worktreePath, "tsconfig.json"))) {
    return { mode: "tsc-noemit", argv: ["npx", "tsc", "--noEmit"] };
  }
  return { mode: "none_available", argv: [] };
}

function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  return (
    buf.subarray(0, maxBytes).toString("utf-8") +
    `\n[truncated ${buf.length - maxBytes} bytes]`
  );
}
