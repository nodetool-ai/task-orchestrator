"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  Info,
  MessageSquare,
  Terminal,
  Wallet,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { SdkContentBlock } from "@/lib/sdk-message";
import type { SystemKind } from "@/components/runs/run-view";

interface Props {
  when: Date;
  kind: SystemKind;
  payload: Record<string, unknown>;
  /** Persisted system messages may carry text blocks (assigned at insert
   *  time by `runs.append` with role='system'). We render them inline. */
  content: SdkContentBlock[];
}

// Compact, single-line row variant for runtime/system events. Lives in the
// timeline next to user/assistant bubbles so the user gets a single
// chronological story instead of a separate "activity panel".
export function SystemEventRow({ when, kind, payload, content }: Props) {
  const text = textFromContent(content);
  const { icon, body } = render(kind, payload, text);
  return (
    <div className="flex items-start gap-2 px-4 py-1.5 text-[11px] text-muted-foreground">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">{body}</div>
      <span className="shrink-0 text-[10px] text-muted-foreground/80 tabular-nums">
        {formatDateTime(when)}
      </span>
    </div>
  );
}

function render(
  kind: SystemKind,
  payload: Record<string, unknown>,
  text: string | null
): { icon: React.ReactNode; body: React.ReactNode } {
  switch (kind) {
    case "worktree":
      return {
        icon: <GitBranch className="size-3.5 text-muted-foreground" />,
        body: (
          <span>
            worktree{" "}
            <code className="font-mono text-foreground">
              {String(payload.branch ?? payload.path ?? "")}
            </code>
          </span>
        ),
      };
    case "branch":
      return {
        icon: <GitBranch className="size-3.5 text-muted-foreground" />,
        body: (
          <span>
            branch{" "}
            <code className="font-mono text-foreground">
              {String(payload.branch ?? "")}
            </code>{" "}
            {typeof payload.action === "string" && (
              <span>· {payload.action}</span>
            )}
          </span>
        ),
      };
    case "pr":
      return {
        icon: <GitPullRequest className="size-3.5 text-state-review" />,
        body: (
          <span>
            PR opened:{" "}
            <a
              href={String(payload.url ?? "")}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-muted-foreground hover:decoration-foreground text-foreground"
            >
              {String(payload.url ?? "")}
            </a>
          </span>
        ),
      };
    case "pr_merged":
      return {
        icon: <CheckCircle2 className="size-3.5 text-state-done" />,
        body: (
          <span>
            PR merged{" "}
            {typeof payload.url === "string" && (
              <a
                href={payload.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-muted-foreground hover:decoration-foreground text-foreground"
              >
                {payload.url}
              </a>
            )}
          </span>
        ),
      };
    case "budget":
      return {
        icon: <Wallet className="size-3.5 text-state-progress" />,
        body: (
          <span className="text-state-progress">
            budget warning
            {typeof payload.detail === "string" && <> — {payload.detail}</>}
          </span>
        ),
      };
    case "status": {
      const s = String(payload.status ?? "");
      return {
        icon: <Info className="size-3.5 text-muted-foreground" />,
        body: (
          <span>
            status → <code className="text-foreground">{s}</code>
          </span>
        ),
      };
    }
    case "error":
      return {
        icon: <AlertCircle className="size-3.5 text-state-blocked" />,
        body: (
          <span className="text-state-blocked">
            {text ?? String(payload.error ?? "error")}
          </span>
        ),
      };
    case "shell":
      return {
        icon: <Terminal className="size-3.5 text-muted-foreground" />,
        body: (
          <code className="font-mono text-foreground/90 text-[11px]">
            $ {String(payload.cmd ?? "")}
          </code>
        ),
      };
    case "shell_out": {
      const data = String(payload.data ?? "").trim();
      const isErr = payload.stream === "stderr";
      return {
        icon: (
          <ChevronRight
            className={`size-3.5 ${isErr ? "text-state-blocked" : "text-muted-foreground"}`}
          />
        ),
        body: (
          <pre
            className={`whitespace-pre-wrap font-mono text-[11px] leading-5 ${
              isErr ? "text-state-blocked/80" : "text-muted-foreground"
            }`}
          >
            {data}
          </pre>
        ),
      };
    }
    case "stderr": {
      const data = String(payload.data ?? "").trim();
      return {
        icon: <AlertCircle className="size-3.5 text-state-blocked" />,
        body: (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-state-blocked/80">
            {data}
          </pre>
        ),
      };
    }
    case "warning":
      return {
        icon: <AlertCircle className="size-3.5 text-state-progress" />,
        body: (
          <span className="text-state-progress">
            {text ?? String(payload.message ?? "warning")}
          </span>
        ),
      };
    case "prompt":
      return {
        icon: <MessageSquare className="size-3.5 text-muted-foreground" />,
        body: (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-foreground">prompt</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-muted-foreground text-[11px] leading-5">
              {String(payload.prompt ?? text ?? "")}
            </pre>
          </details>
        ),
      };
    case "resume":
      return {
        icon: <Info className="size-3.5 text-muted-foreground" />,
        body: (
          <span>
            resumed SDK session{" "}
            <code className="font-mono text-foreground">
              {String(payload.sdkSessionId ?? "")}
            </code>
          </span>
        ),
      };
    case "info":
    default:
      return {
        icon: <Info className="size-3.5 text-muted-foreground" />,
        body: <span>{text ?? JSON.stringify(payload)}</span>,
      };
  }
}

function textFromContent(content: SdkContentBlock[]): string | null {
  if (!content || content.length === 0) return null;
  const parts = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length > 0 ? parts.join("\n") : null;
}
