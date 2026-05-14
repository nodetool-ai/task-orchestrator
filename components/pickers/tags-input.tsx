"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Suggestions to autocomplete via a datalist. */
  suggestions?: string[];
  className?: string;
  size?: "default" | "compact";
}

/**
 * Free-form tag input. Type, press Enter or comma to add. Each tag is a
 * chip with a × to remove. Optional `suggestions` populate a <datalist>
 * for autocomplete.
 */
export function TagsInput({
  value,
  onChange,
  placeholder = "add tag…",
  suggestions,
  className = "",
  size = "default",
}: Props) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tags = raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .filter((t) => !value.includes(t));
    if (tags.length === 0) return;
    onChange([...value, ...tags]);
    setDraft("");
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1]);
    }
  }

  const inputCls =
    size === "compact"
      ? "flex-1 min-w-[6rem] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      : "flex-1 min-w-[8rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground";

  const wrapCls =
    size === "compact"
      ? `flex flex-wrap items-center gap-1 rounded-sm border border-border/60 bg-background px-1.5 py-0.5 focus-within:border-foreground/40 ${className}`
      : `flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1.5 focus-within:border-foreground/40 focus-within:ring-2 focus-within:ring-foreground/10 transition-colors ${className}`;

  const reactId = useId();
  const listId =
    suggestions && suggestions.length > 0
      ? `tags-suggestions-${reactId}`
      : undefined;

  return (
    <div className={wrapCls}>
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-secondary/40 pl-2 pr-1 py-0.5 text-xs"
        >
          {tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            aria-label={`Remove ${tag}`}
            className="inline-flex items-center text-muted-foreground hover:text-state-blocked"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft && commit(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        list={listId}
        className={inputCls}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

