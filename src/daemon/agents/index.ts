/**
 * Agent shim registry: lineage → shim implementation.
 * Each CLI lineage (anthropic, openai, google, xai) has a corresponding shim
 * that handles launch commands, prompt formatting, and cost estimation.
 */

import type { AgentRegistry, AgentShim, Lineage } from "./types.js";
import { claudeShim } from "./claude.js";
import { codexShim } from "./codex.js";
import { geminiShim } from "./gemini.js";
import { grokShim } from "./grok.js";
import { opencodeShim } from "./opencode.js";
import { kimiShim } from "./kimi.js";
import { openrouterShim } from "./openrouter.js";
import { localShim } from "./local.js";

const SHIMS: Record<Lineage, AgentShim> = {
  anthropic: claudeShim,
  openai: codexShim,
  google: geminiShim,
  opencode: opencodeShim,
  moonshot: kimiShim,
  openrouter: openrouterShim,
  local: localShim,
  grok: grokShim,
  any: claudeShim, // Fallback to Claude
};

const registry: AgentRegistry = {
  pickShim(lineage: Lineage): AgentShim {
    return SHIMS[lineage] ?? SHIMS.any;
  },

  listAvailable(): AgentShim[] {
    return Object.values(SHIMS);
  },
};

/**
 * Pick a shim taking the model id into account.
 *
 * - `openrouter:*` model ids → openrouterShim (HTTP, regardless of lineage)
 * - `local:*` model ids → localShim (HTTP, regardless of lineage)
 * - everything else → registry lookup by lineage
 *
 * Callers that have a model hint (runner doer + reviewer dispatch) should
 * use this; callers that don't (legacy paths) can keep using registry.pickShim.
 */
export function pickShimForVoice(lineage: Lineage, model?: string): AgentShim {
  if (model && model.startsWith("openrouter:")) return openrouterShim;
  if (model && model.startsWith("local:")) return localShim;
  return registry.pickShim(lineage);
}

/**
 * True when this voice should bypass the CLI-credential precheck.
 * Both openrouter and local authenticate via the secrets table rather
 * than a CLI-managed cred file, so the on-disk credential probe is
 * meaningless for them.
 */
export function isHttpDispatchedShim(shim: AgentShim): boolean {
  return shim === openrouterShim || shim === localShim;
}

/**
 * True when dispatch consumes only remote/network resources and can
 * safely bypass the daemon-wide local-CLI semaphore.
 *
 * `openrouter` is genuinely remote — each request is a network round-trip
 * to a hosted gateway and many can fly in parallel without local pressure.
 *
 * `local`, despite also being an HTTP shim, talks to an OpenAI-compatible
 * endpoint that almost always lives on `127.0.0.1` (Ollama default
 * `http://127.0.0.1:11434/v1`). On consumer hardware the local inference
 * server holds one model in VRAM/RAM at a time; firing N reviewers and a
 * doer at it concurrently thrashes memory or OOMs the user's machine.
 * The local shim therefore must go through the per-CLI semaphore (with a
 * conservative default of 1 — see `concurrency.ts`).
 *
 * Keep this distinct from `isHttpDispatchedShim` so the credential-
 * precheck bypass and the resource-cap bypass remain independently
 * tunable per shim.
 */
export function bypassesLocalCliSemaphore(shim: AgentShim): boolean {
  return shim === openrouterShim;
}

// Re-export shims for direct access if needed
export {
  claudeShim,
  codexShim,
  geminiShim,
  grokShim,
  opencodeShim,
  kimiShim,
  openrouterShim,
  localShim,
};
