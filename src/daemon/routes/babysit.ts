/**
 * PR babysit registration + observation routes.
 *
 *   POST  /babysit/jobs       { url, installationId? }     → upsert idle job
 *   GET   /babysit/jobs                                    → list jobs
 *   GET   /babysit/jobs/:id                                → fetch one job + recent decisions
 *   PATCH /babysit/jobs/:id   { action: 'pause'|'resume' } → toggle scheduler eligibility
 *
 * The scheduler treats `paused` as non-dispatchable, so a paused job stays
 * registered (and visible) but the state machine won't pick it up until
 * resumed (which puts it back into `idle`).
 */
import type { FastifyInstance } from "fastify";
import {
  babysitDecisions,
  babysitJobs,
  type BabysitJob,
} from "../../lib/db/index.js";
import {
  errorResponse,
  sendError,
  successResponse,
  type ApiResponse,
} from "../api-response.js";
import { parsePrUrl } from "../github-pr.js";

interface BabysitJobView extends BabysitJob {}

interface BabysitJobDetailView {
  job: BabysitJobView;
  decisions: Array<{
    id: number;
    decided_at: number;
    comment_id: number;
    comment_author: string;
    bot: string | null;
    validity: string;
    category: string;
    confidence: number;
    outcome: string | null;
  }>;
}

export function registerBabysitRoutes(fastify: FastifyInstance): void {
  fastify.post<{
    Body: { url?: string; installationId?: number | null };
    Reply: ApiResponse<{ job: BabysitJobView; created: boolean }>;
  }>("/babysit/jobs", async (request, reply) => {
    const { url, installationId } = request.body ?? {};
    if (!url || typeof url !== "string") {
      return sendError(reply, "validation", "url is required");
    }

    const parsed = parsePrUrl(url);
    if (!parsed) {
      return sendError(
        reply,
        "validation",
        "url must be a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>)",
      );
    }

    const repo = `${parsed.owner}/${parsed.repo}`;
    const id = babysitJobs.id(repo, parsed.number);

    // Upsert: if the job already exists (re-registration of the same PR),
    // return the existing row without touching its state. This makes the
    // endpoint idempotent — Claude Code calling babysit_pr twice for the
    // same URL doesn't reset a job mid-flight.
    const existing = await babysitJobs.getById(id);
    if (existing) {
      return successResponse({ job: existing, created: false });
    }

    try {
      const job = await babysitJobs.create({
        repo,
        pr_number: parsed.number,
        installation_id:
          typeof installationId === "number" ? installationId : null,
      });
      return successResponse({ job, created: true });
    } catch (err) {
      return errorResponse(
        "db_error",
        `failed to create babysit job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  fastify.get<{
    Querystring: { state?: string; active?: string };
    Reply: ApiResponse<{ items: BabysitJobView[]; total: number }>;
  }>("/babysit/jobs", async (request) => {
    const { state, active } = request.query ?? {};
    let items: BabysitJob[];
    if (active === "true" || active === "1") {
      items = await babysitJobs.listActive();
    } else if (typeof state === "string" && state.length > 0) {
      // The DB layer's enum-narrowing happens inside list(); we forward the
      // string and let zod reject unknown values via the underlying schema.
      items = await babysitJobs.list({ state: state as never });
    } else {
      items = await babysitJobs.list();
    }
    return successResponse({ items, total: items.length });
  });

  fastify.patch<{
    Params: { id: string };
    Body: { action?: string };
    Reply: ApiResponse<{ job: BabysitJobView }>;
  }>("/babysit/jobs/:id", async (request, reply) => {
    const { id } = request.params;
    const action = request.body?.action;
    if (action !== "pause" && action !== "resume") {
      return sendError(
        reply,
        "validation",
        "action must be 'pause' or 'resume'",
      );
    }
    const existing = await babysitJobs.getById(id);
    if (!existing) {
      return sendError(reply, "not_found", `babysit job not found: ${id}`);
    }
    if (action === "pause") {
      // Terminal jobs can't be paused — there's nothing for the scheduler
      // to skip once a job is merged or escalated.
      if (existing.state === "merged" || existing.state === "escalated") {
        return sendError(
          reply,
          "conflict",
          `cannot pause job in terminal state '${existing.state}'`,
        );
      }
      if (existing.state === "paused") {
        return successResponse({ job: existing });
      }
      // Re-open ended_at so the job re-enters listActive() once resumed.
      const job = await babysitJobs.setState(id, "paused", { ended_at: null });
      return successResponse({ job });
    }
    // resume
    if (existing.state !== "paused") {
      return sendError(
        reply,
        "conflict",
        `can only resume a paused job (current state: '${existing.state}')`,
      );
    }
    const job = await babysitJobs.setState(id, "idle", { ended_at: null });
    return successResponse({ job });
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<BabysitJobDetailView>;
  }>("/babysit/jobs/:id", async (request, reply) => {
    const { id } = request.params;
    const job = await babysitJobs.getById(id);
    if (!job) {
      return sendError(reply, "not_found", `babysit job not found: ${id}`);
    }
    const rawDecisions = await babysitDecisions.listForJob(id);
    const decisions = rawDecisions.map((d) => ({
      id: d.id,
      decided_at: d.decided_at,
      comment_id: d.comment_id,
      comment_author: d.comment_author,
      bot: d.bot,
      validity: d.validity,
      category: d.category,
      confidence: d.confidence,
      outcome: d.outcome,
    }));
    return successResponse({ job, decisions });
  });
}
