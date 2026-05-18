/**
 * Doer invocation for the babysit fix loop.
 *
 * We ask a model to convert a single bot comment + the surrounding
 * code into a small set of file edits, expressed as full file
 * rewrites: `{ path, newContents }[]` plus a commit message. Why full
 * rewrites instead of unified diffs:
 *
 *   - LLMs are notoriously unreliable at producing exact patch
 *     coordinates. A misnumbered hunk line ends up applying to the
 *     wrong place or being rejected by `git apply`.
 *   - The babysit fix tier is "trivial / targeted" by construction —
 *     comment-driven edits, usually <50 line changes. Rewriting the
 *     touched files in full is cheap and unambiguous.
 *   - Architectural fixes (large refactors) escalate to a human up-
 *     stream, so we never need diff-style edits here.
 *
 * Safety: the doer can ONLY name files inside the worktree. Paths
 * are resolved + checked against the worktree root before any write,
 * so a confused model can't escape to `~/.ssh/authorized_keys`.
 *
 * What the runner gets back:
 *   - ok: true → write succeeded, list of files changed, commit
 *     message ready for `git commit -m`.
 *   - ok: false → spawn/parse/safety failure with a typed reason.
 *
 * No git operations happen here — applying the edits stages them in
 * the worktree; the runner calls the git-push helper separately so
 * the verify step can run between the two.
 */
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { pickShimForVoice } from "../agents/index.js";
import { requestStructured } from "../runner/structured-output.js";
import type { RawPrComment } from "./comment-fetcher.js";
import type { FixTier } from "./judge.js";

export const FixPlanSchema = z.object({
  commit_message: z
    .string()
    .min(1)
    .describe(
      "One-line conventional-commit message. Will be used verbatim for git commit -m.",
    ),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Project-relative file path. Must already exist OR be a sensible new file in the project layout.",
          ),
        new_contents: z
          .string()
          .describe(
            "Complete file contents after the fix. Not a diff — the literal new file body.",
          ),
      }),
    )
    .min(1)
    .max(20)
    .describe("File edits expressed as full-file rewrites."),
  /** One-paragraph explanation of what changed + why. Stored in the
   *  decision audit log; not used by git. */
  notes: z.string().optional(),
});

export type FixPlan = z.infer<typeof FixPlanSchema>;

export interface FixExecutorContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  baseBranch: string;
  /** Snippet around the comment's anchored lines, when the comment
   *  is line-anchored. Pulled by the runner before calling. */
  anchoredSnippet?: string;
}

export interface ApplyFixArgs {
  /** Absolute path to the per-PR worktree. The doer is told the
   *  worktree root + that paths it returns are project-relative. */
  worktreePath: string;
  comment: RawPrComment;
  judgementRationale: string;
  tier: FixTier;
  ctx: FixExecutorContext;
  /** Doer model + lineage. The state machine picks these from the
   *  job's template; defaults live in the template, not here. */
  lineage: string;
  model: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export type ApplyFixResult =
  | {
      ok: true;
      filesChanged: string[];
      commitMessage: string;
      notes: string | null;
      rawText: string;
    }
  | {
      ok: false;
      reason: ApplyFixFailReason;
      detail: string;
      rawText?: string;
    };

export type ApplyFixFailReason =
  | "spawn_error"
  | "parse_error"
  | "schema_violation"
  | "unsafe_path"
  | "write_failure";

/**
 * Drive a doer through one fix attempt. Returns when the worktree
 * contains the edits on disk (not yet committed).
 */
export async function applyFixForComment(
  args: ApplyFixArgs,
): Promise<ApplyFixResult> {
  const shim = pickShimForVoice(args.lineage as never, args.model);
  const prompt = buildFixPrompt(args);
  const result = await requestStructured({
    shim,
    spawn: {
      cwd: args.worktreePath,
      model: args.model,
      abortSignal: args.abortSignal,
      timeoutMs: args.timeoutMs,
    },
    prompt,
    schema: FixPlanSchema,
    schemaDescription:
      'A JSON object: { "commit_message": string, "files": [{ "path": string, "new_contents": string }, ...], "notes"?: string }. Paths are project-relative; new_contents is the literal complete file body after your fix.',
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      detail: result.detail,
      rawText: result.rawText,
    };
  }

  const safeRoot = fs.realpathSync(args.worktreePath);
  const written: string[] = [];
  for (const edit of result.data.files) {
    const absTarget = path.resolve(args.worktreePath, edit.path);
    // Resolve to canonical path and ensure it's still under the
    // worktree root — defends against `../` traversal AND symlink
    // escape from a malicious or confused doer.
    const canonical = canonicalize(absTarget);
    if (!canonical.startsWith(safeRoot + path.sep) && canonical !== safeRoot) {
      return {
        ok: false,
        reason: "unsafe_path",
        detail: `path escapes worktree: ${edit.path}`,
        rawText: result.rawText,
      };
    }
    try {
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, edit.new_contents);
    } catch (err) {
      return {
        ok: false,
        reason: "write_failure",
        detail: (err as Error).message,
        rawText: result.rawText,
      };
    }
    written.push(edit.path);
  }

  return {
    ok: true,
    filesChanged: written,
    commitMessage: result.data.commit_message,
    notes: result.data.notes ?? null,
    rawText: result.rawText,
  };
}

/**
 * Compose the doer prompt. Pure — no I/O, exported for tests so the
 * prompt structure stays under test independent of the network path.
 */
export function buildFixPrompt(args: ApplyFixArgs): string {
  const sections: string[] = [];
  sections.push(
    `You are a code-fix agent for a PR-review babysit loop. A reviewer bot left a comment on PR #${args.ctx.prNumber} (\`${args.ctx.owner}/${args.ctx.repo}\`): "${args.ctx.title}".`,
  );
  sections.push(`The PR targets the \`${args.ctx.baseBranch}\` branch.`);
  sections.push(
    `The judge has already classified this comment as **${args.tier}** with rationale:\n> ${args.judgementRationale}`,
  );
  sections.push(
    `Your job: produce the minimum file edits that address the comment. Do not refactor adjacent code. Do not add new tests unless the comment explicitly requests them.`,
  );

  sections.push("--- COMMENT ---");
  sections.push(`Author: ${args.comment.authorLogin}`);
  if (args.comment.path && args.comment.line !== null) {
    sections.push(`Anchored at: ${args.comment.path}:${args.comment.line}`);
  }
  sections.push("");
  sections.push(args.comment.body);

  if (args.ctx.anchoredSnippet) {
    sections.push("--- SURROUNDING CODE ---");
    sections.push(args.ctx.anchoredSnippet);
  }

  sections.push("--- WORKTREE ---");
  sections.push(
    `You are operating in: \`${args.worktreePath}\`. All paths in your response are relative to this directory. Read existing files there before rewriting them so you don't accidentally truncate unrelated content.`,
  );
  sections.push(
    `Return the COMPLETE new contents for each file you change — not a diff. Trivial fixes typically touch 1-3 files.`,
  );
  return sections.join("\n\n");
}

/** Best-effort canonical path. If the path doesn't yet exist (new
 *  file being created), canonicalise its parent and re-append the
 *  basename — that way symlinks in the parent chain are still
 *  resolved before the safety check. */
function canonicalize(absPath: string): string {
  if (fs.existsSync(absPath)) {
    return fs.realpathSync(absPath);
  }
  let parent = path.dirname(absPath);
  // Walk up until we find an existing ancestor we can realpath.
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
    parent = path.dirname(parent);
  }
  const real = fs.realpathSync(parent);
  return path.resolve(real, path.relative(parent, absPath));
}
