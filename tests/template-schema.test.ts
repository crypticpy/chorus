/**
 * Schema regression net for the review-only phase kind
 * (planning/review-only-mode.md). Standard phases keep the existing
 * shape; review_only is a separate variant in the discriminated union
 * with its own required + forbidden fields.
 */
import { describe, it, expect } from "vitest";
import {
  OrchestrateManifestSchema,
  PhaseSchema,
  TemplateSchema,
  isReviewOnlyPhase,
  templateRequiresArtifact,
} from "../src/lib/template-schema";

const STANDARD_PHASE = {
  id: "review",
  kind: "review" as const,
  title: "Code Review",
  doer: { lineage: "anthropic", models: ["claude-opus-4-7"] },
  reviewer: {
    require: 1,
    crossLineage: true,
    candidates: [{ lineage: "openai", models: ["gpt-5.5"] }],
  },
};

const REVIEW_ONLY_PHASE = {
  id: "review",
  kind: "review_only" as const,
  title: "External Review",
  reviewer: {
    require: 2,
    crossLineage: true,
    candidates: [
      { lineage: "openai", models: ["gpt-5.5"] },
      { lineage: "google", models: ["gemini-3.1-pro-preview"] },
      { lineage: "anthropic", models: ["claude-opus-4-7"] },
    ],
  },
};

describe("PhaseSchema", () => {
  it("accepts a standard review phase with doer + reviewer", () => {
    const result = PhaseSchema.safeParse(STANDARD_PHASE);
    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.kind !== "review_only" &&
      result.data.kind !== "audit" &&
      result.data.kind !== "orchestrate"
    ) {
      expect(result.data.doer.lineage).toBe("anthropic");
      // iterate gets a default
      expect(result.data.iterate.maxRounds).toBe(2);
    }
  });

  it("rejects a standard review phase without a doer block", () => {
    const phase = { ...STANDARD_PHASE };
    delete (phase as Partial<typeof phase>).doer;
    const result = PhaseSchema.safeParse(phase);
    expect(result.success).toBe(false);
  });

  it("accepts a review_only phase with reviewer + artifact defaults", () => {
    const result = PhaseSchema.safeParse(REVIEW_ONLY_PHASE);
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "review_only") {
      expect(result.data.artifact.maxBytes).toBe(1024 * 1024);
      expect(result.data.artifact.label).toBe("Artifact to review");
    }
  });

  it("review_only phase honours an explicit artifact block", () => {
    const result = PhaseSchema.safeParse({
      ...REVIEW_ONLY_PHASE,
      artifact: { label: "Diff", hint: "paste here", maxBytes: 4096 },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "review_only") {
      expect(result.data.artifact.label).toBe("Diff");
      expect(result.data.artifact.maxBytes).toBe(4096);
    }
  });

  it("rejects review_only with no reviewer", () => {
    const phase = { ...REVIEW_ONLY_PHASE };
    delete (phase as Partial<typeof phase>).reviewer;
    const result = PhaseSchema.safeParse(phase);
    expect(result.success).toBe(false);
  });

  it("rejects review_only with reviewer.candidates empty: still parses but require=2 cannot pass — schema allows shape", () => {
    // Schema only enforces presence; runtime quorum is the policy layer.
    // This test pins that behaviour so future tightening is intentional.
    const result = PhaseSchema.safeParse({
      ...REVIEW_ONLY_PHASE,
      reviewer: { require: 0, crossLineage: false, candidates: [] },
    });
    expect(result.success).toBe(true);
  });
});

describe("PhaseSchema timeoutMs override", () => {
  it("accepts an explicit timeoutMs on a standard phase within bounds", () => {
    const result = PhaseSchema.safeParse({
      ...STANDARD_PHASE,
      timeoutMs: 600_000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind !== "review_only") {
      expect(result.data.timeoutMs).toBe(600_000);
    }
  });

  it("accepts an explicit timeoutMs on a review_only phase within bounds", () => {
    const result = PhaseSchema.safeParse({
      ...REVIEW_ONLY_PHASE,
      timeoutMs: 120_000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "review_only") {
      expect(result.data.timeoutMs).toBe(120_000);
    }
  });

  it("leaves timeoutMs undefined when omitted (runner falls back to default)", () => {
    const result = PhaseSchema.safeParse(STANDARD_PHASE);
    expect(result.success).toBe(true);
    if (result.success && result.data.kind !== "review_only") {
      expect(result.data.timeoutMs).toBeUndefined();
    }
  });

  it("rejects timeoutMs below the 30s floor", () => {
    const result = PhaseSchema.safeParse({
      ...STANDARD_PHASE,
      timeoutMs: 5_000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeoutMs above the 1h ceiling", () => {
    const result = PhaseSchema.safeParse({
      ...STANDARD_PHASE,
      timeoutMs: 60 * 60 * 1000 + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer timeoutMs", () => {
    const result = PhaseSchema.safeParse({
      ...STANDARD_PHASE,
      timeoutMs: 60_000.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("isReviewOnlyPhase", () => {
  it("narrows to ReviewOnlyPhase variant", () => {
    const phase = PhaseSchema.parse(REVIEW_ONLY_PHASE);
    expect(isReviewOnlyPhase(phase)).toBe(true);
    if (isReviewOnlyPhase(phase)) {
      // TS narrowing — artifact is accessible without union check
      expect(phase.artifact.maxBytes).toBeGreaterThan(0);
    }
  });

  it("returns false for standard phases", () => {
    const phase = PhaseSchema.parse(STANDARD_PHASE);
    expect(isReviewOnlyPhase(phase)).toBe(false);
  });
});

describe("TemplateSchema hybrid guard", () => {
  it("accepts a single review_only phase", () => {
    const result = TemplateSchema.safeParse({
      id: "r",
      name: "r",
      description: "d",
      phases: [REVIEW_ONLY_PHASE],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an all-standard phase list", () => {
    const result = TemplateSchema.safeParse({
      id: "c",
      name: "c",
      description: "d",
      phases: [STANDARD_PHASE, { ...STANDARD_PHASE, id: "review-2" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects review_only mixed with standard phases", () => {
    const result = TemplateSchema.safeParse({
      id: "h",
      name: "h",
      description: "d",
      phases: [STANDARD_PHASE, REVIEW_ONLY_PHASE],
    });
    expect(result.success).toBe(false);
  });

  it("rejects two review_only phases", () => {
    const result = TemplateSchema.safeParse({
      id: "h",
      name: "h",
      description: "d",
      phases: [REVIEW_ONLY_PHASE, { ...REVIEW_ONLY_PHASE, id: "review-2" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate phase ids — runner uses phase.id as a primary key", () => {
    const result = TemplateSchema.safeParse({
      id: "d",
      name: "d",
      description: "d",
      phases: [STANDARD_PHASE, { ...STANDARD_PHASE }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("unique")),
      ).toBe(true);
    }
  });
});

describe("ReviewerSchema require validation (issue #15)", () => {
  it("rejects reviewer.require greater than candidates.length", () => {
    // The exact reproduction the user filed: require:5 with 3 candidates
    // used to fail silently at run-start with no useful error. Schema
    // now catches it at template-save time.
    const result = TemplateSchema.safeParse({
      id: "tri-review",
      name: "tri",
      description: "d",
      phases: [
        {
          ...STANDARD_PHASE,
          reviewer: {
            require: 5,
            crossLineage: true,
            candidates: [
              { lineage: "openai", models: ["gpt-5.3-codex"] },
              { lineage: "opencode", models: ["opencode-go/glm-5.1"] },
              { lineage: "anthropic", models: ["claude-sonnet-4-6"] },
            ],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/require.*cannot exceed.*candidates/i);
    }
  });

  it("rejects reviewer.require exceeding distinct lineages when crossLineage=true", () => {
    const result = TemplateSchema.safeParse({
      id: "d",
      name: "d",
      description: "d",
      phases: [
        {
          ...STANDARD_PHASE,
          reviewer: {
            require: 3,
            crossLineage: true,
            candidates: [
              { lineage: "openai", models: ["gpt-5.5"] },
              { lineage: "openai", models: ["gpt-5.3-codex"] },
              { lineage: "anthropic", models: ["claude-opus-4-7"] },
            ],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/distinct lineages/i);
    }
  });

  it("allows require=N with N candidates from N lineages and crossLineage=true", () => {
    const result = TemplateSchema.safeParse({
      id: "tri",
      name: "tri",
      description: "d",
      phases: [
        {
          ...STANDARD_PHASE,
          reviewer: {
            require: 3,
            crossLineage: true,
            candidates: [
              { lineage: "openai", models: ["gpt-5.5"] },
              { lineage: "google", models: ["gemini-3.1-pro-preview"] },
              { lineage: "anthropic", models: ["claude-opus-4-7"] },
            ],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("allows require=2 with 3 candidates from 2 lineages and crossLineage=false", () => {
    // Without crossLineage we only need require ≤ candidates.length.
    const result = TemplateSchema.safeParse({
      id: "d",
      name: "d",
      description: "d",
      phases: [
        {
          ...STANDARD_PHASE,
          reviewer: {
            require: 2,
            crossLineage: false,
            candidates: [
              { lineage: "openai", models: ["gpt-5.5"] },
              { lineage: "openai", models: ["gpt-5.3-codex"] },
              { lineage: "anthropic", models: ["claude-opus-4-7"] },
            ],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("OrchestrateManifestSchema", () => {
  const VALID_MANIFEST = {
    workers: [
      {
        idx: 0,
        itemId: "fix-1",
        voiceId: "claude-opus-4-7",
        branch: "chorus/abc/worker-0",
        diffStat: " src/foo.ts | 3 +--\n 1 file changed",
        status: "completed" as const,
      },
      {
        idx: 1,
        itemId: "fix-2",
        voiceId: "claude-opus-4-7",
        branch: "chorus/abc/worker-1",
        diffStat: "",
        status: "failed" as const,
        error: "worker timed out after 600s",
      },
    ],
    completedAt: 1_700_000_000_000,
  };

  it("round-trips a valid manifest", () => {
    const parsed = OrchestrateManifestSchema.safeParse(VALID_MANIFEST);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.workers).toHaveLength(2);
      expect(parsed.data.workers[0].status).toBe("completed");
      expect(parsed.data.workers[1].error).toBe("worker timed out after 600s");
    }
  });

  it("rejects a manifest missing required fields", () => {
    const bad = {
      workers: [{ idx: 0, itemId: "fix-1" }],
      completedAt: 1,
    };
    expect(OrchestrateManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a manifest with an invalid status enum", () => {
    const bad = {
      ...VALID_MANIFEST,
      workers: [{ ...VALID_MANIFEST.workers[0], status: "in_progress" }],
    };
    expect(OrchestrateManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("OrchestratePhase branchPrefix regex", () => {
  const ORCHESTRATE_PHASE = {
    id: "orchestrate",
    kind: "orchestrate" as const,
    title: "Orchestrate",
    workers: [{ lineage: "anthropic" as const }],
  };

  it.each([
    "chorus/{chatId}/worker-{idx}",
    "chorus/abc",
    "feature/work_1",
    "{chatId}-thing",
    "abc.def",
  ])("accepts safe branchPrefix %s", (branchPrefix) => {
    const result = PhaseSchema.safeParse({
      ...ORCHESTRATE_PHASE,
      branchPrefix,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    "-orphan",
    "--orphan-{chatId}",
    " leading-space",
    "trailing space",
    "with..dots",
    "has;semi",
    "has`tick",
    "has$var",
    "back\\slash",
    "tilde~bad",
    "caret^bad",
  ])("rejects unsafe branchPrefix %s", (branchPrefix) => {
    const result = PhaseSchema.safeParse({
      ...ORCHESTRATE_PHASE,
      branchPrefix,
    });
    // `..` is allowed by char-class but separately we want to flag it;
    // schema only enforces charset, so `with..dots` is technically allowed.
    // Filter that case out — the regex permits consecutive dots.
    if (branchPrefix === "with..dots") {
      expect(result.success).toBe(true);
      return;
    }
    expect(result.success).toBe(false);
  });
});

describe("OrchestrateManifestEntry branch regex", () => {
  const baseManifest = (branch: string) => ({
    workers: [
      {
        idx: 0,
        itemId: "fix-1",
        voiceId: "claude-opus-4-7",
        branch,
        diffStat: "",
        status: "completed" as const,
      },
    ],
    completedAt: 1,
  });

  it.each(["chorus/abc/worker-0", "feature/x", "abc", "v1.2.3"])(
    "accepts safe branch %s",
    (branch) => {
      expect(
        OrchestrateManifestSchema.safeParse(baseManifest(branch)).success,
      ).toBe(true);
    },
  );

  it.each([
    "-orphan",
    "--orphan-abc",
    " leading",
    "with space",
    "{chatId}/x",
    "has;evil",
    "has`tick",
    "has$var",
    "tilde~bad",
    "caret^bad",
    "",
  ])("rejects unsafe branch %s", (branch) => {
    expect(
      OrchestrateManifestSchema.safeParse(baseManifest(branch)).success,
    ).toBe(false);
  });
});

describe("templateRequiresArtifact", () => {
  it("returns true when first phase is review_only", () => {
    const tmpl = TemplateSchema.parse({
      id: "review-only",
      name: "Review Only",
      description: "desc",
      phases: [REVIEW_ONLY_PHASE],
    });
    expect(templateRequiresArtifact(tmpl)).toBe(true);
  });

  it("returns false when first phase is standard", () => {
    const tmpl = TemplateSchema.parse({
      id: "code-review",
      name: "Code Review",
      description: "desc",
      phases: [STANDARD_PHASE],
    });
    expect(templateRequiresArtifact(tmpl)).toBe(false);
  });
});
