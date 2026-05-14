"use client";

export interface RepositoryOption {
  id: string;
  name: string;
}

interface Props {
  repositories: RepositoryOption[];
  value: string;
  onChange: (id: string) => void;
  /** Label for the empty-value option. Pass `null` to omit it. Default "No repo". */
  emptyLabel?: string | null;
  /** When true, render as `name (id)`. Default false. */
  showId?: boolean;
  size?: "default" | "compact";
  className?: string;
  disabled?: boolean;
  title?: string;
  id?: string;
  autoFocus?: boolean;
}

/**
 * Single dropdown for repository selection. Used by chat composer, task
 * forms, run modals, and the per-chat header. Same comma-separated
 * id-string contract every callsite already speaks.
 */
export function RepositoryPicker({
  repositories,
  value,
  onChange,
  emptyLabel = "No repo",
  showId = false,
  size = "default",
  className,
  disabled = false,
  title,
  id,
  autoFocus,
}: Props) {
  const cls =
    className ??
    (size === "compact"
      ? "rounded-sm border border-border/60 bg-background px-2 py-0.5 text-xs outline-none focus:border-foreground/40 disabled:opacity-50"
      : "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors disabled:opacity-50");

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      disabled={disabled}
      title={title ?? "Repository"}
      autoFocus={autoFocus}
    >
      {emptyLabel !== null && <option value="">{emptyLabel}</option>}
      {repositories.map((r) => (
        <option key={r.id} value={r.id}>
          {showId ? `${r.name} (${r.id})` : r.name}
        </option>
      ))}
    </select>
  );
}
