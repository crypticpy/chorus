# PR Babysitter — Design Sketch

Status: draft for review. No code yet.

## What we're replacing

Today the team subscribes to CodeRabbit, Sourcery, and Greptile (plus opportunistic Copilot/Codex). PRs land, the bots dump comments, and a Claude Code skill ("pr-babysitter") loops through the comments and addresses each one — push a fix or reply with justification — until everyone goes quiet, then squash-merges. The skill runs synchronously inside the user's Claude Code session, on Opus, paying full Opus prices for every step including the trivial ones (rename a var, add a null check, fix a typo).

We want to move that loop into the Chorus daemon. Claude Code's role shrinks to: open the PR, then disengage. The daemon takes over, runs the loop in the background, surfaces a single "merged" notification when done. Three things change for the better:

- **Survives the session ending.** Daemon doesn't care if Claude Code is closed.
- **Routing.** The judge phase (is this comment valid? trivial or architectural?) runs once on a strong model. Trivial fixes get routed to a cheap model (Kimi/Haiku/Gemini Flash). Architectural fixes escalate to Opus. Replies are written by the judge directly with no second model call. Empirically ~80% of bot feedback is mechanical; this is where token spend collapses.
- **Observability.** Cockpit gets a live "what's the babysitter doing on PR #47 right now" view that today only exists as Claude Code scrollback.

What gets harder: state management, GH App setup, the discipline of building circuit breakers so the daemon doesn't burn forever in a loop. That's most of this doc.

## Phased delivery

The whole thing is too big for one PR. Three phases, each shippable independently:

- **Phase A** — GH App + webhook receiver + manual `chorus babysit <pr-url>` MCP tool. Polling mode (no daemon event loop yet). Validates auth, comment reading, and the judge prompt design end-to-end. ~1-2 days.
- **Phase B** — Daemon event loop (state machine driven by webhooks), fix dispatch, verify gate, push, merge. The babysit logic runs unattended. ~3-5 days.
- **Phase C** — Cockpit UI (babysitter page), audit log, multi-PR parallelism, escalation notifications. ~2-3 days.

Phase A's design validates everything downstream. If the judge prompt doesn't reliably categorize comments, the rest of the system is wasted. So Phase A's deliverable is a thoroughly tuned judge, not just a stub.

## State machine (per PR)

```
                                    ┌──────────┐
                              ┌─────│   idle   │◀────────────────┐
                              │     └──────────┘                 │
   PR opened / new commit /   │           ▲                      │
   new bot review event ──────┘           │                      │
                              ▼           │ no new events in W   │
                        ┌──────────┐      │ since last activity  │
                        │ judging  │      │                      │
                        └──────────┘      │                      │
                              │           │                      │
            ┌─────────────────┼──────────────────────────────┐   │
            ▼                 ▼                              ▼   │
       ┌─────────┐       ┌────────┐                    ┌─────────┴┐
       │ fixing  │       │replying│                    │quiet_check│
       └─────────┘       └────────┘                    └─────────┬┘
            │                 │                              │
            ▼                 │                              │
       ┌──────────┐           │                              │
       │verifying │           │                              │
       └──────────┘           │                              │
        ┌──┴──┐               │                              │
   fail │     │ pass          │                              │
        ▼     ▼               ▼                              │
   ┌────────┐ ┌─────────┐                              ┌─────▼────┐
   │escalated│ │ pushing │─────────────────────────────│  merged   │
   └────────┘ └─────────┘                              └──────────┘
```

States persist in a `babysit_jobs` table (one row per PR). Transitions are event-driven once we move past Phase A.

Terminal states are `merged` and `escalated`. `escalated` means a human needs to intervene; the daemon stops touching the PR until a human resumes it.

## GH App

A GitHub App is the right primitive — per-installation tokens scoped to selected repos, auto-rotating creds, native webhook delivery, can be installed org-wide later. Setup we need:

**Permissions:**

- Pull requests: read & write (read PRs/comments, post replies, request reviewers if needed)
- Contents: read & write (clone, push fixes, merge)
- Checks: read (gate on CI green)
- Metadata: read (mandatory; comes free)

**Webhook events subscribed:**

- `pull_request` — opened, synchronize (new push), closed, reopened
- `pull_request_review` — submitted (CodeRabbit posts these)
- `pull_request_review_comment` — created (inline comments)
- `issue_comment` — created (general PR comments; Sourcery posts these)
- `check_run` — completed (CI status changes)
- `push` — for branch updates outside the PR flow

**Auth flow:**

1. Daemon signs a JWT with the App's private key (PEM stored in `~/.chorus/gh-app.pem`).
2. Calls `POST /app/installations/{installation_id}/access_tokens` → installation token (TTL ~1hr).
3. Caches the token in-memory, refreshes before TTL.
4. Per-event: look up `installation_id` from the webhook payload, use the cached token for that installation.

**Webhook delivery:**

- New Fastify route: `POST /webhooks/github` on the daemon.
- Verifies `X-Hub-Signature-256` against a shared secret (stored in `~/.chorus/gh-webhook.secret`).
- Enqueues the event into a per-PR work queue.
- Returns 200 immediately (work happens async).

**Local dev:**

- For users not exposing port 7707 to the public internet, `chorus babysit --proxy smee.io/<channel>` runs a smee client that proxies webhooks to the local daemon. Same pattern probot uses.
- For production self-hosted: expose the daemon via Cloudflare Tunnel / Tailscale Funnel / etc.

## The judge phase — the heart of the system

For every new bot comment that arrives on a babysat PR, the judge decides four things:

### 1. Is this comment actionable?

Skip outright if:

- The comment is from a non-bot human (humans → escalate, don't auto-handle)
- The comment is on a thread the bot already marked resolved
- The comment is identical to one already addressed in a prior round (de-dup by hash of comment body + file:line anchor)
- The comment is a "LGTM" / "no issues found" / approval (no action needed; counts toward "quiet")
- The comment is on a file the PR didn't touch (stale comment from a force-pushed-over commit)

### 2. Is the comment correct?

This is the judgment call. The prompt gives the judge:

- The full comment text
- The file:line range it anchors to
- ~50 lines of context around that range (from current HEAD, not the comment's original commit — bots sometimes lag)
- The PR title + 1-line description (to anchor "what's this PR trying to do")
- A short signal of which bot posted it (some bots have known biases — CodeRabbit over-flags performance, Sourcery over-flags style)

The judge emits a structured verdict: `valid` | `invalid` | `partially_valid` | `unsure`.

### 3. What's the response category?

Conditional on validity:

| Validity          | Category                      | Action                                                                                              |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `valid`           | `apply-trivial-fix`           | 1-3 line change, mechanical (rename, null check, regex tweak, import order). Routes to cheap model. |
| `valid`           | `apply-targeted-fix`          | Single function/file scope, needs reasoning. Routes to mid-tier model (Sonnet, Gemini 2.5 Pro).     |
| `valid`           | `apply-architectural-fix`     | Multi-file or design change. Routes to Opus, OR escalates if confidence below threshold.            |
| `invalid`         | `reply-pushback`              | Judge writes a 1-2 sentence reply explaining why the comment is wrong. No second model call.        |
| `partially_valid` | `apply-partial-fix-and-reply` | Judge writes a reply explaining the partial acceptance + dispatches a fix for the part it accepted. |
| `unsure`          | `defer-to-human`              | Tag the user, halt the loop for this PR (state → escalated).                                        |

### 4. Confidence score (0-1)

Judge attaches a confidence to its categorization. Below threshold (default 0.7) → forced to `defer-to-human` regardless of category. This is the kill switch when the judge isn't sure of itself.

### Judge model selection

**Recommendation: single judge with periodic shadow.**

Primary judge: Opus or GPT-5.5 (one model, consistency matters). Shadow judge: every N-th comment (default N=10) also gets a Sonnet judgment, recorded but not acted on. If the shadow disagrees with the primary regularly (>20% of the time), the audit log flags it for human review — that's the signal to retune the prompt or swap the primary.

Multi-judge with majority gate was the other option. Rejected for v1 because: (a) it doubles judge cost, (b) for _judgment_ (not implementation), one strong model is usually right, (c) the shadow pattern catches systemic problems without paying every time.

### Batching

Bots dump comments in waves — CodeRabbit will post 20 comments within 5 seconds when it finishes scanning. Don't fire the judge once per comment. Window: collect comments for 60 seconds after the first new one arrives, then batch them through the judge in one prompt:

> "Here are 12 new comments on PR #47. For each, decide: actionable? valid? category? confidence? Reply with structured JSON."

This is both cheaper (one judge call per batch) and produces better diffs downstream: all the trivial fixes that touch the same file get grouped into one fix turn, so the doer makes one clean edit instead of five separate single-line edits.

## Fix routing

After the judge batch, group accepted fixes by file. For each file:

- `apply-trivial-fix` group → dispatch to Kimi or Haiku.
- `apply-targeted-fix` group → Sonnet or Gemini 2.5 Pro.
- `apply-architectural-fix` group → Opus.

The doer gets:

- The list of accepted comments grouped by file
- The current file contents (cap: 64KB; if larger, only the affected hunks ±100 lines)
- A directive: "Apply these fixes. Make ONLY the changes required by the comments. Do not refactor surrounding code. Return the file contents to write back, OR a unified diff."

Output handling:

- If the doer returns full file contents → write atomically.
- If unified diff → apply via `git apply`. On reject, retry once with full-file mode; second failure → escalate.

Replies (`reply-pushback`, `reply-acknowledge`, `reply-partial`) are batched separately and posted to GitHub in a single API burst after fixes verify and push. Reply text:

- `pushback`: "Acknowledged — this is intentional because _[one-sentence reason]_. Not changing."
- `partial`: "Good catch on _[X]_ — fixed in <commit>. The _[Y]_ part is intentional because _[reason]_."
- `acknowledge`: "Noted, thanks." (only when the comment is informational, not asking for change.)

The judge writes these reply strings directly during its judgment turn. Never separate model calls for replies.

## Verify gate

Phase A: not yet (manual mode means humans verify before merging).

Phase B onward: NEVER push without verify passing. The verify command comes from `package.json` `chorus.verify` field (see issue #verify-phase). Default: `pnpm typecheck && pnpm test --bail`.

Verify runs in the per-PR worktree (already created at babysit start). If verify fails after a fix turn:

- First failure: TDD loop kicks in — re-prompt the doer with the failure output, max 3 retries on the same fix batch.
- Third failure: escalate the entire babysit for that PR.

This is the same TDD loop wired in issue #tdd-loop, reused.

## Circuit breakers

Multiple defenses against pathological loops:

| Breaker                 | Threshold (default)                                | What it stops                                |
| ----------------------- | -------------------------------------------------- | -------------------------------------------- |
| Per-comment attempt cap | 3 fixes to the same comment hash                   | Bot keeps re-flagging the same thing         |
| PR-wide fix cap         | 15 total fix commits                               | Something is fundamentally wrong with the PR |
| Time cap                | 4 hours of babysit time                            | Hung loop, hung bot, hung CI                 |
| Confidence threshold    | 0.7 minimum on judge category                      | Defer when uncertain                         |
| Bot disagreement gate   | If two bots flag the same hunk with opposing fixes | Reply explaining conflict, defer to human    |
| CI red gate             | Any CI failure → halt                              | CI failures need human eyes, not babysit     |
| Force-push detection    | Human force-pushes the branch                      | Pause until human resumes                    |

Hitting any breaker → state moves to `escalated`. The user gets a notification (Slack via webhook, or Cockpit alert). The PR is not touched again until a human runs `chorus babysit <pr-url> --resume`.

## Merge gate

All must be true before squash-merge:

- All required CI checks green (read from `check_run` events)
- Two consecutive quiet polls 3-5 minutes apart with no new bot activity, no new commits, no new comments
- All required reviewers approved (if branch protection requires them)
- No unresolved threads from human (non-bot) reviewers
- Total babysit time under cap
- At least one fix pushed OR at least one comment replied (don't auto-merge a PR the daemon did nothing to)
- Daemon configuration allows auto-merge on this repo (opt-in per-repo, not org-wide)

If gate passes: squash-merge with `--delete-branch`. Post a final summary comment:

> Babysat by Chorus. _N_ fixes pushed across _M_ commits, _K_ comments replied. Merged at `<sha>`.

If the gate fails for any reason after a long wait: → `escalated`.

## Multi-PR coordination

Daemon should babysit multiple PRs in parallel. Constraints:

- One worktree per PR (extends the existing per-worker worktree pattern from `orchestrate-manifest-routes`). Each babysit gets its own checked-out branch in a per-job directory.
- Per-repo serialization on git push only (don't try to push two babysit branches to the same repo at the exact same instant — sequence them).
- Global semaphore on CLI model calls already exists (`cli-semaphore.ts`) — reuse it.
- DB row per babysit job, status tracked. Webhook events dispatch to the right job by `(repo, pr_number)`.

## DB schema additions

```sql
-- One row per PR being babysat (or that has been babysat)
CREATE TABLE babysit_jobs (
  id TEXT PRIMARY KEY,              -- "<owner>/<repo>#<number>"
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  installation_id INTEGER NOT NULL, -- GH App installation
  state TEXT NOT NULL,              -- idle | judging | fixing | verifying | pushing | waiting | quiet_check | escalated | merged
  worktree_path TEXT,               -- absolute path to the per-PR worktree
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  fix_commits INTEGER DEFAULT 0,    -- circuit breaker counter
  total_judge_calls INTEGER DEFAULT 0,
  total_fix_calls INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  escalation_reason TEXT,           -- null unless state=escalated
  UNIQUE (repo, pr_number)
);

-- Audit trail: every judge decision recorded
CREATE TABLE babysit_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES babysit_jobs(id),
  decided_at INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,      -- GH comment id
  comment_author TEXT NOT NULL,
  comment_hash TEXT NOT NULL,       -- for dedup + per-comment-attempt counting
  bot TEXT,                         -- "coderabbit" | "sourcery" | "greptile" | etc.
  validity TEXT NOT NULL,           -- valid | invalid | partially_valid | unsure
  category TEXT NOT NULL,           -- apply-* | reply-* | defer-to-human
  confidence REAL NOT NULL,
  judge_model TEXT NOT NULL,
  shadow_judge_model TEXT,          -- nullable; only set when N-th sample fires
  shadow_validity TEXT,             -- null unless shadow ran
  shadow_disagreed INTEGER DEFAULT 0,
  fix_model TEXT,                   -- nullable; null for reply categories
  outcome TEXT,                     -- "fixed" | "replied" | "verify_failed" | "escalated"
  outcome_commit TEXT               -- nullable; sha if outcome=fixed
);
```

## Tooling delivered alongside Phase A

- `POST /webhooks/github` — Fastify route on the daemon.
- `chorus babysit <pr-url>` — CLI command that registers a PR for babysitting (writes to `babysit_jobs`).
- `chorus babysit list` — CLI command that lists active jobs + their state.
- `chorus babysit pause <pr-url>` / `chorus babysit resume <pr-url>` — manual state control.
- `mcp__chorus__babysit_pr` — MCP tool wrapping the above for Claude Code.
- `presets/pr-babysit.yaml` — template defining the judge + fix phases.

## Open questions for the team

1. **Auto-merge opt-in granularity.** Per-repo? Per-PR label? Per-user? Default: per-repo, requires `.chorus.yml` in repo root with `auto_merge: true`. Without that, daemon does the babysit but stops short of merging, leaves it for human to click.

2. **Human reviewer interaction.** If a human (non-bot) posts a comment mid-babysit, do we pause everything, or let the bot loop continue and surface the human comment in cockpit? Default: pause, alert the user. Human comments are higher signal.

3. **Reply threshold for "we already addressed this."** If we fix something and the bot re-flags the same issue, the judge sees the comment as a new comment but the comment_hash matches. Do we silently increment the attempt counter, or post a reply explaining "we addressed this in <commit>, can you re-evaluate?" Default: reply once, then silently count.

4. **Cross-bot deduplication.** CodeRabbit and Sourcery sometimes flag the same issue with different wording. Currently the dedup is by exact text hash. Should we add semantic dedup? Default: no, too complex for v1; let the judge see both, it'll classify them the same way.

5. **Cost cap.** Should the daemon enforce a per-PR token spend cap (e.g. "don't spend more than $5 of model time on this PR")? Default: yes, configurable; default $10/PR, alert at 50%, escalate at 100%.

These questions are intentionally open. Phase A gives us data to answer them; Phase B's design can revisit.
