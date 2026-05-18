/**
 * `chorus babysit` — inspect + control the PR-babysit scheduler from the CLI.
 *
 *   chorus babysit register <pr-url> [--installation-id <n>]
 *   chorus babysit list [--active] [--state <state>]
 *   chorus babysit show <id>
 *   chorus babysit pause <id>
 *   chorus babysit resume <id>
 *
 * All commands talk to the local daemon over its REST API. The job id is
 * "<owner>/<repo>#<number>" — pass it quoted in shells that treat # as a
 * comment.
 */
import type { Command } from "commander";
import { resolveDaemonUrl } from "../../lib/daemon-discovery.js";
import { c, header, kv, sym } from "../ui.js";

interface JobRow {
  id: string;
  repo: string;
  pr_number: number;
  state: string;
  updated_at: number;
  started_at: number;
  ended_at: number | null;
  fix_commits: number;
  total_judge_calls: number;
  total_fix_calls: number;
  escalation_reason: string | null;
  installation_id: number | null;
  worktree_path: string | null;
}

interface DecisionRow {
  id: number;
  decided_at: number;
  comment_id: number;
  comment_author: string;
  bot: string | null;
  validity: string;
  category: string;
  confidence: number;
  outcome: string | null;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}
type ApiResult<T> = ApiOk<T> | ApiErr;

async function callDaemon<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
  const daemonUrl = await resolveDaemonUrl();
  let response: Response;
  try {
    response = await fetch(`${daemonUrl}/api/v1${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "connection_failed",
        message: "Daemon is not running. Start with `chorus start`.",
      },
    };
  }
  // The envelope itself carries ok/error so we trust the body shape over
  // HTTP status — but a non-JSON body (e.g. fastify 404 HTML) would throw.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: "parse_error",
        message: `Daemon returned non-JSON response (HTTP ${response.status})`,
      },
    };
  }
  return body as ApiResult<T>;
}

function relTime(ms: number | null): string {
  if (ms === null) return "—";
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function stateColor(state: string): string {
  switch (state) {
    case "idle":
      return c.dim(state);
    case "merged":
      return c.green(state);
    case "escalated":
      return c.red(state);
    case "paused":
      return c.yellow(state);
    case "judging":
    case "fixing":
    case "verifying":
    case "pushing":
    case "quiet_check":
    case "waiting":
      return c.cyan(state);
    default:
      return state;
  }
}

function dieWithError(err: { code: string; message: string }): never {
  console.log("");
  console.log(header(sym.err, err.message, err.code));
  console.log("");
  process.exit(1);
}

export function registerBabysitCommand(program: Command): void {
  const babysit = program
    .command("babysit")
    .description("Inspect + control the PR-babysit scheduler");

  babysit
    .command("register <url>")
    .description("Register a GitHub PR URL for babysitting")
    .option(
      "--installation-id <n>",
      "GitHub App installation id (enables App-auth writes)",
    )
    .action(async (url: string, opts: { installationId?: string }) => {
      const installationId =
        opts.installationId !== undefined
          ? Number(opts.installationId)
          : undefined;
      if (installationId !== undefined && !Number.isInteger(installationId)) {
        console.log(header(sym.err, "--installation-id must be an integer"));
        process.exit(1);
      }
      const res = await callDaemon<{ job: JobRow; created: boolean }>(
        "/babysit/jobs",
        {
          method: "POST",
          body: { url, installationId },
        },
      );
      if (!res.ok) dieWithError(res.error);
      const { job, created } = res.data;
      console.log("");
      console.log(
        header(
          sym.ok,
          created ? "Registered for babysitting" : "Already registered",
          job.id,
        ),
      );
      console.log("");
      console.log(
        kv([
          ["State", stateColor(job.state)],
          ["Repo", c.cyan(job.repo)],
          ["PR #", c.cyan(String(job.pr_number))],
          [
            "Installation",
            job.installation_id === null
              ? c.dim("none (CLI-auth fallback)")
              : c.cyan(String(job.installation_id)),
          ],
        ]),
      );
      console.log("");
    });

  babysit
    .command("list")
    .description("List babysit jobs")
    .option("--active", "Only show non-terminal jobs")
    .option("--state <state>", "Filter by state (idle, judging, paused, ...)")
    .action(async (opts: { active?: boolean; state?: string }) => {
      const query = new URLSearchParams();
      if (opts.active) query.set("active", "true");
      if (opts.state) query.set("state", opts.state);
      const qs = query.toString();
      const res = await callDaemon<{ items: JobRow[]; total: number }>(
        `/babysit/jobs${qs ? "?" + qs : ""}`,
      );
      if (!res.ok) dieWithError(res.error);
      const items = res.data.items;
      console.log("");
      if (items.length === 0) {
        console.log(header(sym.info, "No babysit jobs"));
        console.log("");
        return;
      }
      console.log(
        header(
          sym.bullet,
          `${items.length} job${items.length === 1 ? "" : "s"}`,
        ),
      );
      console.log("");
      // Compact table. Show id, state, fix_commits, updated_at-relative.
      const rows: Array<[string, string]> = items.map((j) => [
        j.id,
        `${stateColor(j.state).padEnd(20)}  ${c.dim("fixes=" + j.fix_commits)}  ${c.dim(relTime(j.updated_at))}`,
      ]);
      console.log(kv(rows));
      console.log("");
    });

  babysit
    .command("show <id>")
    .description("Show a babysit job + its decision log")
    .action(async (id: string) => {
      const res = await callDaemon<{
        job: JobRow;
        decisions: DecisionRow[];
      }>(`/babysit/jobs/${encodeURIComponent(id)}`);
      if (!res.ok) dieWithError(res.error);
      const { job, decisions } = res.data;
      console.log("");
      console.log(header(sym.bullet, job.id, stateColor(job.state)));
      console.log("");
      console.log(
        kv([
          ["Repo", c.cyan(job.repo)],
          ["PR #", c.cyan(String(job.pr_number))],
          ["Started", c.dim(relTime(job.started_at))],
          ["Updated", c.dim(relTime(job.updated_at))],
          [
            "Ended",
            job.ended_at === null ? c.dim("—") : c.dim(relTime(job.ended_at)),
          ],
          ["Fix commits", c.cyan(String(job.fix_commits))],
          ["Judge calls", c.dim(String(job.total_judge_calls))],
          ["Fix calls", c.dim(String(job.total_fix_calls))],
          [
            "Worktree",
            job.worktree_path === null ? c.dim("—") : c.dim(job.worktree_path),
          ],
          [
            "Escalation",
            job.escalation_reason === null
              ? c.dim("—")
              : c.red(job.escalation_reason),
          ],
        ]),
      );
      console.log("");
      if (decisions.length === 0) {
        console.log(`   ${c.dim("No comment decisions yet.")}`);
        console.log("");
        return;
      }
      console.log(
        `   ${c.bold("Decisions")} ${c.dim("(" + decisions.length + ")")}`,
      );
      console.log("");
      for (const d of decisions) {
        const validityColored =
          d.validity === "valid" ? c.green(d.validity) : c.dim(d.validity);
        const outcome = d.outcome ?? "—";
        console.log(
          `   ${sym.arrow} ${c.cyan(String(d.comment_id))} ${c.dim(d.comment_author)} ${validityColored} ${c.dim(d.category)} ${c.dim("→")} ${outcome}`,
        );
      }
      console.log("");
    });

  babysit
    .command("pause <id>")
    .description("Pause a babysit job (scheduler will skip it)")
    .action(async (id: string) => {
      const res = await callDaemon<{ job: JobRow }>(
        `/babysit/jobs/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { action: "pause" } },
      );
      if (!res.ok) dieWithError(res.error);
      console.log("");
      console.log(header(sym.ok, "Paused", res.data.job.id));
      console.log("");
    });

  babysit
    .command("resume <id>")
    .description("Resume a paused babysit job")
    .action(async (id: string) => {
      const res = await callDaemon<{ job: JobRow }>(
        `/babysit/jobs/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { action: "resume" } },
      );
      if (!res.ok) dieWithError(res.error);
      console.log("");
      console.log(header(sym.ok, "Resumed", res.data.job.id + " → idle"));
      console.log("");
    });
}
