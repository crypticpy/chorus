import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { logger } from "../../lib/logger.js";
import {
  sendError,
  successResponse,
  type ApiResponse,
} from "../api-response.js";
import type { ErrorDetector } from "../error-detector.js";
import {
  fetchPrArtifact,
  parsePrUrl,
  type PrFailReason,
} from "../github-pr.js";
import type { TmuxManager } from "../tmux-types.js";
import { createChatFromValidatedInputs } from "./chats.js";

interface RegisterArgs {
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
}

// Maps gh CLI failure classifications to API error codes. `auth` and
// `gh_not_installed` surface as validation errors so the cockpit can show
// actionable guidance ("install gh", "run gh auth login") rather than a
// generic 500.
const FAIL_TO_CODE: Record<
  PrFailReason,
  "validation" | "not_found" | "db_error"
> = {
  invalid_url: "validation",
  gh_not_installed: "validation",
  gh_not_authed: "validation",
  pr_not_found: "not_found",
  network_failure: "db_error",
  unknown: "db_error",
};

export function registerChatsFromPrRoute(
  fastify: FastifyInstance,
  { tmuxMgr, errorDetector }: RegisterArgs,
): void {
  fastify.post<{
    Body: {
      url: string;
      templateId: string;
      repoPath?: string;
      yolo?: boolean;
    };
    Reply: ApiResponse<object>;
  }>("/chats/from-pr", async (request, reply) => {
    try {
      const { url, templateId, repoPath, yolo } = request.body ?? {};

      if (!url || !templateId) {
        return sendError(
          reply,
          "validation",
          "url and templateId are required",
        );
      }

      const parsed = parsePrUrl(url);
      if (!parsed) {
        return sendError(
          reply,
          "validation",
          "url must be a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>)",
        );
      }

      // repoPath canonicalization mirrors POST /chats. Optional here — when
      // omitted, the chat is detached and runs purely off the synthesized
      // PR artifact.
      let canonicalRepoPath: string | undefined;
      if (repoPath !== undefined) {
        if (typeof repoPath !== "string" || !path.isAbsolute(repoPath)) {
          return sendError(
            reply,
            "validation",
            "repoPath must be an absolute path",
          );
        }
        const resolved = path.resolve(repoPath);
        try {
          canonicalRepoPath = fs.realpathSync(resolved);
        } catch {
          return sendError(
            reply,
            "validation",
            `repoPath does not exist: ${resolved}`,
          );
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(canonicalRepoPath);
        } catch {
          return sendError(
            reply,
            "validation",
            `repoPath does not exist: ${canonicalRepoPath}`,
          );
        }
        if (!stat.isDirectory()) {
          return sendError(
            reply,
            "validation",
            `repoPath must be a directory: ${canonicalRepoPath}`,
          );
        }
      }

      const fetched = await fetchPrArtifact(parsed, canonicalRepoPath);
      if (!fetched.ok) {
        return sendError(reply, FAIL_TO_CODE[fetched.reason], fetched.detail, {
          reason: fetched.reason,
        });
      }

      // Use the PR title as `work` so the chat list shows something
      // meaningful. Fall back to "Review PR <owner>/<repo>#<n>" if the
      // PR has no title (rare but possible).
      const work =
        fetched.meta.title?.trim() ||
        `Review PR ${parsed.owner}/${parsed.repo}#${parsed.number}`;

      const result = await createChatFromValidatedInputs({
        work,
        templateId,
        canonicalRepoPath,
        artifact: fetched.artifact,
        yolo,
        // PR review chats run with the full fleet at full capacity —
        // the orchestrate scheduler skips voice.tier gating when this
        // is set. Reviews are short, parallel, and the user is asking
        // for the most thorough opinion possible.
        bypassQuota: true,
        requestId: request.id,
        tmuxMgr,
        errorDetector,
      });
      if (!result.ok) {
        return sendError(reply, result.code, result.message, result.data);
      }

      logger.info(
        {
          requestId: request.id,
          chatId: result.chat.id,
          prUrl: `${parsed.owner}/${parsed.repo}#${parsed.number}`,
          artifactBytes: Buffer.byteLength(fetched.artifact, "utf-8"),
        },
        "chat created from PR",
      );

      return successResponse({
        ...result.chat,
        pr: {
          owner: parsed.owner,
          repo: parsed.repo,
          number: parsed.number,
          title: fetched.meta.title,
          author: fetched.meta.authorLogin,
          baseBranch: fetched.meta.baseBranch,
          headBranch: fetched.meta.headBranch,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { requestId: request.id, err: message, route: "POST /chats/from-pr" },
        "chat-from-pr create failed",
      );
      return sendError(reply, "db_error", message);
    }
  });
}
