"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ModelOption {
  id: string;       // model ID, e.g. "claude-sonnet-4-6"
  name: string;     // display name, e.g. "Claude Sonnet 4.6"
  provider: string; // provider ID, e.g. "anthropic"
}

interface Props {
  value: string;          // currently selected "provider/modelId"
  options: ModelOption[];
  onChange: (next: string) => void; // emits "provider/modelId"
  disabled?: boolean;
  id?: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ModelPicker({ value, options, onChange, disabled, id }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ensure current value is always in the list.
  const allOptions = useMemo((): ModelOption[] => {
    const qualified = options.map((o) => `${o.provider}/${o.id}`);
    if (qualified.includes(value)) return options;
    // Derive a fallback entry from the qualified string.
    const parts = value.split("/");
    const modelId = parts[parts.length - 1];
    const provider = parts.length > 1 ? parts.slice(0, -1).join("/") : "unknown";
    return [...options, { id: modelId, name: modelId, provider }];
  }, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [allOptions, query]);

  // Group by provider.
  const grouped = useMemo(() => {
    const groups: Record<string, ModelOption[]> = {};
    for (const m of filtered) {
      (groups[m.provider] ??= []).push(m);
    }
    return Object.entries(groups);
  }, [filtered]);

  // Display label: last segment of the qualified value string.
  const displayLabel = useMemo(() => {
    const parts = value.split("/");
    return parts[parts.length - 1];
  }, [value]);

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
        <span className="truncate max-w-[180px]">{displayLabel}</span>
        <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 w-72 rounded-lg border border-border/60 bg-card shadow-lg shadow-black/20 animate-fade-in">
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
              grouped.map(([provider, models]) => (
                <div key={provider}>
                  <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {capitalize(provider)}
                  </div>
                  {models.map((m) => {
                    const qualified = `${m.provider}/${m.id}`;
                    const selected = qualified === value;
                    return (
                      <button
                        key={qualified}
                        type="button"
                        onClick={() => {
                          onChange(qualified);
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
                        <span className="truncate">{m.name || m.id}</span>
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
