"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
}

function family(model: string): "opus" | "sonnet" | "haiku" | "other" {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "other";
}

const FAMILY_LABEL: Record<ReturnType<typeof family>, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  other: "Other",
};

export function ModelPicker({ value, options, onChange, disabled, id }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const allOptions = useMemo(() => {
    return options.includes(value) ? options : [...options, value];
  }, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((m) => m.toLowerCase().includes(q));
  }, [allOptions, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const m of filtered) {
      const fam = FAMILY_LABEL[family(m)];
      (groups[fam] ??= []).push(m);
    }
    return Object.entries(groups);
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        id={id}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground transition-colors hover:bg-muted/40 focus:outline-none focus:border-foreground/30 disabled:opacity-50",
          open && "border-foreground/30 bg-muted/40"
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Sparkles className="size-3 text-state-review" />
        <span className="truncate max-w-[180px]">{value}</span>
        <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-border/60 bg-card shadow-lg shadow-black/20 animate-fade-in">
          <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
            <Search className="size-3 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="flex-1 bg-transparent text-[12px] placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {grouped.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                No models match.
              </div>
            ) : (
              grouped.map(([label, models]) => (
                <div key={label}>
                  <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {label}
                  </div>
                  {models.map((m) => {
                    const selected = m === value;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          onChange(m);
                          setOpen(false);
                          setQuery("");
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] font-mono transition-colors",
                          selected
                            ? "bg-muted/60 text-foreground"
                            : "text-foreground/90 hover:bg-muted/40"
                        )}
                      >
                        <Check
                          className={cn(
                            "size-3 shrink-0",
                            selected ? "text-state-done" : "opacity-0"
                          )}
                        />
                        <span className="truncate">{m}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
