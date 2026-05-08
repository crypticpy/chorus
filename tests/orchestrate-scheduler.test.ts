/**
 * Unit tests for `pickWorkerForItem` — the pure tier-aware scheduler that
 * picks which worker (if any) handles a given audit item.
 *
 * Tier rank: high ≥ medium ≥ low. A worker's voice tier must rank ≥ the
 * item's complexity for the worker to be eligible — UNLESS bypassQuota is
 * true, in which case any enabled voice is eligible.
 */
import { describe, expect, it } from "vitest";
import type { AuditItem } from "../src/lib/template-schema";
import {
  pickWorkerForItem,
  type SchedulerVoiceMeta,
  type SchedulerWorker,
} from "../src/daemon/phases/orchestrate-scheduler";

function makeItem(
  complexity: AuditItem["complexity"],
  id = "item-1",
): AuditItem {
  return {
    id,
    summary: `${complexity} task`,
    complexity,
    files: [],
    rationale: "",
  };
}

function workerEntry(voiceId: string, lineage = "anthropic"): SchedulerWorker {
  return { voiceId, lineage };
}

function voicesMap(
  rows: Array<[string, SchedulerVoiceMeta]>,
): Map<string, SchedulerVoiceMeta> {
  return new Map(rows);
}

describe("pickWorkerForItem", () => {
  it("returns null for a high-complexity task when only low-tier workers exist (no bypass)", () => {
    const result = pickWorkerForItem({
      item: makeItem("high"),
      workers: [workerEntry("voice-low-1"), workerEntry("voice-low-2")],
      voicesById: voicesMap([
        ["voice-low-1", { tier: "low", enabled: true }],
        ["voice-low-2", { tier: "low", enabled: true }],
      ]),
      bypassQuota: false,
    });
    expect(result).toBeNull();
  });

  it("returns the first worker for a high-complexity task when bypass is true (tier ignored)", () => {
    const result = pickWorkerForItem({
      item: makeItem("high"),
      workers: [workerEntry("voice-low-1"), workerEntry("voice-low-2")],
      voicesById: voicesMap([
        ["voice-low-1", { tier: "low", enabled: true }],
        ["voice-low-2", { tier: "low", enabled: true }],
      ]),
      bypassQuota: true,
    });
    expect(result).not.toBeNull();
    expect(result?.voiceId).toBe("voice-low-1");
  });

  it("picks the first eligible worker for a medium task in a mixed-tier pool", () => {
    // workers in declaration order: low (skipped), medium (picked).
    const result = pickWorkerForItem({
      item: makeItem("medium"),
      workers: [
        workerEntry("voice-low", "openai"),
        workerEntry("voice-med", "anthropic"),
        workerEntry("voice-high", "google"),
      ],
      voicesById: voicesMap([
        ["voice-low", { tier: "low", enabled: true }],
        ["voice-med", { tier: "medium", enabled: true }],
        ["voice-high", { tier: "high", enabled: true }],
      ]),
      bypassQuota: false,
    });
    expect(result?.voiceId).toBe("voice-med");
    expect(result?.lineage).toBe("anthropic");
  });

  it("picks the first listed worker for a low-complexity task even when higher tiers exist", () => {
    // First-fit: a low-tier worker is eligible for a low task and listed
    // first → it wins. The template author declared the order; the
    // scheduler honours it.
    const result = pickWorkerForItem({
      item: makeItem("low"),
      workers: [
        workerEntry("voice-low"),
        workerEntry("voice-med"),
        workerEntry("voice-high"),
      ],
      voicesById: voicesMap([
        ["voice-low", { tier: "low", enabled: true }],
        ["voice-med", { tier: "medium", enabled: true }],
        ["voice-high", { tier: "high", enabled: true }],
      ]),
      bypassQuota: false,
    });
    expect(result?.voiceId).toBe("voice-low");
  });

  it("skips disabled voices and falls through to the next eligible worker", () => {
    const result = pickWorkerForItem({
      item: makeItem("medium"),
      workers: [
        workerEntry("voice-disabled-high"),
        workerEntry("voice-enabled-med"),
      ],
      voicesById: voicesMap([
        ["voice-disabled-high", { tier: "high", enabled: false }],
        ["voice-enabled-med", { tier: "medium", enabled: true }],
      ]),
      bypassQuota: false,
    });
    expect(result?.voiceId).toBe("voice-enabled-med");
  });

  it("skips disabled voices even with bypassQuota=true", () => {
    // Bypass overrides tier, NOT the user's explicit "disabled" toggle.
    const result = pickWorkerForItem({
      item: makeItem("high"),
      workers: [
        workerEntry("voice-disabled"),
        workerEntry("voice-enabled-low"),
      ],
      voicesById: voicesMap([
        ["voice-disabled", { tier: "high", enabled: false }],
        ["voice-enabled-low", { tier: "low", enabled: true }],
      ]),
      bypassQuota: true,
    });
    expect(result?.voiceId).toBe("voice-enabled-low");
  });

  it("returns null on an empty worker pool", () => {
    const result = pickWorkerForItem({
      item: makeItem("low"),
      workers: [],
      voicesById: voicesMap([]),
      bypassQuota: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when every worker references a voice missing from the DB", () => {
    // Template references a voice that no longer exists locally — skip
    // rather than crash. Same outcome as "no eligible worker".
    const result = pickWorkerForItem({
      item: makeItem("low"),
      workers: [workerEntry("voice-stale-1"), workerEntry("voice-stale-2")],
      voicesById: voicesMap([]),
      bypassQuota: false,
    });
    expect(result).toBeNull();
  });

  it("preserves the worker's model + persona on the picked result", () => {
    const result = pickWorkerForItem({
      item: makeItem("medium"),
      workers: [
        {
          voiceId: "voice-med",
          lineage: "anthropic",
          model: "claude-opus-4-7",
          persona: "sentinel",
        },
      ],
      voicesById: voicesMap([["voice-med", { tier: "medium", enabled: true }]]),
      bypassQuota: false,
    });
    expect(result).toEqual({
      voiceId: "voice-med",
      lineage: "anthropic",
      model: "claude-opus-4-7",
      persona: "sentinel",
    });
  });
});
