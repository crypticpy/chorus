"use client";

/**
 * Orchestrate manifest panel — rendered on the run page after the
 * orchestrate phase has produced `<chatDir>/orchestrate-manifest.json`.
 *
 * One row per worker. Failed workers show their error on hover; completed
 * workers expose Checkout + Open-PR actions that POST to the daemon.
 * Action feedback is local to the row (inline message) — no global toast,
 * no page-wide refresh, so two simultaneous clicks on different workers
 * don't clobber each other's status.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { OrchestrateManifest } from "@/lib/template-schema";

export interface OrchestrateManifestProps {
  chatId: string;
  manifest: OrchestrateManifest;
}

type RowAction = "checkout" | "open-pr";

interface RowFeedback {
  kind: "success" | "error";
  text: string;
}

const STATUS_BADGE: Record<
  "completed" | "failed",
  { label: string; cls: string }
> = {
  completed: {
    label: "completed",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  },
  failed: {
    label: "failed",
    cls: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
};

export function OrchestrateManifest({
  chatId,
  manifest,
}: OrchestrateManifestProps) {
  // Two parallel maps so a Checkout in flight on row N doesn't lock
  // out an Open-PR click on row N — each action gets its own pending
  // flag. The feedback map is keyed by `<idx>:<action>` for the same
  // reason.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, RowFeedback>>({});

  const keyOf = (idx: number, action: RowAction): string => `${idx}:${action}`;

  const runAction = async (idx: number, action: RowAction): Promise<void> => {
    const key = keyOf(idx, action);
    setPending((prev) => ({ ...prev, [key]: true }));
    setFeedback((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const url = `/api/daemon/chats/${chatId}/workers/${idx}/${action}`;
      const res = await fetch(url, { method: "POST" });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { branch?: string; head?: string; prUrl?: string };
        error?: { message?: string };
      } | null;
      if (!res.ok || !body || body.ok !== true) {
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        setFeedback((prev) => ({
          ...prev,
          [key]: { kind: "error", text: msg },
        }));
        return;
      }
      const successText =
        action === "checkout"
          ? `Checked out ${body.data?.branch ?? "branch"}${
              body.data?.head ? ` @ ${body.data.head}` : ""
            }`
          : body.data?.prUrl
            ? `PR opened: ${body.data.prUrl}`
            : "PR opened";
      setFeedback((prev) => ({
        ...prev,
        [key]: { kind: "success", text: successText },
      }));
    } catch (err) {
      setFeedback((prev) => ({
        ...prev,
        [key]: {
          kind: "error",
          text: err instanceof Error ? err.message : "Request failed",
        },
      }));
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  if (manifest.workers.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <span className="text-sm font-medium text-foreground">
          Orchestrate manifest
        </span>
        <p className="mt-2 text-[11px] text-muted-foreground">
          No workers ran for this chat (the audit checklist may have been
          empty).
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          Orchestrate manifest
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {manifest.workers.length} worker
          {manifest.workers.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Each worker ran on its own branch. Checkout switches your repo to that
        branch (refused on a dirty tree); Open PR runs{" "}
        <code className="rounded bg-muted px-1">gh pr create</code> against it.
      </p>
      <ul className="space-y-2">
        {manifest.workers.map((w) => {
          const badge = STATUS_BADGE[w.status];
          const checkoutKey = keyOf(w.idx, "checkout");
          const openPrKey = keyOf(w.idx, "open-pr");
          const checkoutPending = pending[checkoutKey];
          const openPrPending = pending[openPrKey];
          const checkoutFeedback = feedback[checkoutKey];
          const openPrFeedback = feedback[openPrKey];
          const disabled = w.status !== "completed";
          return (
            <li
              key={w.idx}
              className="rounded-md border border-border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  worker-{w.idx}
                </span>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono text-[11px] text-foreground">
                  {w.voiceId}
                </span>
                <Badge
                  variant="outline"
                  className={`font-mono text-[9px] uppercase ${badge.cls}`}
                  title={
                    w.status === "failed" ? (w.error ?? "failed") : undefined
                  }
                >
                  {badge.label}
                </Badge>
              </div>
              <div className="mt-2">
                <code className="block w-full overflow-x-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {w.branch}
                </code>
              </div>
              {w.diffStat && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted px-2 py-1 font-mono text-[10px] leading-snug text-muted-foreground">
                  {w.diffStat}
                </pre>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => runAction(w.idx, "checkout")}
                  disabled={disabled || checkoutPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkoutPending ? "Checking out…" : "Checkout"}
                </button>
                <button
                  type="button"
                  onClick={() => runAction(w.idx, "open-pr")}
                  disabled={disabled || openPrPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {openPrPending ? "Opening PR…" : "Open PR"}
                </button>
                {checkoutFeedback && (
                  <span
                    className={`text-[10px] ${
                      checkoutFeedback.kind === "success"
                        ? "text-emerald-300"
                        : "text-rose-300"
                    }`}
                  >
                    {checkoutFeedback.text}
                  </span>
                )}
                {openPrFeedback && (
                  <span
                    className={`text-[10px] ${
                      openPrFeedback.kind === "success"
                        ? "text-emerald-300"
                        : "text-rose-300"
                    }`}
                  >
                    {openPrFeedback.kind === "success" &&
                    openPrFeedback.text.startsWith("PR opened: ") ? (
                      <a
                        href={openPrFeedback.text.replace(/^PR opened: /, "")}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-emerald-200"
                      >
                        {openPrFeedback.text}
                      </a>
                    ) : (
                      openPrFeedback.text
                    )}
                  </span>
                )}
              </div>
              {w.status === "failed" && w.error && (
                <p className="mt-2 text-[10px] text-rose-300">{w.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
