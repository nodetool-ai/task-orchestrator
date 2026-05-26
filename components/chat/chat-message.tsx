"use client";

import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import type { SdkContentBlock } from "@/lib/sdk-message";
import type { ChatRole } from "@/lib/types";
import { MessageCopyButton } from "@/components/chat/message-copy-button";

interface Props {
  role: ChatRole;
  content: SdkContentBlock[];
}

function plainText(blocks: SdkContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function ChatMessage({ role, content }: Props) {
  if (role === "tool_result") {
    return <ToolResultBlocks blocks={content} />;
  }

  const text = plainText(content);
  const hasText = text.length > 0;

  return (
    <div
      className={cn(
        "group flex gap-3 px-4 py-4",
        role === "user" ? "justify-end" : "justify-start"
      )}
    >
      {role === "assistant" && (
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-foreground">
          <Bot className="size-3.5" />
        </div>
      )}
      <div className={cn("flex min-w-0 flex-col gap-1", role === "user" ? "items-end" : "items-start")}>
        <div
          className={cn(
            "max-w-[80ch] min-w-0 space-y-2 rounded-2xl px-4 py-2.5 text-sm",
            role === "user"
              ? "bg-foreground text-background rounded-br-sm"
              : "bg-secondary/60 text-foreground rounded-bl-sm"
          )}
        >
          {content.map((block, i) => (
            <ContentBlock key={i} block={block} role={role} />
          ))}
        </div>
        {hasText && (
          <div className="flex h-6 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageCopyButton text={text} />
          </div>
        )}
      </div>
      {role === "user" && (
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
          <User className="size-3.5" />
        </div>
      )}
    </div>
  );
}

function ContentBlock({ block, role }: { block: SdkContentBlock; role: ChatRole }) {
  if (block.type === "text" && typeof block.text === "string") {
    if (role === "user") {
      return <p className="whitespace-pre-wrap leading-6">{block.text}</p>;
    }
    const html = renderMarkdown(block.text);
    return <div className="prose-tasks !text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock block={block} />;
  }
  return null;
}

function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "query", "url", "pattern"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 80 ? v.slice(0, 77) + "…" : v;
    }
  }
  return null;
}

function ToolUseBlock({ block }: { block: SdkContentBlock }) {
  const [open, setOpen] = useState(false);
  const preview = summarizeToolInput(block.input);
  return (
    <div className="rounded-md border border-border/60 bg-background/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Wrench className="size-3 shrink-0" />
        <code className="font-mono text-foreground/90">{block.name}</code>
        {preview && !open && (
          <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
            {preview}
          </span>
        )}
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap px-2 pb-2 font-mono text-[11px] leading-5 text-muted-foreground">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlocks({ blocks }: { blocks: SdkContentBlock[] }) {
  const [open, setOpen] = useState(false);
  const joined = blocks
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2)))
    .join("\n---\n");
  const truncated = joined.slice(0, 4000);
  return (
    <div className="px-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        tool result{blocks.length > 1 ? `s (${blocks.length})` : ""}
      </button>
      {open && (
        <pre className="ml-4 mt-1 max-h-64 overflow-y-auto rounded border border-border/60 bg-background/40 p-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap">
          {truncated}
        </pre>
      )}
    </div>
  );
}
