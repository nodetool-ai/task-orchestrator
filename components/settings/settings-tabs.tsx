"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "repos", label: "Repositories" },
  { id: "personas", label: "Personas" },
  { id: "environments", label: "Environments" },
  { id: "tokens", label: "API tokens" },
  { id: "codex", label: "Codex" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string | undefined): value is TabId {
  return TABS.some((t) => t.id === value);
}

export function SettingsTabs({
  initialTab,
  repos,
  personas,
  environments,
  tokens,
  codex,
}: {
  initialTab?: string;
  repos: React.ReactNode;
  personas: React.ReactNode;
  environments: React.ReactNode;
  tokens: React.ReactNode;
  codex: React.ReactNode;
}) {
  const router = useRouter();
  const [active, setActive] = React.useState<TabId>(isTabId(initialTab) ? initialTab : "repos");

  function select(id: TabId) {
    setActive(id);
    router.replace(`/settings?tab=${id}`, { scroll: false });
  }

  const content: Record<TabId, React.ReactNode> = { repos, personas, environments, tokens, codex };

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Settings"
        className="inline-flex rounded-md border border-border/60 bg-secondary/40 p-0.5 text-xs"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => select(t.id)}
            className={cn(
              "rounded px-3 py-1.5 font-medium transition-colors",
              active === t.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{content[active]}</div>
    </div>
  );
}
