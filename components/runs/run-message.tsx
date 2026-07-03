"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { humanizeToolName } from "@/lib/builtin-tools";
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
}

export function RunMessage({ role, content }: Props) {
  if (role === "tool") {
    return <ToolResultBlocks blocks={content} />;
  }
  if (role === "agent") {
    return (
      <div className="px-4 py-3 text-sm text-foreground space-y-2">
        {content.map((block, i) => (
          <ContentBlock key={i} block={block} role={role} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="max-w-[80%] min-w-0 space-y-2 rounded-2xl rounded-br-md bg-foreground text-background px-4 py-2.5 text-sm shadow-md shadow-foreground/5">
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

export function ToolUseBlock({ block }: { block: SdkContentBlock }) {
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
        <span className="text-foreground/90">{humanizeToolName(block.name)}</span>
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
