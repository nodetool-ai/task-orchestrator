"use client";

import { Select } from "@/components/ui/select";

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

interface Props {
  /** null = "—" (unset). */
  value: ThinkingLevel | null;
  onChange: (next: ThinkingLevel | null) => void;
  /** Merged over the base Select styling. */
  className?: string;
  id?: string;
}

export function ThinkingLevelPicker({ value, onChange, className, id }: Props) {
  return (
    <Select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as ThinkingLevel | null)}
      className={className ?? "w-full"}
    >
      <option value="">—</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="xhigh">xhigh</option>
    </Select>
  );
}
