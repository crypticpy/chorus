"use client";

/**
 * Audit checklist approval — rendered when an audit phase has emitted
 * its structured `AuditItem[]` and is blocked waiting for the user to
 * select which items the orchestrator should fan out to workers.
 *
 * Default state has every item selected. The user trims the list by
 * un-checking, then submits. The selected ids serialise as a JSON
 * payload through the existing `POST /chats/:id/resume` endpoint
 * (`answer: JSON.stringify(selectedIds)`); the audit phase parses that
 * back out before scheduling.
 */
import { ArrowRight } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import type { AuditItem } from "@/lib/template-schema";

export interface RunChecklistProps {
  items: AuditItem[];
  /**
   * Submit handler — the run-page wires this to the daemon's resume
   * endpoint with the selected ids JSON-encoded. Returning a rejected
   * promise surfaces the message in the inline error row.
   */
  onSubmit: (selectedIds: string[]) => Promise<void>;
}

const COMPLEXITY_BADGE: Record<
  AuditItem["complexity"],
  { label: string; cls: string }
> = {
  high: {
    label: "high",
    cls: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
  medium: {
    label: "med",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  },
  low: {
    label: "low",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  },
};

export function RunChecklist({ items, onSubmit }: RunChecklistProps) {
  const allIds = useMemo(() => items.map((i) => i.id), [items]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = (): void => {
    if (selected.size === 0) {
      setError("Pick at least one item or cancel the run.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await onSubmit([...selected]);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to submit checklist",
        );
      }
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          Audit checklist
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {selected.size} of {items.length} selected
        </span>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Trim the items you don&apos;t want shipped to workers. Each selected
        item runs on its own git branch under{" "}
        <code className="rounded bg-muted px-1">
          chorus/&lt;chatId&gt;/worker-N
        </code>
        .
      </p>
      <ul className="mb-4 space-y-1.5">
        {items.map((item) => {
          const checked = selected.has(item.id);
          const badge = COMPLEXITY_BADGE[item.complexity];
          return (
            <li key={item.id}>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                  checked
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-background hover:border-foreground/30"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(item.id)}
                  className="mt-1 h-3.5 w-3.5 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {item.summary}
                    </span>
                    <Badge
                      variant="outline"
                      className={`font-mono text-[9px] uppercase ${badge.cls}`}
                    >
                      {badge.label}
                    </Badge>
                  </div>
                  {item.rationale && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {item.rationale}
                    </p>
                  )}
                  {item.files.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.files.map((f) => (
                        <code
                          key={f}
                          className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
                        >
                          {f}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      {error && <p className="mb-2 text-[11px] text-rose-300">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isPending || selected.size === 0}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Submitting…" : "Approve & start workers"}
        {!isPending && <ArrowRight className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
