"use client";

import { FolderClosed, FolderGit2, GitBranch } from "lucide-react";

export type CwdStrategy = "worktree" | "repo" | "none";

interface Props {
  value: CwdStrategy;
  onChange: (next: CwdStrategy) => void;
  className?: string;
}

const STRATEGIES: Array<{
  value: CwdStrategy;
  label: string;
  desc: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: "worktree",
    label: "Worktree",
    desc: "Fresh git worktree on a new branch",
    Icon: GitBranch,
  },
  {
    value: "repo",
    label: "Repo",
    desc: "Run in the repo's main checkout",
    Icon: FolderGit2,
  },
  {
    value: "none",
    label: "None",
    desc: "No checkout — just chat",
    Icon: FolderClosed,
  },
];

/**
 * Three-way segmented picker for the cwd strategy of a run. Renders as
 * pill-style toggles since the choice space is tiny and labels add value.
 */
export function CwdStrategyPicker({
  value,
  onChange,
  className = "",
}: Props) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-md border border-border/60 bg-background p-0.5 ${className}`}
    >
      {STRATEGIES.map(({ value: v, label, desc, Icon }) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            title={desc}
            className={
              on
                ? "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium bg-foreground text-background"
                : "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }
          >
            <Icon className="size-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
