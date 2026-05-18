/**
 * State-machine driver for the PR-babysit loop.
 *
 * One entry point: `runJob(job, deps)`. The scheduler calls this for
 * every dispatchable job each tick. Internally we dispatch on
 * `job.state` to a per-state handler and apply the resulting
 * transition via `babysitJobs.setState`. Handlers are pure-ish: they
 * read the job, perform their work via injected `deps`, and return a
 * transition descriptor — they never call setState themselves, so
 * the driver owns all state writes.
 *
 * State transitions:
 *
 *   idle           → judging       (first tick after registration)
 *   judging        → fixing        (any unjudged comment routes to a fix)
 *   judging        → quiet_check   (all comments routed to reply/skip)
 *   judging        → escalated     (any decision says escalate)
 *   fixing         → verifying     (doer produced edits)
 *   fixing         → escalated     (doer failure)
 *   verifying      → pushing       (verify passed)
 *   verifying      → escalated     (verify failed; we don't auto-retry)
 *   pushing        → quiet_check   (pushed OR no_changes)
 *   pushing        → escalated     (git failure)
 *   quiet_check    → judging       (new comments arrived since last poll)
 *   quiet_check    → merged        (PR is merged on GitHub)
 *
 * Why escalate-on-verify-fail (rather than re-run the doer): the
 * judge already escalates after PER_COMMENT_ATTEMPT_CAP attempts.
 * Verify-fail on a single attempt is rare enough that surfacing it
 * once is more useful than burning another fix cycle that's likely
 * to fail the same way. The cap path will catch the genuinely-stuck
 * case naturally.
 *
 * Per-job worktree: ensureWorktree() runs at the idle→judging
 * transition so subsequent ticks reuse it cheaply. removeWorktree()
 * is left to a later cleanup pass — leaving the dir around lets the
 * operator inspect what the doer produced after an escalation.
 */
import {
  babysitDecisions,
  babysitJobs,
  type BabysitJob,
  type BabysitState,
  type Validity,
} from "../../lib/db/index.js";
import { fetchPrComments, type RawPrComment } from "./comment-fetcher.js";
import { applyFixForComment, type ApplyFixResult } from "./fix-executor.js";
import { ghRequest, type GhClientDeps } from "./gh-client.js";
import { commitAndPush, type CommitAndPushResult } from "./git-push.js";
import {
  decideAction,
  judgeComment,
  type ActionDecision,
  type JudgeCommentResult,
} from "./judge.js";
import { fetchPrMetadata, type PrMetadata } from "./pr-metadata.js";
import { runVerify, type VerifyResult } from "./verifier.js";
import { ensureWorktree } from "./worktree-manager.js";

export interface StateMachineDeps {
  /** Source repo path — where the user's main checkout of the repo
   *  lives. Required so the worktree manager can `git worktree add`
   *  off it. The registrar resolves this from the babysit job's
   *  registered repo (currently a process-wide assumption that the
   *  daemon's CWD owns the repo; will gain per-repo config later). */
  sourceRepoPath: string;
  /** Default doer lineage/model for fix-tier work. Trivial + targeted
   *  go to the same default; architectural would normally promote to
   *  a stronger model, but the template's reviewer.candidates handles
   *  that at the judge layer — by the time we reach the doer the
   *  decision already accounts for tier. */
  doerLineage: string;
  doerModel: string;
  /** GH client deps for testability — pass-through to ghRequest. */
  ghDeps?: GhClientDeps;
  /** Per-call timeouts (judges + doers are slow LLM calls). */
  judgeTimeoutMs?: number;
  doerTimeoutMs?: number;
  /** Judge model config. Defaults to the haiku-tier model below if
   *  unset — judging is short, cheap, and benefits from a cheaper
   *  model than the doer. Override only when the caller has a specific
   *  routing requirement. */
  judgeLineage?: string;
  judgeModel?: string;
  /** Optional caller-controlled abort signal for shutdown / cancellation.
   *  Forwarded to the judge LLM call so a daemon stop can interrupt
   *  in-flight judging instead of waiting for the LLM timeout. */
  abortSignal?: AbortSignal;
  /** Optional override for the in-flight tick logger. */
  log?: (line: string) => void;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 90_000;
const DEFAULT_DOER_TIMEOUT_MS = 5 * 60_000;

interface Transition {
  /** Where the driver will move the job after this tick. */
  nextState: BabysitState;
  /** Optional escalation reason, surfaced via setState extras. */
  escalationReason?: string | null;
  /** Optional worktree_path to record on the job (set on first
   *  successful ensureWorktree). */
  worktreePath?: string | null;
}

/**
 * Driver. Called once per tick by the scheduler for each dispatchable
 * job. Errors thrown from here bubble to the scheduler's per-job
 * catch — the loop survives, the job stays in whatever state it was
 * in (next tick will retry the same handler).
 */
export async function runJob(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<void> {
  const log = deps.log ?? (() => {});
  log(`[${job.id}] tick — state=${job.state}`);

  let transition: Transition;
  switch (job.state) {
    case "idle":
      transition = await handleIdle(job, deps);
      break;
    case "judging":
      transition = await handleJudging(job, deps);
      break;
    case "fixing":
      transition = await handleFixing(job, deps);
      break;
    case "verifying":
      transition = await handleVerifying(job, deps);
      break;
    case "pushing":
      transition = await handlePushing(job, deps);
      break;
    case "quiet_check":
      transition = await handleQuietCheck(job, deps);
      break;
    case "waiting":
      // Reserved by the design doc for future use (waiting on
      // external CI). Treat as idle for now.
      transition = { nextState: "judging" };
      break;
    case "merged":
    case "escalated":
    case "paused":
      // Driver shouldn't have been called — the scheduler filters
      // these out. Defensive no-op transition keeps state intact.
      transition = { nextState: job.state };
      break;
  }

  if (
    transition.nextState !== job.state ||
    transition.escalationReason ||
    transition.worktreePath !== undefined
  ) {
    await babysitJobs.setState(job.id, transition.nextState, {
      escalation_reason: transition.escalationReason ?? null,
      worktree_path: transition.worktreePath ?? null,
    });
  }
  log(`[${job.id}] → ${transition.nextState}`);
}

// ---------- Handlers ----------

async function handleIdle(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<Transition> {
  // First tick after registration: provision the worktree, then
  // hand off to handleJudging by transitioning to "judging".
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) {
    return {
      nextState: "escalated",
      escalationReason: `repo id malformed: ${job.repo}`,
    };
  }

  // Need the PR head branch before we can check out a worktree.
  const meta = await fetchPrMetadata(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: deps.sourceRepoPath,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!meta.ok) {
    return {
      nextState: "escalated",
      escalationReason: `metadata fetch failed (${meta.reason}): ${meta.detail}`,
    };
  }

  const ensured = await ensureWorktree({
    repo: job.repo,
    prNumber: job.pr_number,
    sourceRepoPath: deps.sourceRepoPath,
    branch: meta.meta.headBranch,
  });
  if (!ensured.ok) {
    return {
      nextState: "escalated",
      escalationReason: `worktree setup failed (${ensured.reason}): ${ensured.detail}`,
    };
  }

  return { nextState: "judging", worktreePath: ensured.worktreePath };
}

async function handleJudging(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<Transition> {
  if (!job.worktree_path) {
    return {
      nextState: "idle",
      // Should be unreachable in normal flow — falling back to idle
      // lets the next tick re-provision rather than escalating.
    };
  }
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) {
    return {
      nextState: "escalated",
      escalationReason: `repo id malformed: ${job.repo}`,
    };
  }

  const meta = await fetchPrMetadata(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!meta.ok) {
    return {
      nextState: "escalated",
      escalationReason: `metadata fetch failed: ${meta.detail}`,
    };
  }
  if (meta.meta.state === "merged") {
    return { nextState: "merged" };
  }
  if (meta.meta.state === "closed") {
    return {
      nextState: "escalated",
      escalationReason: "PR closed without merge",
    };
  }

  const fetched = await fetchPrComments(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!fetched.ok) {
    return {
      nextState: "escalated",
      escalationReason: `comment fetch failed (${fetched.reason}): ${fetched.detail}`,
    };
  }

  // Filter to bot comments we haven't already judged (by hash).
  const unjudged = await filterUnjudged(job.id, fetched.comments);
  if (unjudged.length === 0) {
    return { nextState: "quiet_check" };
  }

  // Judge each unjudged comment in sequence. Sequential because the
  // per-job mutex already serializes ticks, AND because the judge
  // model has rate limits we don't want to fight.
  let sawFix = false;
  let sawReply = false;
  let escalationReason: string | null = null;

  for (const comment of unjudged) {
    const judged = await runJudgeForComment(comment, meta.meta, job, deps);
    if (!judged.ok) {
      // Judge spawn/parse failure — persist nothing, escalate so a
      // human can look at why the model is misbehaving.
      escalationReason = `judge failure on comment ${comment.id} (${judged.reason}): ${judged.detail}`;
      break;
    }
    const attemptCount = await babysitDecisions.getAttemptCount(
      job.id,
      comment.bodyHash,
    );
    const action = decideAction(judged.judgement, {
      attemptCount,
      belowThreshold: judged.belowThreshold,
    });
    await babysitDecisions.create({
      job_id: job.id,
      comment_id: comment.id,
      comment_author: comment.authorLogin,
      comment_hash: comment.bodyHash,
      bot: comment.bot ?? "unknown",
      validity: judged.judgement.validity,
      category: judged.judgement.category,
      confidence: judged.judgement.confidence,
      judge_model: judged.modelUsed,
    });

    const followup = await dispatchAction(action, comment, job, deps);
    if (followup === "reply") sawReply = true;
    if (followup === "fix") {
      // Only the handleFixing/handlePushing chain consumes one
      // outcome=null apply-* decision per pass. If we kept looping
      // and inserted decisions for every unjudged comment, every fix
      // past the first would be stranded — quiet_check() filters by
      // hash, not by pending-decision rows. Break after the first
      // fix and let the next tick pick up the next one.
      sawFix = true;
      break;
    }
    if (followup === "escalate") {
      escalationReason = `decision escalated: ${(action as { reason?: string }).reason ?? "unknown"}`;
      break;
    }
  }

  if (escalationReason) {
    return { nextState: "escalated", escalationReason };
  }
  // sawReply is currently observability-only; reply posts happen
  // inline above so the only state-routing question is whether any
  // fix landed.
  void sawReply;
  if (sawFix) {
    return { nextState: "fixing" };
  }
  // Replies were posted inline; nothing left to do until bots react.
  return { nextState: "quiet_check" };
}

async function handleFixing(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<Transition> {
  if (!job.worktree_path) {
    return {
      nextState: "escalated",
      escalationReason: "fixing without a worktree_path",
    };
  }
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) {
    return {
      nextState: "escalated",
      escalationReason: `repo id malformed: ${job.repo}`,
    };
  }

  // Find the comment we need to fix: the most recent decision for
  // this job whose action implied a fix and whose outcome is null
  // (= not yet attempted). This keeps the handler resumable —
  // crashing mid-fix leaves the row available for the next tick.
  const pending = await babysitDecisions.listForJob(job.id);
  const target = pending.find(
    (d) =>
      (d.category === "apply-trivial" ||
        d.category === "apply-targeted" ||
        d.category === "apply-architectural") &&
      d.outcome === null,
  );
  if (!target) {
    // No pending fix — caller's bookkeeping is out of sync. Bounce
    // back to judging so we re-evaluate from the comment list.
    return { nextState: "judging" };
  }

  // Re-fetch the comment text — the decision table only has the
  // hash. We need the raw body for the doer prompt.
  const comments = await fetchPrComments(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!comments.ok) {
    return {
      nextState: "escalated",
      escalationReason: `comment refetch failed: ${comments.detail}`,
    };
  }
  const matched = comments.comments.find((c) => c.id === target.comment_id);
  if (!matched) {
    // Comment vanished (deleted by author?) — mark escalated so a
    // human can confirm intent, return to judging so the loop keeps
    // moving on any remaining work.
    await babysitDecisions.setOutcome(target.id, "escalated", null);
    return {
      nextState: "judging",
    };
  }

  const meta = await fetchPrMetadata(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!meta.ok) {
    return {
      nextState: "escalated",
      escalationReason: `metadata fetch failed during fix: ${meta.detail}`,
    };
  }

  const tier =
    target.category === "apply-architectural"
      ? "architectural"
      : target.category === "apply-targeted"
        ? "targeted"
        : "trivial";

  const fixed: ApplyFixResult = await applyFixForComment({
    worktreePath: job.worktree_path,
    comment: matched,
    // We don't persist the judge's free-text rationale (schema only
    // stores the structured classification: validity / category /
    // confidence). Synthesize a short descriptor from what we DO have
    // so the doer sees an honest summary instead of being misled by
    // a single-word validity enum. The full comment body is also in
    // `comment`, so the doer isn't context-starved.
    judgementRationale: `Judge classified this comment as ${target.validity} (${target.category}, confidence ${target.confidence.toFixed(2)}).`,
    tier,
    ctx: {
      owner,
      repo,
      prNumber: job.pr_number,
      title: meta.meta.title,
      baseBranch: meta.meta.baseBranch,
    },
    lineage: deps.doerLineage,
    model: deps.doerModel,
    timeoutMs: deps.doerTimeoutMs ?? DEFAULT_DOER_TIMEOUT_MS,
  });

  if (!fixed.ok) {
    await babysitDecisions.setOutcome(target.id, "escalated", null);
    return {
      nextState: "escalated",
      escalationReason: `doer failed (${fixed.reason}): ${fixed.detail}`,
    };
  }

  // Record fix model + commit message in the decision so the verify
  // handler can find this row. We don't set outcome yet — push will.
  await babysitJobs.incrementCounters(job.id, {
    total_fix_calls: 1,
  });
  return { nextState: "verifying" };
}

async function handleVerifying(
  job: BabysitJob,
  _deps: StateMachineDeps,
): Promise<Transition> {
  if (!job.worktree_path) {
    return {
      nextState: "escalated",
      escalationReason: "verifying without a worktree_path",
    };
  }
  const verify: VerifyResult = await runVerify({
    worktreePath: job.worktree_path,
  });
  if (!verify.ok) {
    return {
      nextState: "escalated",
      escalationReason: `verify failed (${verify.mode}, exit ${verify.exitCode}):\n${verify.output.slice(0, 2_000)}`,
    };
  }
  return { nextState: "pushing" };
}

async function handlePushing(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<Transition> {
  if (!job.worktree_path) {
    return {
      nextState: "escalated",
      escalationReason: "pushing without a worktree_path",
    };
  }
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) {
    return {
      nextState: "escalated",
      escalationReason: `repo id malformed: ${job.repo}`,
    };
  }
  const meta = await fetchPrMetadata(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!meta.ok) {
    return {
      nextState: "escalated",
      escalationReason: `metadata fetch failed during push: ${meta.detail}`,
    };
  }

  const pushed: CommitAndPushResult = await commitAndPush({
    worktreePath: job.worktree_path,
    branch: meta.meta.headBranch,
    commitMessage:
      "fix: address PR review comment\n\nCommitted by chorus-babysit.",
  });

  if (!pushed.ok) {
    return {
      nextState: "escalated",
      escalationReason: `git ${pushed.reason}: ${pushed.detail}`,
    };
  }

  // Mark the most recent pending fix decision as completed.
  const pending = await babysitDecisions.listForJob(job.id);
  const target = pending.find(
    (d) =>
      (d.category === "apply-trivial" ||
        d.category === "apply-targeted" ||
        d.category === "apply-architectural") &&
      d.outcome === null,
  );
  if (target) {
    if (pushed.outcome === "pushed") {
      await babysitDecisions.setOutcome(target.id, "fixed", pushed.commitSha);
      await babysitJobs.incrementCounters(job.id, { fix_commits: 1 });
    } else {
      // no_changes — the doer's rewrite produced identical content.
      // Treat as escalated so a human can confirm the comment doesn't
      // actually need a follow-up. Surface the escalation at the JOB
      // level too — quiet_check filters by hash so a decision-only
      // escalation would otherwise sit invisible until the bot
      // re-comments with a different body.
      await babysitDecisions.setOutcome(target.id, "escalated", null);
      return {
        nextState: "escalated",
        escalationReason: `fix for comment ${target.comment_id} produced no file changes`,
      };
    }
  }

  return { nextState: "quiet_check" };
}

async function handleQuietCheck(
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<Transition> {
  if (!job.worktree_path) {
    // No worktree — fall back to judging so handleIdle's
    // provisioning path can recover.
    return { nextState: "judging" };
  }
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) {
    return {
      nextState: "escalated",
      escalationReason: `repo id malformed: ${job.repo}`,
    };
  }
  const meta = await fetchPrMetadata(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!meta.ok) {
    return {
      nextState: "escalated",
      escalationReason: `metadata fetch failed during quiet_check: ${meta.detail}`,
    };
  }
  if (meta.meta.state === "merged") {
    return { nextState: "merged" };
  }
  if (meta.meta.state === "closed") {
    return {
      nextState: "escalated",
      escalationReason: "PR closed without merge",
    };
  }

  // Look for new comments. The simplest "is anything new" check: any
  // bot comment whose hash isn't yet in babysit_decisions for this
  // job. Promote back to judging if so; otherwise stay in
  // quiet_check until either a merge or a new comment.
  const fetched = await fetchPrComments(
    {
      owner,
      repo,
      prNumber: job.pr_number,
      cwd: job.worktree_path,
      installationId: job.installation_id,
    },
    deps.ghDeps,
  );
  if (!fetched.ok) {
    return {
      nextState: "escalated",
      escalationReason: `comment fetch failed in quiet_check: ${fetched.detail}`,
    };
  }
  const unjudged = await filterUnjudged(job.id, fetched.comments);
  if (unjudged.length > 0) {
    return { nextState: "judging" };
  }
  return { nextState: "quiet_check" };
}

// ---------- helpers ----------

async function filterUnjudged(
  jobId: string,
  comments: ReadonlyArray<RawPrComment>,
): Promise<RawPrComment[]> {
  // Only judge bot comments — human comments aren't part of the
  // bot-review babysit loop.
  const bots = comments.filter((c) => c.isBot);
  const decisions = await babysitDecisions.listForJob(jobId);
  const seen = new Set(decisions.map((d) => d.comment_hash));
  return bots.filter((c) => !seen.has(c.bodyHash));
}

async function runJudgeForComment(
  comment: RawPrComment,
  meta: PrMetadata,
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<JudgeCommentResult> {
  if (!job.worktree_path) {
    throw new Error("runJudgeForComment requires worktree_path");
  }
  // Pull prior decisions on this exact hash so the judge sees
  // attempt history.
  const allDecisions = await babysitDecisions.listForJob(job.id);
  const priors = allDecisions
    .filter((d) => d.comment_hash === comment.bodyHash)
    .map((d) => ({
      decided_at: d.decided_at,
      validity: d.validity as Validity,
      category: d.category,
      outcome: d.outcome ?? null,
    }));
  return judgeComment({
    comment,
    ctx: {
      owner: meta.owner,
      repo: meta.repo,
      prNumber: meta.prNumber,
      title: meta.title,
      baseBranch: meta.baseBranch,
      priorDecisions: priors,
    },
    // Judge runs cheap-tier by default — short classification call,
    // not architecture-altering — but the caller can override via deps
    // (e.g., a daemon configured for an alt-provider judge).
    lineage: deps.judgeLineage ?? "anthropic",
    model: deps.judgeModel ?? "claude-haiku-4-5",
    cwd: job.worktree_path,
    timeoutMs: deps.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
    // Forward the caller's abort signal so a daemon shutdown / job
    // pause can actually interrupt judging mid-flight. The previous
    // orphan AbortController had no abort() path, so the signal was
    // dead and the LLM call could only be cancelled via timeout.
    abortSignal: deps.abortSignal ?? new AbortController().signal,
  });
}

/** Apply the action decided for a single comment. Returns the
 *  follow-up category so the caller can aggregate ("did any of these
 *  push us into fixing?"). */
async function dispatchAction(
  action: ActionDecision,
  comment: RawPrComment,
  job: BabysitJob,
  deps: StateMachineDeps,
): Promise<"fix" | "reply" | "escalate" | "skip"> {
  if (action.kind === "fix") return "fix";
  if (action.kind === "skip") return "skip";
  if (action.kind === "escalate") return "escalate";

  // reply path — post the comment via GH client. We POST to the
  // issue comments endpoint regardless of comment kind (review vs
  // issue) because issue comments thread under the conversation
  // tab; review-comment replies need a different endpoint we'll
  // wire later. For v1 this is good enough.
  const [owner, repo] = job.repo.split("/");
  if (!owner || !repo) return "skip";
  const reply = await ghRequest(
    {
      method: "POST",
      path: `repos/${owner}/${repo}/issues/${job.pr_number}/comments`,
      body: { body: action.text },
      cwd: job.worktree_path ?? deps.sourceRepoPath,
      installationId: job.installation_id ?? undefined,
    },
    deps.ghDeps,
  );
  if (!reply.ok) {
    // Surface the failure but don't escalate — the next tick may
    // succeed (transient API issue). We still want to count this
    // attempt so the per-comment cap eventually fires.
    void comment;
    return "skip";
  }
  return "reply";
}
