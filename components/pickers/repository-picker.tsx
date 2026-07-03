"use client";

import { Select } from "@/components/ui/select";

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
  return (
    <Select
      id={id}
      uiSize={size === "compact" ? "xs" : "md"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? (size === "default" ? "w-full" : undefined)}
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
    </Select>
  );
}
