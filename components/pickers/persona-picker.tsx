"use client";

export interface PersonaOption {
  id: string;
  name: string;
  modelProvider: string;
  modelId: string;
}

interface Props {
  personas: PersonaOption[];
  value: string;
  onChange: (id: string) => void;
  /** Optional override for the bare-bones default styling. */
  className?: string;
  /** Render compact (small text, slim padding) for inline composer use. */
  size?: "default" | "compact";
  title?: string;
}

/**
 * Single dropdown that lists personas as `Name — provider/model`. Used by
 * the chat composer, the task chat box, the new-task form, and the
 * implement-run modal.
 */
export function PersonaPicker({
  personas,
  value,
  onChange,
  className,
  size = "default",
  title,
}: Props) {
  if (personas.length === 0) return null;
  const cls =
    className ??
    (size === "compact"
      ? "rounded-sm border border-border/60 bg-background px-2 py-0.5 text-xs outline-none focus:border-foreground/40"
      : "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors");
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      title={title ?? "Persona"}
    >
      {personas.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {p.modelProvider}/{p.modelId}
        </option>
      ))}
    </select>
  );
}
