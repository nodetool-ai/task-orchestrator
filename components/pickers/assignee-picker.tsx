"use client";

import { useEffect, useId, useState } from "react";
import { UserRound } from "lucide-react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  size?: "default" | "compact";
  className?: string;
}

let cache: string[] | null = null;
let inFlight: Promise<string[]> | null = null;
function loadAssignees(): Promise<string[]> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/assignees")
    .then((r) => r.json() as Promise<{ assignees: string[] }>)
    .then((b) => {
      cache = b.assignees;
      return cache;
    })
    .catch(() => []);
  return inFlight;
}

/**
 * Free-text input for the task assignee, with a <datalist> populated by
 * known persona ids and any assignees ever observed on existing tasks.
 * Keeps the freeform contract (assignee is `text` in the schema) while
 * making the common case a one-click selection.
 */
export function AssigneePicker({
  value,
  onChange,
  placeholder = "assignee",
  size = "default",
  className,
}: Props) {
  const [suggestions, setSuggestions] = useState<string[]>(cache ?? []);
  const listId = useId();

  useEffect(() => {
    if (cache) return;
    let alive = true;
    loadAssignees().then((s) => {
      if (alive) setSuggestions(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const cls =
    className ??
    (size === "compact"
      ? "rounded-sm border border-border/60 bg-background pl-6 pr-2 py-1 text-xs font-mono outline-none focus:border-foreground/40"
      : "rounded-md border border-border/60 bg-background pl-7 pr-2.5 py-1.5 text-sm font-mono outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors");

  return (
    <span className="relative inline-block">
      <UserRound
        className={
          size === "compact"
            ? "absolute left-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none"
            : "absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
        }
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={`assignees-${listId}`}
        className={cls}
      />
      <datalist id={`assignees-${listId}`}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </span>
  );
}
