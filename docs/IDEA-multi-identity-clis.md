# Idea: Multi-identity CLI invocations

**Status:** Idea — not scheduled. Capture-only.
**Date:** 2026-05-07
**Origin:** Conversation 2026-05-07. User runs separate work + personal accounts on
the same CLI binaries (Claude Code, Codex, etc.) and wants chorus to be able to
fan work out across both identities so each account's quota gets used.

## Problem

Today chorus assumes one identity per CLI binary. When it spawns `claude`, the
subprocess inherits the user's ambient auth from the OS keychain or the CLI's
config dir (`~/.config/claude/`, `~/.codex/`, etc.). A single user with two
paid accounts on the same CLI (e.g. Claude Code Max work + Claude Code Max
personal) can't tell chorus "use the work account for this slot, the personal
account for that slot."

## Mechanism (sketched, not validated)

Most CLIs key auth off either:

- A config dir whose path is configurable via env (`CLAUDE_CONFIG_DIR`,
  `CODEX_CONFIG_DIR`, etc.) or `$HOME` override.
- An OS-level keychain entry — harder to swap per-process.

Where env-controlled config dirs exist, chorus can spawn the same binary with
a different env to pick up a different login. Per CLI we'd need to verify:

- Is there a config-dir env var, OR
- Does `$HOME` override work cleanly, OR
- Does the CLI ship a `--profile` flag we can use instead.

Spike before implementing — don't assume all four CLIs behave the same way.

## Proposed primitive: Identity

Add an Identity record in settings:

```ts
interface Identity {
  id: string;              // "claude-work", "codex-personal"
  cli: 'claude' | 'codex' | 'gemini' | 'kimi' | ...;
  displayName: string;     // shown in cockpit
  // One of these must be set:
  configDir?: string;      // absolute path to config dir
  homeOverride?: string;   // absolute path to override $HOME
  profileFlag?: string;    // arg appended to every invocation
  // Quota hint — tier the user purchased on this identity. Wires into
  // the quota-tier feature (separate plan).
  tier?: 'max-20x' | 'pro' | 'mid' | 'low' | 'api-paygo';
  monthlyBudgetUsd?: number;
}
```

Voices then point at an identity instead of just a CLI:

```yaml
voices:
  - name: claude-work-opus
    cli: claude
    identity: claude-work
    model: opus-4.7
  - name: claude-personal-opus
    cli: claude
    identity: claude-personal
    model: opus-4.7
```

Runner reads voice → resolves identity → builds the spawn env (`HOME=...` or
`<CONFIG_DIR_VAR>=...`) → invokes binary. Identity-less voices keep working
exactly as they do today (ambient auth).

## Open questions

- **Keychain-based CLIs.** Some CLIs store auth in macOS Keychain Access keyed
  by app name, not by config dir. For those, env override doesn't help and
  we'd need a different mechanism (separate binary install? Docker sandbox?
  documented unsupported?).
- **Setup UX.** "Run `claude login` with `HOME=/path/to/work-config`" is not a
  pleasant onboarding step. We'd want a guided flow in settings: "Click to
  add identity → chorus opens a terminal pre-set with the override env →
  user runs the CLI's login command → chorus verifies."
- **Concurrency safety.** Two concurrent `claude` invocations against the
  same config dir might collide on lock files or session caches. Each
  identity needs its own dir, not just its own auth.
- **Cockpit display.** Show identity-of-record in the run viewer per
  participant so the user can see "this review came from work-claude, this
  one from personal-claude."

## Why this is filed instead of built now

- Requires per-CLI spike to confirm config-dir / env-override behaviour.
- Touches the runner spawn path and the voices schema — wider blast radius
  than a single-feature PR.
- The user has more leverage right now from quota-aware routing (one identity
  per CLI but smarter about which jobs go where), which is being scoped
  separately. Multi-identity is a force-multiplier on top of quota routing,
  not a prerequisite.

Pick this up after audit-presets + quota tiers ship and we have real data on
how much per-account routing would actually win.
