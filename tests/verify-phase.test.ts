/**
 * Tests for the verify phase command runner + artifact formatter.
 * The full runVerifyPhase (which fans into runReviewers) is covered by
 * the existing reviewer-driver tests + runChat integration; here we
 * exercise the parts unique to the verify phase: package.json field
 * parsing, command splitting, subprocess capture, artifact shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readVerifyCommand,
  splitCommand,
  runVerifyCommand,
  formatVerifyArtifact,
} from "../src/daemon/phases/verify";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-verify-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readVerifyCommand", () => {
  it("returns null when package.json is missing", () => {
    expect(readVerifyCommand(tmp)).toBeNull();
  });

  it("returns null when package.json is unparseable", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{ not json");
    expect(readVerifyCommand(tmp)).toBeNull();
  });

  it("returns null when chorus.verify is absent", () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "vitest" } }),
    );
    expect(readVerifyCommand(tmp)).toBeNull();
  });

  it("returns null when chorus.verify is not a string", () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ chorus: { verify: ["npm", "test"] } }),
    );
    expect(readVerifyCommand(tmp)).toBeNull();
  });

  it("returns the command when chorus.verify is a non-empty string", () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ chorus: { verify: "npm test" } }),
    );
    expect(readVerifyCommand(tmp)).toBe("npm test");
  });

  it("returns null when chorus.verify is empty / whitespace-only", () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ chorus: { verify: "   " } }),
    );
    expect(readVerifyCommand(tmp)).toBeNull();
  });

  it("trims surrounding whitespace from the command", () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ chorus: { verify: "  pnpm typecheck  " } }),
    );
    expect(readVerifyCommand(tmp)).toBe("pnpm typecheck");
  });
});

describe("splitCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("npm test")).toEqual({ exec: "npm", args: ["test"] });
  });

  it("collapses runs of whitespace", () => {
    expect(splitCommand("  pnpm   run   verify  ")).toEqual({
      exec: "pnpm",
      args: ["run", "verify"],
    });
  });

  it("returns null for an empty string", () => {
    expect(splitCommand("")).toBeNull();
    expect(splitCommand("   ")).toBeNull();
  });

  it("handles single-token commands", () => {
    expect(splitCommand("vitest")).toEqual({ exec: "vitest", args: [] });
  });
});

describe("runVerifyCommand", () => {
  it("captures exit 0 from a successful command", async () => {
    const result = await runVerifyCommand({
      exec: "node",
      args: ["-e", "console.log('hello'); process.exit(0)"],
      cwd: tmp,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures non-zero exit + stderr from a failing command", async () => {
    const result = await runVerifyCommand({
      exec: "node",
      args: ["-e", "console.error('boom'); process.exit(2)"],
      cwd: tmp,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe("boom");
    expect(result.timedOut).toBe(false);
  });

  it("flags timedOut + null exit when the command exceeds the timeout", async () => {
    const result = await runVerifyCommand({
      exec: "node",
      args: ["-e", "setInterval(()=>{}, 1000)"],
      cwd: tmp,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
  });

  it("runs the command in the supplied cwd", async () => {
    const result = await runVerifyCommand({
      exec: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: tmp,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    // macOS tmpdir resolves through /private/var/folders/... — the
    // canonical form is what `process.cwd()` returns from inside node.
    expect(result.stdout).toContain(path.basename(tmp));
  });
});

describe("formatVerifyArtifact", () => {
  it("renders a PASSED artifact when exit code is 0", () => {
    const out = formatVerifyArtifact("npm test", {
      command: "npm test",
      argv: ["npm", "test"],
      exitCode: 0,
      stdout: "all tests passed",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1234,
      timedOut: false,
    });
    expect(out).toContain("# Verify run");
    expect(out).toContain("**Command:** `npm test`");
    expect(out).toContain("**Status:** PASSED (exit 0)");
    expect(out).toContain("**Duration:** 1234 ms");
    expect(out).toContain("all tests passed");
  });

  it("renders a FAILED artifact and includes stderr when exit code is non-zero", () => {
    const out = formatVerifyArtifact("pnpm typecheck", {
      command: "pnpm typecheck",
      argv: ["pnpm", "typecheck"],
      exitCode: 1,
      stdout: "",
      stderr: "TS2322: Type 'string' is not assignable to type 'number'.",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 800,
      timedOut: false,
    });
    expect(out).toContain("**Status:** FAILED (exit 1)");
    expect(out).toContain("TS2322");
  });

  it("renders a TIMED OUT artifact when the run was killed", () => {
    const out = formatVerifyArtifact("sleep 1000", {
      command: "sleep 1000",
      argv: ["sleep", "1000"],
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5000,
      timedOut: true,
    });
    expect(out).toContain("**Status:** TIMED OUT");
  });

  it("marks truncated streams so reviewers know the cut happened", () => {
    const out = formatVerifyArtifact("noisy", {
      command: "noisy",
      argv: ["noisy"],
      exitCode: 0,
      stdout: "first 64k of output",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: false,
      durationMs: 10,
      timedOut: false,
    });
    expect(out).toContain("truncated to");
  });

  it("emits `_(empty)_` for blank streams rather than empty fences", () => {
    const out = formatVerifyArtifact("ok", {
      command: "ok",
      argv: ["ok"],
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5,
      timedOut: false,
    });
    expect(out).toContain("## stdout\n_(empty)_");
    expect(out).toContain("## stderr\n_(empty)_");
  });
});
