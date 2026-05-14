"use client";

import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import type { SdkContentBlock } from "@/lib/sdk-message";
import type { MessageRow } from "@/lib/runs";

// Render a persisted run message. Supports the run role set
// ('user' | 'agent' | 'tool') in the unified /runs/[id] view; 'system' is
// rendered by `<SystemEventRow>` separately so its layout/grouping can
// differ from chat-style bubbles.
interface Props {
  role: Exclude<MessageRow["role"], "system">;
  content: SdkContentBlock[];
}

export function RunMessage({ role, content }: Props) {
  if (role === "tool") {
    return <ToolResultBlocks blocks={content} />;
  }
  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-2",
        role === "user" ? "justify-end" : "justify-start"
      )}
    >
      {role === "agent" && (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-secondary to-secondary/40 text-foreground/80 ring-1 ring-border/60">
          <Bot className="size-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[80%] min-w-0 space-y-2 rounded-2xl px-4 py-2.5 text-sm",
          role === "user"
            ? "bg-foreground text-background rounded-br-md shadow-md shadow-foreground/5"
            : "bg-card/80 text-foreground rounded-bl-md border border-border/60"
        )}
      >
        {content.map((block, i) => (
          <ContentBlock key={i} block={block} role={role} />
        ))}
      </div>
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
  return null;
}

function ToolUseBlock({ block }: { block: SdkContentBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-background/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Wrench className="size-3" />
        <code className="font-mono text-foreground/90">{block.name}</code>
      </button>
      {open && (
        <pre className="px-2 pb-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-muted-foreground overflow-x-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlocks({ blocks }: { blocks: SdkContentBlock[] }) {
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
        <pre className="mt-1 ml-4 rounded border border-border/60 bg-background/40 p-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">
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
