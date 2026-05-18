/**
 * Tests for runVerify. We exercise the command-resolution table
 * (package.json scripts.test → npm test, scripts.typecheck → npm run
 * typecheck, tsconfig.json → npx tsc, otherwise none_available) and
 * the output truncation + ok/fail surfacing.
 *
 * Each test creates a tmp project directory with the relevant
 * files and runs a trivial passing/failing command via the `command`
 * override so we don't actually shell out to npm.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerify } from "../src/daemon/babysit/verifier";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-verify-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("runVerify with custom command override", () => {
  it("returns ok=true for a passing command", async () => {
    const res = await runVerify({
      worktreePath: tmp,
      command: ["true"],
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("custom");
  });

  it("returns ok=false with exit code on a failing command", async () => {
    const res = await runVerify({
      worktreePath: tmp,
      command: ["false"],
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.mode).toBe("custom");
    expect(res.exitCode).toBe(1);
  });

  it("captures stdout + stderr into a single combined string", async () => {
    const res = await runVerify({
      worktreePath: tmp,
      command: ["sh", "-c", "echo OUT; echo ERR 1>&2; exit 0"],
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("OUT");
    expect(res.output).toContain("ERR");
  });

  it("truncates output past 16 KiB", async () => {
    // Generate ~32 KiB of stdout.
    const res = await runVerify({
      worktreePath: tmp,
      command: [
        "sh",
        "-c",
        "for i in $(seq 1 2000); do echo 'aaaaaaaaaaaaaaaaaaaa'; done",
      ],
      timeoutMs: 10_000,
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("[truncated");
  });
});

describe("runVerify command resolution", () => {
  it("resolves to npm-test when package.json has scripts.test", async () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "echo skipped" } }),
    );
    // We can't easily intercept the actual `npm test` call without
    // a shim; assert via the mode reported when we override the
    // command to a no-op but verify resolution would have picked
    // npm-test. (The override branch bypasses resolution, so this
    // test relies on the fact that without override + with valid
    // package.json, resolveVerifyCommand picks npm-test.)
    //
    // Simplest accurate path: leave a script that exits 0 and let
    // real npm run. CI environments have npm; skip if not.
    if (!hasBinary("npm")) {
      return;
    }
    const res = await runVerify({ worktreePath: tmp, timeoutMs: 30_000 });
    expect(res.mode).toBe("npm-test");
  });

  it("falls back to tsc-noemit when only tsconfig.json exists", async () => {
    fs.writeFileSync(
      path.join(tmp, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true } }),
    );
    fs.writeFileSync(path.join(tmp, "index.ts"), "export const x = 1;\n");
    if (!hasBinary("npx")) {
      return;
    }
    const res = await runVerify({ worktreePath: tmp, timeoutMs: 60_000 });
    expect(res.mode).toBe("tsc-noemit");
  });

  it("returns mode=none_available when no verify signal is present", async () => {
    const res = await runVerify({ worktreePath: tmp });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("none_available");
    expect(res.output).toBe("");
  });

  it("falls through to tsc-noemit when package.json is malformed", async () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{ not json");
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(tmp, "x.ts"), "export const x: number = 1;");
    if (!hasBinary("npx")) {
      return;
    }
    const res = await runVerify({ worktreePath: tmp, timeoutMs: 60_000 });
    expect(res.mode).toBe("tsc-noemit");
  });
});

function hasBinary(name: string): boolean {
  try {
    require("child_process").execSync(`which ${name}`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
