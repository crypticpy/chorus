/**
 * Tests for the babysit judge's pure helpers.
 *
 * `judgeComment` itself isn't unit-tested here — it just glues
 * `buildJudgePrompt` to `requestStructured`, which has its own test
 * coverage and would need a fake CLI shim to exercise. The interesting
 * logic is in:
 *
 *   - buildJudgePrompt: what we ask the model to do
 *   - decideAction: the pure routing decision tree (the state machine
 *     in runner.ts will consume this directly)
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  PER_COMMENT_ATTEMPT_CAP,
  buildJudgePrompt,
  decideAction,
  type JudgeOutput,
  type JudgePrContext,
} from "../src/daemon/babysit/judge.js";
import type { RawPrComment } from "../src/daemon/babysit/comment-fetcher.js";
import { hashCommentBody } from "../src/daemon/babysit/comment-fetcher.js";

function makeComment(overrides: Partial<RawPrComment> = {}): RawPrComment {
  const body = overrides.body ?? "Suggest extracting this helper.";
  return {
    id: 1,
    kind: "review",
    authorLogin: "coderabbitai[bot]",
    isBot: true,
    bot: "coderabbit",
    body,
    bodyHash: hashCommentBody(body),
    createdAt: "2026-05-15T10:00:00Z",
    path: "src/foo.ts",
    line: 42,
    htmlUrl: "https://github.com/x/y/pull/1#discussion_r1",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<JudgePrContext> = {}): JudgePrContext {
  return {
    owner: "x",
    repo: "y",
    prNumber: 1,
    title: "Add foo",
    baseBranch: "main",
    ...overrides,
  };
}

describe("buildJudgePrompt", () => {
  it("includes the comment body, author, and PR metadata", () => {
    const out = buildJudgePrompt(makeComment(), makeCtx());
    expect(out).toContain("@coderabbitai[bot]");
    expect(out).toContain("recognised bot: `coderabbit`");
    expect(out).toContain("x/y#1");
    expect(out).toContain("Add foo");
    expect(out).toContain("Suggest extracting this helper.");
    expect(out).toContain("src/foo.ts");
    expect(out).toContain(":42");
  });

  it("omits the bot tag for human authors", () => {
    const out = buildJudgePrompt(
      makeComment({ authorLogin: "alice", isBot: false, bot: null }),
      makeCtx(),
    );
    expect(out).toContain("@alice");
    expect(out).not.toContain("recognised bot");
  });

  it("renders the anchored snippet when provided", () => {
    const out = buildJudgePrompt(
      makeComment(),
      makeCtx({ anchoredSnippet: "  const x = 1;\n  return x;" }),
    );
    expect(out).toContain("Code context");
    expect(out).toContain("const x = 1");
  });

  it("omits the code-context section when no snippet supplied", () => {
    const out = buildJudgePrompt(makeComment(), makeCtx());
    expect(out).not.toContain("Code context");
  });

  it("renders prior-decision history with timestamps and outcomes", () => {
    const out = buildJudgePrompt(
      makeComment(),
      makeCtx({
        priorDecisions: [
          {
            decided_at: new Date("2026-05-14T00:00:00Z").getTime(),
            validity: "valid",
            category: "apply-targeted",
            outcome: "verify_failed",
          },
        ],
      }),
    );
    expect(out).toContain("Prior attempts");
    expect(out).toContain("2026-05-14T00:00:00.000Z");
    expect(out).toContain("verify_failed");
    expect(out).toContain("apply-targeted");
  });

  it("escapes multi-line bodies into the blockquote", () => {
    const body = "Line one.\nLine two.\nLine three.";
    const out = buildJudgePrompt(makeComment({ body }), makeCtx());
    // All three lines should appear within the block-quote prefix.
    expect(out).toContain("> Line one.");
    expect(out).toContain("> Line two.");
    expect(out).toContain("> Line three.");
  });

  it("mentions the confidence threshold so the model knows the cutoff", () => {
    const out = buildJudgePrompt(makeComment(), makeCtx());
    expect(out).toContain(String(DEFAULT_CONFIDENCE_THRESHOLD));
  });

  it("documents all six categories so the model has the menu in scope", () => {
    const out = buildJudgePrompt(makeComment(), makeCtx());
    for (const c of [
      "apply-trivial",
      "apply-targeted",
      "apply-architectural",
      "reply-disagree",
      "reply-ack",
      "defer-to-human",
    ]) {
      expect(out).toContain(c);
    }
  });
});

describe("decideAction", () => {
  const j = (overrides: Partial<JudgeOutput> = {}): JudgeOutput => ({
    validity: "valid",
    category: "apply-trivial",
    confidence: 0.9,
    rationale: "the suggestion is correct",
    ...overrides,
  });

  it("routes apply-trivial to fix tier=trivial", () => {
    const a = decideAction(j(), { attemptCount: 0, belowThreshold: false });
    expect(a).toEqual({
      kind: "fix",
      tier: "trivial",
      rationale: "the suggestion is correct",
    });
  });

  it("routes apply-targeted to fix tier=targeted", () => {
    const a = decideAction(j({ category: "apply-targeted" }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("fix");
    if (a.kind === "fix") expect(a.tier).toBe("targeted");
  });

  it("routes apply-architectural to fix tier=architectural", () => {
    const a = decideAction(j({ category: "apply-architectural" }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("fix");
    if (a.kind === "fix") expect(a.tier).toBe("architectural");
  });

  it("routes reply-disagree to reply when text supplied", () => {
    const a = decideAction(
      j({
        category: "reply-disagree",
        validity: "invalid",
        reply: "We considered this and decided otherwise because …",
      }),
      { attemptCount: 0, belowThreshold: false },
    );
    expect(a.kind).toBe("reply");
    if (a.kind === "reply")
      expect(a.text).toBe("We considered this and decided otherwise because …");
  });

  it("escalates a reply-* category when reply text is missing", () => {
    const a = decideAction(j({ category: "reply-ack" }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("escalate");
  });

  it("escalates defer-to-human regardless of confidence", () => {
    const a = decideAction(j({ category: "defer-to-human", confidence: 1 }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("escalate");
  });

  it("escalates when belowThreshold is true, even on a strong category", () => {
    const a = decideAction(j(), { attemptCount: 0, belowThreshold: true });
    expect(a.kind).toBe("escalate");
    if (a.kind === "escalate") expect(a.reason).toContain("below threshold");
  });

  it("escalates when per-comment attempt cap is reached", () => {
    const a = decideAction(j(), {
      attemptCount: PER_COMMENT_ATTEMPT_CAP,
      belowThreshold: false,
    });
    expect(a.kind).toBe("escalate");
    if (a.kind === "escalate") expect(a.reason).toContain("cap");
  });

  it("self-corrects apply-* with validity=invalid by escalating", () => {
    const a = decideAction(j({ validity: "invalid" }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("escalate");
    if (a.kind === "escalate")
      expect(a.reason).toContain("apply but validity=invalid");
  });

  it("escalates apply-* with validity=unsure", () => {
    const a = decideAction(j({ validity: "unsure" }), {
      attemptCount: 0,
      belowThreshold: false,
    });
    expect(a.kind).toBe("escalate");
  });

  it("honours a custom perCommentCap", () => {
    const a = decideAction(j(), {
      attemptCount: 2,
      belowThreshold: false,
      perCommentCap: 2,
    });
    expect(a.kind).toBe("escalate");
  });

  it("attempt-cap takes precedence over below-threshold (cap message wins)", () => {
    const a = decideAction(j(), {
      attemptCount: PER_COMMENT_ATTEMPT_CAP,
      belowThreshold: true,
    });
    expect(a.kind).toBe("escalate");
    if (a.kind === "escalate") expect(a.reason).toContain("cap");
  });
});
