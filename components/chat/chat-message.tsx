"use client";

import { useState } from "react";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import { humanizeToolName } from "@/lib/builtin-tools";
import type { SdkContentBlock } from "@/lib/sdk-message";
import type { ChatRole } from "@/lib/types";
import { MessageCopyButton } from "@/components/chat/message-copy-button";
import {
  ChevronDown,
  ChevronRight,
  StatusDot,
  getToolMeta,
  isErrorResult,
  toolInputPreview,
  toolResultText,
  truncate,
} from "@/components/chat/tool-meta";

interface Props {
  role: ChatRole;
  content: SdkContentBlock[];
  /** Map of tool_use_id → matching tool_result block (rendered inline under the call). */
  resultByToolId?: Map<string, SdkContentBlock>;
}

function plainText(blocks: SdkContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function ChatMessage({ role, content, resultByToolId }: Props) {
  if (role === "tool_result") {
    return <OrphanToolResults blocks={content} />;
  }

  if (role === "user") {
    return <UserMessage content={content} />;
  }

  return <AssistantMessage content={content} resultByToolId={resultByToolId} />;
}

function UserMessage({ content }: { content: SdkContentBlock[] }) {
  const text = plainText(content);
  return (
    <div className="group flex justify-end gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col items-end gap-1">
        <div className="max-w-[80ch] min-w-0 space-y-2 rounded-2xl rounded-br-sm bg-foreground px-4 py-2.5 text-sm leading-6 text-background">
          {content.map((b, i) =>
            b.type === "text" && typeof b.text === "string" ? (
              <p key={i} className="whitespace-pre-wrap">
                {b.text}
              </p>
            ) : null
          )}
        </div>
        {text && (
          <div className="flex h-6 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageCopyButton text={text} />
          </div>
        )}
      </div>
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
        <User className="size-3.5" />
      </div>
    </div>
  );
}

function AssistantMessage({
  content,
  resultByToolId,
}: {
  content: SdkContentBlock[];
  resultByToolId?: Map<string, SdkContentBlock>;
}) {
  const text = plainText(content);
  return (
    <div className="group flex gap-3 px-4 py-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-foreground">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {content.map((block, i) => {
          if (block.type === "text" && typeof block.text === "string") {
            const html = renderMarkdown(block.text);
            return (
              <div
                key={i}
                className="prose-tasks max-w-none !text-sm leading-6"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }
          if (block.type === "tool_use") {
            const id = (block as { id?: string }).id;
            const paired = id ? resultByToolId?.get(id) : undefined;
            return <ToolCallCard key={i} block={block} result={paired} />;
          }
          return null;
        })}
        {text && (
          <div className="flex h-6 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageCopyButton text={text} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ToolCallCard({
  block,
  result,
}: {
  block: SdkContentBlock;
  result: SdkContentBlock | undefined;
}) {
  const [open, setOpen] = useState(false);
  const meta = getToolMeta(block.name);
  const preview = toolInputPreview(block.name, block.input);
  const status: "running" | "ok" | "error" = !result
    ? "running"
    : isErrorResult(result)
    ? "error"
    : "ok";
  const resultText = result ? toolResultText(result) : "";
  const isLongResult = resultText.length > 480 || resultText.split("\n").length > 6;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border text-xs transition-colors",
        meta.chip,
        status === "error" && "border-state-blocked/40 bg-state-blocked/5"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <meta.Icon className={cn("size-3.5 shrink-0", meta.color)} />
        <span className="shrink-0 text-[11px] font-semibold text-foreground">
          {humanizeToolName(block.name)}
        </span>
        {preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {preview}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2">
          <StatusDot state={status} />
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-current/10 bg-background/40 px-2.5 py-2">
          <ToolInputView name={block.name} input={block.input} />
          {result && (
            <ToolResultView text={resultText} error={status === "error"} long={isLongResult} />
          )}
        </div>
      )}

      {!open && result && status === "error" && (
        <div className="border-t border-state-blocked/20 bg-state-blocked/5 px-2.5 py-1.5">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-state-blocked/90">
            {truncate(resultText, 280)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ToolInputView({ name, input }: { name: string | undefined; input: unknown }) {
  if (name === "Bash" && input && typeof input === "object") {
    const obj = input as { command?: string; description?: string };
    return (
      <div className="space-y-1">
        {obj.description && (
          <p className="text-[11px] text-muted-foreground">{obj.description}</p>
        )}
        {obj.command && (
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-background/80 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-foreground">
            <span className="select-none text-muted-foreground/70">$ </span>
            {obj.command}
          </pre>
        )}
      </div>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-foreground/90">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function ToolResultView({
  text,
  error,
  long,
}: {
  text: string;
  error: boolean;
  long: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll || !long ? text : truncate(text, 1200);
  const hidden = text.length - shown.length;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className={cn(error ? "text-state-blocked" : "text-muted-foreground")}>
          {error ? "error" : "result"}
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span>{text.length.toLocaleString()} chars</span>
      </div>
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap",
          error
            ? "border-state-blocked/30 bg-state-blocked/5 text-state-blocked/90"
            : "border-border/60 bg-background/80 text-foreground/90"
        )}
      >
        {shown || <span className="text-muted-foreground/60">(empty)</span>}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {showAll ? "show less" : `show ${hidden.toLocaleString()} more chars`}
        </button>
      )}
    </div>
  );
}

/** Renders tool_result rows that weren't paired with a call in this conversation. */
function OrphanToolResults({ blocks }: { blocks: SdkContentBlock[] }) {
  const [open, setOpen] = useState(false);
  const joined = blocks.map((b) => toolResultText(b)).join("\n---\n");
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        tool result{blocks.length > 1 ? `s (${blocks.length})` : ""}
      </button>
      {open && (
        <pre className="ml-4 mt-1 max-h-64 overflow-auto rounded border border-border/60 bg-background/40 p-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap">
          {truncate(joined, 4000)}
        </pre>
      )}
    </div>
  );
}
