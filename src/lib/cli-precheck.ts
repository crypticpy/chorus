/**
 * Pre-spawn CLI health check.
 *
 * Runs before each CLI subprocess spawn (doer or reviewer) to short-circuit
 * three classes of doomed runs:
 *   1. Quota already exhausted (cli-health.ts has a recent resetAt in the
 *      future). Spawning would just hit the same wall in 5–10 seconds and
 *      burn UI time.
 *   2. CLI not logged in / cred file missing. Spawning would emit either a
 *      cold_start_timeout or token_refresh_lost from the pane scraper after
 *      we already paid the spawn tax (~3-5s for tmux/headless boot).
 *   3. CLI binary not present (handled at boot by `cli-detect`; we just
 *      mention it here for completeness — not re-checked per spawn).
 *
 * Deliberately cheap: no network calls. We check filesystem state + the
 * existing health record. A real network probe (ping `/v1/models` with the
 * stored bearer to confirm token validity) is the natural next layer; for
 * v0.7 the file-existence check catches "user logged out 3 days ago" which
 * is the highest-frequency failure mode.
 *
 * Returns:
 *   - { ok: true } → proceed with spawn
 *   - { ok: false, reason, cta } → skip spawn, runner emits cli_warning
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getHealth, type CliLineage } from "./cli-health";

export type PrecheckFailReason =
  | "quota_exhausted"
  | "auth_missing"
  | "auth_unreadable"
  | "config_missing";

export type PrecheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: PrecheckFailReason;
      message: string;
      cta: string;
      resetAt?: number;
    };

/**
 * Per-lineage credential file we treat as "user is logged in." Each CLI
 * stores its OAuth bearer somewhere different; if the file doesn't exist
 * the user almost certainly hasn't run the CLI's login command. False
 * positives are possible (some users move credential dirs via env), so we
 * only fail-closed when the file is *missing or unreadable* — never on
 * shape mismatches inside the file.
 */
const CRED_PATHS: Record<CliLineage, () => string[]> = {
  anthropic: () => [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".config", "anthropic", "claude.json"),
  ],
  openai: () => [path.join(os.homedir(), ".codex", "auth.json")],
  google: () => [
    path.join(os.homedir(), ".gemini", "oauth_creds.json"),
    path.join(os.homedir(), ".config", "gemini", "oauth_creds.json"),
  ],
  opencode: () => [
    path.join(os.homedir(), ".opencode", "auth.json"),
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  ],
  moonshot: () => [
    // Legacy single-file location (older kimi-cli releases).
    path.join(os.homedir(), ".kimi", "auth.json"),
    // Current kimi-cli (>= 2026-Q1) writes OAuth bearer here.
    path.join(os.homedir(), ".kimi", "credentials", "kimi-code.json"),
    // OpenCode stores its auth in two places depending on install path. The
    // kimi shim delegates to `opencode --model opencode-go/kimi-k2.6` when
    // the requested model carries the opencode-go/ prefix, so a moonshot
    // voice routed via opencode is actually authed by opencode's creds —
    // not the kimi-cli ones. Both opencode candidates accepted here.
    path.join(os.homedir(), ".opencode", "auth.json"),
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  ],
  // OpenRouter has no on-disk credential file — its API key lives in
  // the secrets table. The shim itself returns auth_missing when the
  // key is unset, which surfaces the same UX without a file probe.
  openrouter: () => [],
  // Local LLM has no credential file — the base_url lives in the secrets
  // table. The shim errors with auth_missing when base_url is unset.
  local: () => [],
};

const LOGIN_HINT: Record<CliLineage, string> = {
  anthropic: "Run `claude login` in a terminal.",
  openai: "Run `codex login` in a terminal.",
  google: "Run `gemini` once interactively to complete OAuth.",
  opencode: "Run `opencode auth login` in a terminal.",
  moonshot:
    "Run `kimi` once interactively, or set up opencode if you use the kimi-via-opencode transport.",
  openrouter: "Save an OpenRouter API key on the Connect page.",
  local: "Set a Local LLM base URL on the Connect page.",
};

/**
 * Check whether at least one of the candidate credential paths for `lineage`
 * exists and is readable. Existence-only — we don't parse contents (each CLI
 * has its own JSON shape and bearer-refresh lifecycle, neither of which we
 * want to couple to). Readable-but-empty counts as missing.
 */
function hasCredFile(lineage: CliLineage): {
  exists: boolean;
  tried: string[];
} {
  const candidates = CRED_PATHS[lineage]();
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0) {
        return { exists: true, tried: candidates };
      }
    } catch {
      // ENOENT or perm-denied — try next candidate
    }
  }
  return { exists: false, tried: candidates };
}

/**
 * Claude Code v2.x stores its OAuth credentials in the macOS Keychain under
 * the service name `Claude Code-credentials` rather than on disk, so the
 * file-existence probe reports a false negative on freshly-logged-in
 * machines. Use the `security` CLI to confirm the keychain entry exists —
 * exit 0 = present, anything else = missing/keychain-locked.
 *
 * No-ops on non-darwin platforms (returns false). Bounded to ~1.5s so a
 * misconfigured keychain can't stall every spawn.
 */
function hasDarwinKeychainEntry(serviceName: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["find-generic-password", "-s", serviceName], {
      stdio: "ignore",
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Layer-3 kimi check: even with valid OAuth, kimi exits 1 with
 * "LLM not set" when ~/.kimi/config.toml has no `default_model = "..."`
 * line (or it is empty). Catching this here turns a confusing
 * post-spawn cli_error into a clear precheck failure with a usable CTA.
 *
 * Does NOT fully parse TOML — just looks for a non-empty default_model
 * value at the top level. Section-scoped `default_model` keys (which
 * kimi doesn't honour) are deliberately ignored.
 */
function kimiHasDefaultModel(): boolean {
  const cfgPath = path.join(os.homedir(), ".kimi", "config.toml");
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf-8");
  } catch {
    return false;
  }
  // Walk lines top-to-bottom; bail once a section header [..] starts.
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const m = line.match(/^default_model\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, "");
    return value.length > 0;
  }
  return false;
}

export async function precheckLineage(
  lineage: CliLineage,
): Promise<PrecheckResult> {
  // Layer 1: quota state from cli-health (populated reactively when the
  // error-detector observes a quota_exhausted pane). If a previous run
  // tripped the limit and the reset hasn't elapsed, skip the spawn.
  const health = await getHealth(lineage);
  if (health.status === "quota_exhausted") {
    const now = Date.now();
    if (typeof health.resetAt === "number" && health.resetAt > now) {
      const minsLeft = Math.ceil((health.resetAt - now) / 60_000);
      return {
        ok: false,
        reason: "quota_exhausted",
        message: `${lineage} quota still exhausted (resets in ~${minsLeft} min).`,
        cta: "Wait for reset, switch account, or disable this voice.",
        resetAt: health.resetAt,
      };
    }
    // resetAt missing or already past — fall through and let the spawn try.
    // Stale health markers self-clear when a successful run records 'healthy'.
  }

  // OpenRouter and local LLM have no on-disk creds — the shim itself errors
  // with auth_missing when the secrets-table key/url is absent. Skip file probe.
  if (lineage === "openrouter" || lineage === "local") {
    return { ok: true };
  }

  // Layer 2: credential file presence. Cheap, catches "logged out" without
  // paying the spawn tax. See CRED_PATHS for the per-CLI lookups.
  const cred = hasCredFile(lineage);
  if (!cred.exists) {
    // anthropic falls back to the macOS Keychain — Claude Code v2.x stores
    // its bearer there exclusively on darwin, leaving the legacy file
    // candidates empty even on a healthy machine.
    const keychainOk =
      lineage === "anthropic" &&
      hasDarwinKeychainEntry("Claude Code-credentials");

    if (!keychainOk) {
      return {
        ok: false,
        reason: "auth_missing",
        message: `${lineage} CLI is not logged in (no credential file found).`,
        cta: LOGIN_HINT[lineage],
      };
    }
  }

  // Layer 3: per-CLI runtime config. Today only kimi needs this — without
  // a top-level `default_model` line in ~/.kimi/config.toml the subprocess
  // exits 1 with "LLM not set" the first time chorus dispatches to it.
  if (lineage === "moonshot" && !kimiHasDefaultModel()) {
    return {
      ok: false,
      reason: "config_missing",
      message:
        "kimi has no default model configured (~/.kimi/config.toml is missing `default_model`).",
      cta: 'Run `kimi` interactively once and pick a model, or add a `default_model = "..."` line to ~/.kimi/config.toml.',
    };
  }

  return { ok: true };
}
