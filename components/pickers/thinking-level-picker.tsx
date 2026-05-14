"use client";

export type ThinkingLevel = "low" | "medium" | "high";

interface Props {
  /** null = "—" (unset). */
  value: ThinkingLevel | null;
  onChange: (next: ThinkingLevel | null) => void;
  className?: string;
  id?: string;
}

const DEFAULT_CLASS =
  "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors";

export function ThinkingLevelPicker({
  value,
  onChange,
  className = DEFAULT_CLASS,
  id,
}: Props) {
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as ThinkingLevel | null)}
      className={className}
    >
      <option value="">—</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
    </select>
  );
}
