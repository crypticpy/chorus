/**
 * Audit-phase wiring tests.
 *
 * Two contracts:
 *   1. Every preset prompt the schema accepts must exist on disk and be
 *      non-empty — the runner reads them at phase fire time, so a
 *      missing or empty file is a runner crash waiting to happen.
 *   2. The five built-in audit-* templates must parse via TemplateSchema
 *      and have the canonical 2-phase shape (audit → orchestrate).
 *
 * Integration of the structured-output adapter with a real shim is
 * intentionally NOT mocked here — that path is exercised by the
 * structured-output unit tests + a follow-up end-to-end pass.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import { AUDIT_PRESETS, TemplateSchema } from "../src/lib/template-schema";

const REPO_ROOT = path.join(__dirname, "..");
const PRESETS_DIR = path.join(REPO_ROOT, "src", "daemon", "presets");
const TEMPLATES_DIR = path.join(REPO_ROOT, "templates");

describe("audit preset prompts", () => {
  for (const preset of AUDIT_PRESETS) {
    it(`exists and is non-empty: ${preset}.md`, () => {
      const promptPath = path.join(PRESETS_DIR, `${preset}.md`);
      expect(fs.existsSync(promptPath), `missing ${promptPath}`).toBe(true);
      const body = fs.readFileSync(promptPath, "utf-8");
      // Empty / whitespace-only file would mean the runner sends an
      // empty system prompt → garbage audit output.
      expect(body.trim().length).toBeGreaterThan(0);
    });
  }
});

describe("built-in audit-* templates", () => {
  for (const preset of AUDIT_PRESETS) {
    const templateId = `audit-${preset}`;
    const yamlPath = path.join(TEMPLATES_DIR, `${templateId}.yaml`);

    it(`${templateId}.yaml parses + has audit→orchestrate shape`, () => {
      expect(fs.existsSync(yamlPath), `missing ${yamlPath}`).toBe(true);
      const raw = fs.readFileSync(yamlPath, "utf-8");
      const parsed = yaml.parse(raw);
      const result = TemplateSchema.safeParse(parsed);
      expect(
        result.success,
        result.success ? "ok" : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
      if (!result.success) return;

      const tmpl = result.data;
      expect(tmpl.id).toBe(templateId);
      expect(tmpl.phases).toHaveLength(2);
      const [first, second] = tmpl.phases;
      expect(first.kind).toBe("audit");
      if (first.kind === "audit") {
        expect(first.preset).toBe(preset);
      }
      expect(second.kind).toBe("orchestrate");
      if (second.kind === "orchestrate") {
        // 3 default workers per the brief.
        expect(second.workers.length).toBe(3);
      }
    });
  }
});
