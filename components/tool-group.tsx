"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { humanizeToolName } from "@/lib/builtin-tools";
import { formatDateTime } from "@/lib/utils";
import type { SdkContentBlock } from "@/lib/sdk-message";

export interface ToolInteraction {
  id: string;
  tool: SdkContentBlock;
  results: SdkContentBlock[];
}

/**
 * Collapsible summary for a run of consecutive tool calls. Results stay nested
 * under the call they belong to, so the transcript has one dimmed tool row
 * instead of separate call/result blocks.
 */
export function ToolGroup({
  interactions,
  createdAt,
}: {
  interactions: ToolInteraction[];
  createdAt?: Date;
}) {
  const [open, setOpen] = useState(false);
  const timestamp = createdAt ? formatDateTime(createdAt) : null;
  const label = toolSummary(interactions);

  if (interactions.length === 0) return null;

  return (
    <div
      className="group/tool relative my-1 mx-2 text-xs text-muted-foreground"
      title={timestamp ?? undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/30 hover:text-foreground"
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0" />
        <span className="font-medium">{label}</span>
      </button>
      {timestamp && (
        <span className="pointer-events-none absolute right-2 top-1 z-10 rounded bg-popover px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">
          {timestamp}
        </span>
      )}
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-2">
          {interactions.map((interaction) => (
            <ToolInteractionRow key={interaction.id} interaction={interaction} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolInteractionRow({ interaction }: { interaction: ToolInteraction }) {
  const [open, setOpen] = useState(false);
  const resultCount = interaction.results.length;
  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-muted-foreground hover:bg-muted/30 hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="font-medium text-foreground/80">
          {humanizeToolName(interaction.tool.name)}
        </span>
        {resultCount > 0 && (
          <span className="text-muted-foreground/80">
            {resultCount === 1 ? "result" : `${resultCount} results`}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 pl-6">
          <ToolPayload title="Input" value={interaction.tool.input} />
          {interaction.results.length > 0 && (
            <ToolPayload
              title={interaction.results.length === 1 ? "Result" : "Results"}
              value={formatResults(interaction.results)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ToolPayload({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </div>
      <pre className="max-h-64 overflow-auto rounded bg-muted/30 p-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap">
        {formatValue(value).slice(0, 4000)}
      </pre>
    </div>
  );
}

function toolSummary(interactions: ToolInteraction[]): string {
  const names = interactions.map((i) => humanizeToolName(i.tool.name));
  if (names.length === 1) return `Ran ${names[0]}`;
  return `Ran ${names.length} tool calls: ${summarizeToolNames(names)}`;
}

function summarizeToolNames(names: string[]): string {
  const unique = Array.from(new Set(names));
  const shown = unique.slice(0, 4).join(", ");
  const extra = unique.length - 4;
  return extra > 0 ? `${shown}, +${extra} more` : shown;
}

function formatResults(results: SdkContentBlock[]): string {
  return results.map((r) => formatValue(r.content)).join("\n---\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}
