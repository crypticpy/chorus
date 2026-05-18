"use client";

import {
  ArrowRight,
  FolderSearch,
  GitPullRequest,
  Info,
  Layers,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, useTransition } from "react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  createChat,
  createChatFromPr,
  DaemonError,
  listTemplates,
} from "@/lib/api";
import { getBillingMode, type BillingMode } from "@/lib/api/settings";
import { AUDIT_PRESETS, type AuditPreset } from "@/lib/template-schema";
import { isReviewOnlyTemplate, type Template } from "@/lib/types";
import {
  deriveReviewOnlyTitle,
  estimateCost,
  type Attachment,
} from "./helpers";
import { Picker } from "./picker";
import { PromptCard } from "./prompt-card";

/**
 * One-liner hints displayed under each audit preset. Lives client-side
 * because the actual preset prompts are loaded daemon-side from
 * `src/daemon/presets/` — these are just summary chips.
 */
const AUDIT_PRESET_HINTS: Record<AuditPreset, string> = {
  "de-slopify": "Cut clutter, dead code, and AI-tell phrasing.",
  "monolith-breakdown": "Identify cleavage planes and module extractions.",
  "code-review": "Bugs, smells, missing edge cases.",
  "engineering-review": "Test coverage, observability, error handling.",
  "architecture-review": "Boundaries, dependency direction, cohesion.",
};

export default function NewChatPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="p-8 text-sm text-muted-foreground">Loading…</div>
        </AppShell>
      }
    >
      <NewChatPageInner />
    </Suspense>
  );
}

function NewChatPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((err) =>
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load templates",
        ),
      );
  }, []);

  // Defaults to 'api' until the daemon answers, so users on subscriptions
  // see the conservative dollar estimate briefly on first paint, then
  // the truthful "subscription quota" badge once the request resolves.
  const [billingMode, setBillingMode] = useState<BillingMode>("api");
  useEffect(() => {
    getBillingMode()
      .then((b) => setBillingMode(b.mode))
      .catch(() => {
        /* leave default 'api' */
      });
  }, []);

  const templateId = params.get("template") ?? templates[0]?.id ?? "";
  const [prompt, setPrompt] = useState("");
  // Attachments are deferred to v0.8. Empty array kept so cost-estimate
  // math doesn't have to branch and the daemon-call shape stays the same.
  const attachments: Attachment[] = [];

  const template = templates.find((t) => t.id === templateId) ?? templates[0];

  const costEstimate = useMemo(
    () => estimateCost({ template, prompt, attachments }),

    [prompt, attachments, template],
  );

  // Cost-cap gate uses the worst-case (with retries) projection so a chat
  // doesn't sneak under the cap on the headline number then exceed it on
  // the first round of disagreement. Skipped entirely in subscription
  // mode where the user isn't paying per call.
  const overCap = Boolean(
    billingMode !== "subscription" &&
    template?.costCapUsd &&
    template.costCapUsd > 0 &&
    costEstimate.usdRangeMax > template.costCapUsd,
  );

  const [yoloMode, setYoloMode] = useState(false);
  const [repoPath, setRepoPath] = useState("");

  // 'prompt' is the historical free-form path; 'pr' fetches a GitHub PR
  // via the daemon's gh shell-out and seeds a review-only chat from the
  // synthesized artifact. PR mode requires a review-only template; we
  // surface a validation error if the picker is on a doer template.
  // 'audit' points chorus at a repo and a preset lens (de-slopify,
  // monolith-breakdown, …); the preset selects the matching audit-*
  // template, which the daemon ships as a built-in.
  const [mode, setMode] = useState<"prompt" | "pr" | "audit">("prompt");
  const [prUrl, setPrUrl] = useState("");
  const [auditPreset, setAuditPreset] = useState<AuditPreset>("code-review");

  const reviewOnly = isReviewOnlyTemplate(template);
  const artifactSpec = reviewOnly ? template?.phases?.[0]?.artifact : undefined;

  async function handleStartFromPr() {
    if (!template) return;
    const trimmed = prUrl.trim();
    if (!trimmed) {
      setCreateError("Paste a GitHub PR URL.");
      return;
    }
    if (!reviewOnly) {
      setCreateError(
        "PR review needs a review-only template. Pick one from the template list.",
      );
      return;
    }
    setCreateError(null);
    startTransition(async () => {
      try {
        // PR flow runs against the GitHub PR data only — never forward the
        // shared `repoPath` state, which may hold a stale value from a prior
        // mode switch even though the (disabled) input shows blank.
        const chat = await createChatFromPr({
          url: trimmed,
          templateId: template.id,
          yolo: yoloMode,
        });
        router.push(`/runs/${chat.slug || chat.id}`);
      } catch (err) {
        setCreateError(
          err instanceof DaemonError ? err.message : "Failed to fetch PR",
        );
      }
    });
  }

  async function handleStartAudit() {
    const trimmedRepo = repoPath.trim();
    if (trimmedRepo.length === 0) {
      setCreateError("Repo path is required for an audit run.");
      return;
    }
    if (!trimmedRepo.startsWith("/")) {
      setCreateError("Repo path must be absolute (start with `/`).");
      return;
    }
    // Convention: each preset ships as its own built-in template id so
    // the daemon picks up the right system prompt + reviewer wiring.
    // The audit-template suite lands with the audit-phase implementation;
    // until then, the daemon returns a clean "template not found" error
    // here, which surfaces in createError.
    const auditTemplateId = `audit-${auditPreset}`;
    setCreateError(null);
    startTransition(async () => {
      try {
        const repoBasename = trimmedRepo.replace(/\/+$/, "").split("/").pop();
        const chat = await createChat({
          work: `Audit ${repoBasename ?? trimmedRepo} (${auditPreset})`,
          templateId: auditTemplateId,
          repoPath: trimmedRepo,
          yolo: yoloMode,
        });
        router.push(`/runs/${chat.slug || chat.id}`);
      } catch (err) {
        setCreateError(
          err instanceof DaemonError ? err.message : "Failed to start audit",
        );
      }
    });
  }

  async function handleStartRun() {
    if (!template || !prompt) return;

    // Pre-flight artifact size check so users hit a clear error before
    // the network round-trip. The daemon enforces this too — this is
    // just a nicer error path. Falls back to the schema default (1 MiB)
    // when the template doesn't declare its own cap.
    if (reviewOnly && artifactSpec) {
      const byteLen = new TextEncoder().encode(prompt).length;
      if (byteLen > artifactSpec.maxBytes) {
        setCreateError(
          `Artifact is ${byteLen.toLocaleString()} bytes; this template caps at ${artifactSpec.maxBytes.toLocaleString()}. Trim it down.`,
        );
        return;
      }
    }

    setCreateError(null);
    startTransition(async () => {
      try {
        const trimmedRepo = repoPath.trim();
        const chat = await createChat({
          // For review-only templates, `prompt` IS the artifact. work is
          // a static framing brief — reviewers see it but it doesn't
          // drive their critique. We derive a recognisable title from
          // the first non-empty, non-fenced line of the artifact so the
          // sidebar and run header reflect what the user actually
          // pasted, not the template's framing prompt.
          work: reviewOnly ? deriveReviewOnlyTitle(prompt) : prompt,
          templateId: template.id,
          files:
            attachments.length > 0 ? attachments.map((a) => a.name) : undefined,
          ...(reviewOnly ? { artifact: prompt } : {}),
          // Ship phase is meaningless for review-only — runner enforces
          // this too, but skip wiring repoPath so the cockpit doesn't
          // pretend it'll open a PR.
          ...(!reviewOnly && trimmedRepo.length > 0
            ? { repoPath: trimmedRepo }
            : {}),
          // Yolo only matters for chats with a ship phase; the daemon
          // ignores it on review-only runs. Sending unconditionally
          // keeps the call signature simple.
          yolo: yoloMode,
        });
        router.push(`/runs/${chat.slug || chat.id}`);
      } catch (err) {
        setCreateError(
          err instanceof DaemonError ? err.message : "Failed to create chat",
        );
      }
    });
  }

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading templates</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!template) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-6xl px-4 py-12 text-sm text-muted-foreground sm:px-6 md:px-8">
          Loading templates…
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="New chat"
          title={
            reviewOnly
              ? "Paste an artifact. Get reviews."
              : "Paste a task. Pick a template."
          }
          subtitle={
            reviewOnly
              ? "Chorus skips the doer and runs your text past three reviewers. Single pass — revise yourself and resubmit for another round."
              : "Chorus runs it past your reviewers and reports consensus."
          }
        />

        {createError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{createError}</p>
          </div>
        )}

        <div
          role="tablist"
          aria-label="Input mode"
          className="mb-4 inline-flex rounded-lg border border-border bg-card/30 p-1"
        >
          <button
            role="tab"
            aria-selected={mode === "prompt"}
            type="button"
            onClick={() => {
              setMode("prompt");
              setCreateError(null);
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              mode === "prompt"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Free-form
          </button>
          <button
            role="tab"
            aria-selected={mode === "pr"}
            type="button"
            onClick={() => {
              setMode("pr");
              setCreateError(null);
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              mode === "pr"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitPullRequest className="h-3.5 w-3.5" />
            GitHub PR
          </button>
          <button
            role="tab"
            aria-selected={mode === "audit"}
            type="button"
            onClick={() => {
              setMode("audit");
              setCreateError(null);
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              mode === "audit"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FolderSearch className="h-3.5 w-3.5" />
            Audit a repo
          </button>
        </div>

        <div
          className={`mb-4 flex flex-wrap items-center gap-2 ${mode === "audit" ? "hidden" : ""}`}
        >
          <Picker
            icon={<Layers className="h-3.5 w-3.5" />}
            label="Template"
            value={template?.name || "Select a template"}
            wide
          >
            <ul className="space-y-1">
              {templates.map((t) => {
                // Templates whose seed-time adapter couldn't fill every
                // slot are non-runnable until the user edits the YAML.
                // Don't let them be selected here — silent failure
                // would surface as a confusing "no model" error mid-run.
                const incomplete = t.isComplete === false;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      disabled={incomplete}
                      onClick={() => {
                        if (incomplete) return;
                        const newParams = new URLSearchParams(params);
                        newParams.set("template", t.id);
                        router.push(`/new?${newParams.toString()}`);
                      }}
                      className={`block w-full rounded-md p-2 text-left transition ${
                        incomplete
                          ? "cursor-not-allowed opacity-50"
                          : t.id === templateId
                            ? "bg-accent"
                            : "hover:bg-accent/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.name}</span>
                        {isReviewOnlyTemplate(t) && (
                          <Badge
                            variant="outline"
                            className="border-blue-500/30 bg-blue-500/10 font-mono text-[9px] uppercase text-blue-300"
                          >
                            review only
                          </Badge>
                        )}
                        {incomplete && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 font-mono text-[9px] uppercase text-amber-300"
                          >
                            needs setup
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {incomplete
                          ? "Edit this template's YAML to fill in models for your fleet."
                          : t.description}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Picker>
        </div>

        {mode === "prompt" && (
          <PromptCard
            template={template}
            prompt={prompt}
            setPrompt={setPrompt}
            reviewOnly={reviewOnly}
            artifactSpec={artifactSpec}
            billingMode={billingMode}
            costEstimate={costEstimate}
            overCap={overCap}
            isPending={isPending}
            onStart={handleStartRun}
          />
        )}
        {mode === "pr" && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <label
              htmlFor="pr-url"
              className="block text-sm font-medium text-foreground"
            >
              Pull request URL
            </label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
              Chorus shells out to{" "}
              <code className="rounded bg-muted px-1">gh</code> on this machine
              to fetch the PR&apos;s description, diff, and existing comments.
              You must be logged in via{" "}
              <code className="rounded bg-muted px-1">gh auth login</code>.
            </p>
            <input
              id="pr-url"
              type="url"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              spellCheck={false}
              autoComplete="off"
            />
            {!reviewOnly && (
              <p className="mt-2 text-[11px] text-amber-300">
                Pick a review-only template — PR review skips the doer.
              </p>
            )}
            <button
              type="button"
              onClick={handleStartFromPr}
              disabled={isPending || !reviewOnly || prUrl.trim().length === 0}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Fetching PR…" : "Fetch & start review"}
              {!isPending && <ArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
        {mode === "audit" && (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="mb-3">
              <span className="block text-sm font-medium text-foreground">
                Audit lens
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Each preset frames the audit reviewer&apos;s worldview. The
                reviewer reads your repo and emits a structured checklist — you
                approve it before the orchestrator fans the work out to workers.
              </p>
            </div>
            <div className="mb-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {AUDIT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAuditPreset(p)}
                  className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                    auditPreset === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background hover:border-foreground/30"
                  }`}
                >
                  <div className="font-mono text-[11px] uppercase tracking-wide">
                    {p}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {AUDIT_PRESET_HINTS[p]}
                  </div>
                </button>
              ))}
            </div>

            <label
              htmlFor="audit-repo"
              className="block text-sm font-medium text-foreground"
            >
              Repo path
            </label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
              Absolute path to the repo on this machine. Workers branch off HEAD
              into{" "}
              <code className="rounded bg-muted px-1">
                chorus/&lt;chatId&gt;/worker-N
              </code>{" "}
              when the orchestrator phase fires.
            </p>
            <input
              id="audit-repo"
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={handleStartAudit}
              disabled={isPending || repoPath.trim().length === 0}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Starting audit…" : "Run audit"}
              {!isPending && <ArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}

        {overCap && mode === "prompt" && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
            <span>
              Estimated cost{" "}
              <span className="font-mono">${costEstimate.usd.toFixed(3)}</span>{" "}
              exceeds template cap{" "}
              <span className="font-mono">
                ${template.costCapUsd.toFixed(2)}
              </span>
              . Trim attachments, shorten the prompt, or raise the cap in
              template settings.
            </span>
          </div>
        )}

        {/* Always render so the row's vertical position is stable across
            templates. Disabled on review-only since there's no doer to make
            edits and no Ship phase to open a PR — but keeping it visible
            tells the user what they'd unlock by switching templates.
            Hidden in audit mode where the repo path lives inside the
            audit card. */}
        <div
          className={`mb-4 rounded-lg border border-dashed border-border bg-card/30 p-4 ${reviewOnly ? "opacity-50" : ""} ${mode === "audit" ? "hidden" : ""}`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Target repo{" "}
              <span className="text-muted-foreground">(optional)</span>
            </span>
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] uppercase text-emerald-300"
            >
              opens PR
            </Badge>
          </div>
          <input
            type="text"
            value={reviewOnly ? "" : repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            disabled={reviewOnly}
            placeholder="/absolute/path/to/repo"
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            spellCheck={false}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {reviewOnly ? (
              "Review-only templates have no doer and no Ship phase, so there's nothing to commit. Pick a template with a doer (e.g. Tri-Review) to open a PR."
            ) : (
              <>
                When set: doer makes real edits in this repo. After reviewers
                agree, chorus opens a PR via{" "}
                <code className="rounded bg-muted px-1">gh pr create</code> (no
                auto-merge — you review + click Merge in GitHub). Leave blank to
                skip the Ship phase.
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setYoloMode((v) => !v)}
          className={`mb-4 flex w-full items-start justify-between gap-3 rounded-lg border px-4 py-3 text-left transition ${
            yoloMode
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-dashed border-border bg-card/30 hover:border-foreground/30"
          }`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-7 w-7 place-items-center rounded-md text-sm ${
                yoloMode
                  ? "bg-rose-500/20 text-rose-300"
                  : "bg-card text-muted-foreground"
              }`}
            >
              🚀
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Yolo mode
                </span>
                <Badge
                  variant="outline"
                  className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] uppercase text-rose-300"
                >
                  unsafe
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {yoloMode
                  ? "Reviewer gates auto-approve. Permission prompts auto-allow. The driver merges without asking. Cost cap still enforced."
                  : "Skip every ask-user gate for this single run. Useful for trusted templates or trivial fixes."}
              </p>
            </div>
          </div>
          <span
            className={`flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition ${
              yoloMode
                ? "border-rose-500/40 bg-rose-500/20"
                : "border-border bg-card"
            }`}
          >
            <span
              className={`h-3.5 w-3.5 rounded-full transition-transform ${
                yoloMode
                  ? "translate-x-4 bg-rose-400"
                  : "bg-muted-foreground/50"
              }`}
            />
          </span>
        </button>
      </div>
    </AppShell>
  );
}
