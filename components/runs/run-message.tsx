"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { humanizeToolName } from "@/lib/builtin-tools";
import { formatDateTime } from "@/lib/utils";
import type { SdkContentBlock } from "@/lib/sdk-message";
import type { MessageRow } from "@/lib/runs";

// Render a persisted run message. Supports the run role set
// ('user' | 'agent' | 'tool') in the unified /runs/[id] view; 'system' is
// rendered by `<SystemEventRow>` separately.
//
// User messages live in a high-contrast pill on the right. Agent
// messages are bare prose on the canvas — no avatar, no bubble — so
// markdown reads like a document.
interface Props {
  role: Exclude<MessageRow["role"], "system">;
  content: SdkContentBlock[];
  createdAt?: Date;
}

export function RunMessage({ role, content, createdAt }: Props) {
  const timestamp = createdAt ? formatDateTime(createdAt) : null;
  if (role === "tool") {
    return (
      <HoverTimestamp align="left" timestamp={timestamp}>
        <ToolResultBlocks blocks={content} />
      </HoverTimestamp>
    );
  }
  if (role === "agent") {
    return (
      <HoverTimestamp align="right" timestamp={timestamp}>
        <div className="px-4 py-1.5 text-sm text-foreground space-y-2">
          {content.map((block, i) => (
            <ContentBlock key={i} block={block} role={role} />
          ))}
        </div>
      </HoverTimestamp>
    );
  }
  return (
    <HoverTimestamp align="left" timestamp={timestamp}>
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[80%] min-w-0 space-y-2 rounded-2xl rounded-br-md bg-foreground text-background px-4 py-2.5 text-sm shadow-md shadow-foreground/5">
          {content.map((block, i) => (
            <ContentBlock key={i} block={block} role={role} />
          ))}
        </div>
      </div>
    </HoverTimestamp>
  );
}

function HoverTimestamp({
  align,
  timestamp,
  children,
}: {
  align: "left" | "right";
  timestamp: string | null;
  children: ReactNode;
}) {
  if (!timestamp) return <>{children}</>;
  return (
    <div className="group/message relative" title={timestamp}>
      {children}
      <span
        className={
          "pointer-events-none absolute top-1 z-10 rounded border border-border/70 bg-popover px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 " +
          (align === "left" ? "left-4" : "right-4")
        }
      >
        {timestamp}
      </span>
    </div>
  );
}

function ContentBlock({
  block,
  role,
}: {
  block: SdkContentBlock;
  role: "user" | "agent";
}) {
  if (block.type === "text" && typeof block.text === "string") {
    if (role === "user") {
      return <p className="whitespace-pre-wrap leading-6">{block.text}</p>;
    }
    const html = renderMarkdown(block.text);
    return (
      <div
        className="prose-tasks !text-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock block={block} />;
  }
  if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`data:${block.mimeType};base64,${block.data}`}
        alt=""
        className="max-h-80 max-w-full rounded-md border border-border/60 object-contain"
      />
    );
  }
  return null;
}

export function ToolUseBlock({ block }: { block: SdkContentBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-muted/30 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Wrench className="size-3" />
        <span className="text-foreground/90">{humanizeToolName(block.name)}</span>
      </button>
      {open && (
        <pre className="mx-2 mb-2 rounded bg-muted/30 p-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-muted-foreground overflow-x-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ToolResultBlocks({ blocks }: { blocks: SdkContentBlock[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        tool result{blocks.length > 1 ? `s (${blocks.length})` : ""}
      </button>
      {open && (
        <pre className="mt-1 ml-4 rounded bg-muted/30 p-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">
          {blocks
            .map((b) =>
              typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content, null, 2)
            )
            .join("\n---\n")
            .slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}
