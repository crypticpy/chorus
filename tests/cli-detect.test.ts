import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  detectAllClis,
  validateCliPath,
  type CliDetection,
  type DetectableCli,
} from '@/lib/cli-detect';

describe('cli-detect', () => {
  describe('detectAllClis', () => {
    it('returns array of 6 entries (one per DetectableCli)', () => {
      const clis = detectAllClis();
      expect(clis).toHaveLength(6);
    });

    it('each entry has id, found, optional path and source', () => {
      const clis = detectAllClis();
      const expectedIds: DetectableCli[] = [
        'claude-code',
        'codex-cli',
        'gemini-cli',
        'opencode-cli',
        'kimi-cli',
        'grok-cli',
      ];

      clis.forEach((cli: CliDetection) => {
        expect(cli.id).toBeDefined();
        expect(expectedIds).toContain(cli.id);
        expect(typeof cli.found).toBe('boolean');

        if (cli.found) {
          expect(cli.path).toBeDefined();
          expect(typeof cli.path).toBe('string');
          expect(cli.source).toBeDefined();
          expect(['path', 'fallback', 'manual']).toContain(cli.source);
        } else {
          expect(cli.path).toBeUndefined();
          expect(cli.source).toBeUndefined();
        }
      });
    });
  });

  describe('validateCliPath', () => {
    it('returns found:false for nonexistent path', () => {
      const result = validateCliPath('claude-code', '/nonexistent/path/to/claude');
      expect(result.id).toBe('claude-code');
      expect(result.found).toBe(false);
    });

    it('returns found:false for empty/whitespace-only path', () => {
      const result = validateCliPath('codex-cli', '   ');
      expect(result.id).toBe('codex-cli');
      expect(result.found).toBe(false);
    });

    it('returns source:manual when found:true', () => {
      // Depends on system state. validateCliPath uses the basename of
      // the user-pasted path for its name check (e.g. "claude" symlink
      // pointing at a versioned binary like "2.1.126" still validates
      // because the user-facing name is "claude"). We pass the
      // detected path AS-IS — typically a symlink — and expect
      // validation to accept it.
      const clis = detectAllClis();
      const found = clis.find((c) => c.found);

      if (found && found.path) {
        const result = validateCliPath(found.id, found.path);
        expect(result.id).toBe(found.id);
        expect(result.found).toBe(true);
        expect(result.source).toBe('manual');
      }
    });

    it('symlinks: accepts the link, persists the canonical target (TOCTOU defense)', () => {
      // Real-world installs (Homebrew, asdf, mise, npm-global, fnm,
      // volta) ship the user-facing binary as a symlink. Rejecting
      // them outright would break the majority of legit installs.
      // Instead, validateCliPath realpath-resolves and stores the
      // CANONICAL target, so a later swap of the symlink can't
      // redirect daemon spawns to a malicious binary.
      const clis = detectAllClis();
      const found = clis.find((c) => c.found);
      if (!found || !found.path) return;

      // Use the CLI's expected basename so the basename check passes.
      const expectedName = nodePath.basename(found.path);
      const linkDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'chorus-symlink-'));
      const linkPath = nodePath.join(linkDir, expectedName);
      fs.symlinkSync(fs.realpathSync(found.path), linkPath);

      try {
        const result = validateCliPath(found.id, linkPath);
        expect(result.found).toBe(true);
        expect(result.path).toBe(fs.realpathSync(found.path)); // canonical, not the symlink
        expect(result.source).toBe('manual');
      } finally {
        try {
          fs.unlinkSync(linkPath);
          fs.rmdirSync(linkDir);
        } catch {
          /* ignore */
        }
      }
    });
  });
});
