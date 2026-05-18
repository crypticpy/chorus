/**
 * Tests for the structured-output adapter. The shim is faked via the
 * shared fake-agent-shim helper — but we need per-call scripting that
 * varies based on the prompt text (so the repair-loop tests can
 * distinguish "first call" from "second call"). The static `events`
 * config doesn't cover that, so most tests use the `script` form which
 * receives the spawn options.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentEvent,
  AgentShim,
  HeadlessSpawnOptions,
} from "../src/daemon/agents/types";
import { requestStructured } from "../src/daemon/runner/structured-output.js";

interface ScriptedShim {
  shim: AgentShim;
  callCount: () => number;
  lastPrompt: () => string | undefined;
}

/**
 * Build a fake shim whose response is computed from each spawn's
 * promptText. Returns recording handles so tests can assert how many
 * times runHeadless was called and what the last prompt looked like.
 */
function makeScriptedShim(
  responder: (promptText: string, callIndex: number) => AgentEvent[],
): ScriptedShim {
  let calls = 0;
  let lastPrompt: string | undefined;
  const shim: AgentShim = {
    lineage: "anthropic",
    name: "fake",
    buildLaunchCommand: () => "fake-cli",
    formatPrompt: () => "fake",
    estimateCostUsd: () => 0,
    runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
      const idx = calls++;
      lastPrompt = opts.promptText;
      const events = responder(opts.promptText, idx);
      async function* gen(): AsyncIterable<AgentEvent> {
        for (const ev of events) yield ev;
      }
      return gen();
    },
  };
  return {
    shim,
    callCount: () => calls,
    lastPrompt: () => lastPrompt,
  };
}

const itemsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
    }),
  ),
});

const baseSpawn = { cwd: "/tmp" };

describe("requestStructured", () => {
  it("happy path: clean JSON in finalText, schema validates", async () => {
    const payload = { items: [{ id: "a", summary: "do thing" }] };
    const scripted = makeScriptedShim(() => [
      { type: "message_done", finalText: JSON.stringify(payload) },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
      schemaDescription: "list of items",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(payload);
    }
    expect(scripted.callCount()).toBe(1);
  });

  it("extracts JSON from a fenced ```json block buried in prose", async () => {
    const payload = { items: [{ id: "x", summary: "y" }] };
    const finalText =
      "Here is my analysis. After reviewing, I think:\n\n" +
      "```json\n" +
      JSON.stringify(payload, null, 2) +
      "\n```";
    const scripted = makeScriptedShim(() => [
      { type: "text_delta", text: "Here " },
      { type: "text_delta", text: "is..." },
      { type: "message_done", finalText },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(payload);
    }
  });

  it("repair loop succeeds: malformed first, valid second", async () => {
    const payload = { items: [{ id: "r", summary: "repaired" }] };
    const scripted = makeScriptedShim((_promptText, idx) => {
      if (idx === 0) {
        return [{ type: "message_done", finalText: "{not valid json" }];
      }
      return [
        {
          type: "message_done",
          finalText: "```json\n" + JSON.stringify(payload) + "\n```",
        },
      ];
    });

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
      maxRepairAttempts: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(payload);
    }
    expect(scripted.callCount()).toBe(2);
    // Second call should have been a repair prompt, distinct from the first.
    expect(scripted.lastPrompt()).toContain("could not be parsed");
  });

  it("repair loop exhausted: both calls malformed → parse_error", async () => {
    const scripted = makeScriptedShim(() => [
      { type: "message_done", finalText: "still not json {" },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
      maxRepairAttempts: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_error");
      expect(result.rawText).toBeDefined();
    }
    // 1 initial + 1 repair = 2 total.
    expect(scripted.callCount()).toBe(2);
  });

  it("schema violation: valid JSON but wrong shape → schema_violation", async () => {
    const wrong = { items: [{ id: 42, summary: "bad id type" }] };
    const scripted = makeScriptedShim(() => [
      { type: "message_done", finalText: JSON.stringify(wrong) },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
      // Disable repair so we observe the schema_violation directly,
      // not a downstream parse_error from a malformed retry.
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_violation");
    }
  });

  it("Path 4: prefers a valid {object} over a misleading [bracket] earlier in prose", async () => {
    // Reproduces the bug where extractJson picked the FIRST opener and
    // tried `[stuff]` instead of the real `{json}`. With repair disabled
    // (maxRepairAttempts=0) the original code would parse `[bracket]`
    // and fail schema validation; the fix tries both shapes and prefers
    // the longer slice.
    const payload = { items: [{ id: "p4", summary: "real payload" }] };
    const finalText =
      "I'll mention some [option-A, option-B] before the answer. " +
      "Here it is: " +
      JSON.stringify(payload) +
      " — done.";
    const scripted = makeScriptedShim(() => [
      { type: "message_done", finalText },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
      // Repair loop disabled so we exercise the extractor directly.
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(payload);
    }
    expect(scripted.callCount()).toBe(1);
  });

  it("spawn error: shim yields error event → spawn_error", async () => {
    const scripted = makeScriptedShim(() => [
      { type: "error", kind: "quota_exhausted", message: "out of tokens" },
    ]);

    const result = await requestStructured({
      shim: scripted.shim,
      spawn: baseSpawn,
      prompt: "list the items",
      schema: itemsSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("spawn_error");
      expect(result.detail).toContain("quota_exhausted");
    }
    // Spawn errors must not retry — there's nothing the model can fix.
    expect(scripted.callCount()).toBe(1);
  });
});
