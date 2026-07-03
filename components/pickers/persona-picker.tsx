"use client";

import { Select } from "@/components/ui/select";

export interface PersonaOption {
  id: string;
  name: string;
}

interface Props {
  personas: PersonaOption[];
  value: string;
  onChange: (id: string) => void;
  /** Optional override merged over the base Select styling. */
  className?: string;
  /** Render compact (small text, slim padding) for inline composer use. */
  size?: "default" | "compact";
  title?: string;
}

/**
 * Single dropdown that lists personas by name. Used by
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
  return (
    <Select
      uiSize={size === "compact" ? "xs" : "md"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? (size === "default" ? "w-full" : undefined)}
      title={title ?? "Persona"}
    >
      {personas.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}
