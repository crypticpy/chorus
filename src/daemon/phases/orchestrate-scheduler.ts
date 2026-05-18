/**
 * Orchestrate scheduler — pure function picker for "which worker handles
 * this audit item?".
 *
 * Tier rule: a worker is eligible for an item iff its voice's tier is
 * ≥ item.complexity, where high ≥ medium ≥ low. (Higher-tier voices can
 * tackle anything they outrank; lower-tier voices stick to their level.)
 *
 * Bypass rule: when `bypassQuota` is true (PR-review chats), the tier
 * gate is dropped — any enabled voice in the worker pool is eligible
 * regardless of complexity. The chat opted into "use everything you've
 * got" semantics.
 *
 * Disabled voices are always skipped — a voice the user toggled off in
 * the cockpit shouldn't fire just because a chat is on auto-pilot.
 *
 * Selection: first-fit across the worker array as written in the
 * template. Round-robin would be slightly fairer for batches, but the
 * orchestrate phase runs sequentially in v1 so each call to this
 * function happens in isolation; first-fit lets a template author
 * declare a preferred-order chain and trust it's honoured. If/when
 * orchestrate gains parallelism the caller will need a stateful balancer
 * around this — the scheduler itself stays pure.
 */
import type { AuditItem } from "../../lib/template-schema.js";

export type Tier = "high" | "medium" | "low";

const TIER_RANK: Record<Tier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface SchedulerWorker {
  /** Voice id used to look up tier/enabled in `voicesById`. */
  voiceId: string;
  lineage: string;
  /** First entry of `phase.workers[i].models[]`, if any. */
  model?: string;
  persona?: string;
}

export interface SchedulerVoiceMeta {
  tier: Tier;
  enabled: boolean;
}

export interface PickWorkerArgs {
  item: AuditItem;
  workers: SchedulerWorker[];
  voicesById: Map<string, SchedulerVoiceMeta>;
  bypassQuota: boolean;
}

export interface PickedWorker {
  voiceId: string;
  lineage: string;
  model?: string;
  persona?: string;
}

/**
 * Pick the first eligible worker for `item`, or null when the pool has
 * none. Eligibility:
 *   - voice exists in voicesById AND is enabled
 *   - bypassQuota=true OR voice.tier rank ≥ item.complexity rank
 *
 * Pure: no side effects, deterministic for a given input.
 */
export function pickWorkerForItem(args: PickWorkerArgs): PickedWorker | null {
  const { item, workers, voicesById, bypassQuota } = args;
  if (workers.length === 0) return null;

  const itemRank = TIER_RANK[item.complexity];

  for (const worker of workers) {
    const meta = voicesById.get(worker.voiceId);
    // Unknown voice id → skip (template references a voice that doesn't
    // exist in the local DB; safer to skip than to crash the phase).
    if (!meta) continue;
    if (!meta.enabled) continue;
    if (!bypassQuota && TIER_RANK[meta.tier] < itemRank) continue;

    return {
      voiceId: worker.voiceId,
      lineage: worker.lineage,
      model: worker.model,
      persona: worker.persona,
    };
  }

  return null;
}
