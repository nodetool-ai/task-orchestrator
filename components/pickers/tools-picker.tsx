"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";

interface Props {
  /** Comma-separated list of profile keys, the storage shape on persona rows. */
  value: string;
  onChange: (next: string) => void;
  className?: string;
}

// Module-level cache so the catalog is fetched once per page.
let catalogCache: string[] | null = null;
let catalogPromise: Promise<string[]> | null = null;
function loadProfiles(): Promise<string[]> {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (catalogPromise) return catalogPromise;
  catalogPromise = fetch("/api/tools-profiles")
    .then((r) => r.json() as Promise<{ profiles: string[] }>)
    .then((b) => {
      catalogCache = b.profiles;
      return catalogCache;
    })
    .catch(() => []);
  return catalogPromise;
}

function parse(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function format(keys: string[]): string {
  // De-dupe while preserving insertion order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out.join(",");
}

/**
 * Multi-select tag picker for tools-profile keys. Each known profile is a
 * toggle-able chip; values not in the catalog still render as chips with a
 * remove (×) so unknown keys aren't silently lost on save.
 */
export function ToolsPicker({ value, onChange, className = "" }: Props) {
  const [catalog, setCatalog] = useState<string[]>(catalogCache ?? []);
  const selected = useMemo(() => parse(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (catalogCache) return;
    let alive = true;
    loadProfiles().then((p) => {
      if (alive) setCatalog(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  function toggle(key: string) {
    const next = selectedSet.has(key)
      ? selected.filter((k) => k !== key)
      : [...selected, key];
    onChange(format(next));
  }

  function remove(key: string) {
    onChange(format(selected.filter((k) => k !== key)));
  }

  // Custom keys are values selected but missing from the catalog.
  const customKeys = selected.filter((k) => !catalog.includes(k));
  const allKeys = [...catalog, ...customKeys];

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {allKeys.map((key) => {
        const isOn = selectedSet.has(key);
        const isCustom = !catalog.includes(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggle(key)}
            className={
              isOn
                ? "inline-flex items-center gap-1 rounded-full border border-foreground/40 bg-foreground/10 px-2 py-0.5 text-xs font-mono text-foreground hover:bg-foreground/15 transition-colors"
                : "inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            }
            title={
              isCustom
                ? `${key} (custom — not in profiles registry)`
                : isOn
                  ? `Remove ${key}`
                  : `Add ${key}`
            }
          >
            {isOn && <Check className="size-3" />}
            <span>{key}</span>
            {isCustom && isOn && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(key);
                }}
                className="-mr-0.5 ml-0.5 inline-flex items-center text-state-blocked/70 hover:text-state-blocked"
              >
                <X className="size-3" />
              </span>
            )}
          </button>
        );
      })}
      {allKeys.length === 0 && (
        <span className="text-xs text-muted-foreground">
          (loading profiles…)
        </span>
      )}
    </div>
  );
}
