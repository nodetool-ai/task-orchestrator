"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Edit3,
  FileText,
  FolderSearch,
  FolderTree,
  Globe,
  ListTodo,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canonicalToolName, TOOL_INPUT_KEYS, type CanonicalTool } from "@/lib/builtin-tools";
import type { SdkContentBlock } from "@/lib/sdk-message";

export interface ToolMeta {
  Icon: LucideIcon;
  /** Tailwind text-color class for the icon. */
  color: string;
  /** Tailwind bg/border class pair for the chip background. */
  chip: string;
  /** Human label. Falls back to raw tool name. */
  label?: string;
}

// Keyed by canonical identity (see lib/builtin-tools). getToolMeta resolves a raw
// tool name from either harness — pi's `grep`/`find`/`ls` or Claude's
// `Grep`/`Glob` — to the same entry, so both backends render identically.
const TOOL_META: Record<CanonicalTool, ToolMeta> = {
  Bash: { Icon: Terminal, color: "text-emerald-500", chip: "bg-emerald-500/10 border-emerald-500/20" },
  Read: { Icon: FileText, color: "text-sky-500", chip: "bg-sky-500/10 border-sky-500/20" },
  Write: { Icon: Edit3, color: "text-amber-500", chip: "bg-amber-500/10 border-amber-500/20" },
  Edit: { Icon: Edit3, color: "text-amber-500", chip: "bg-amber-500/10 border-amber-500/20" },
  Grep: { Icon: Search, color: "text-violet-500", chip: "bg-violet-500/10 border-violet-500/20" },
  Glob: { Icon: FolderSearch, color: "text-violet-500", chip: "bg-violet-500/10 border-violet-500/20" },
  LS: { Icon: FolderTree, color: "text-violet-500", chip: "bg-violet-500/10 border-violet-500/20" },
  WebFetch: { Icon: Globe, color: "text-cyan-500", chip: "bg-cyan-500/10 border-cyan-500/20" },
  WebSearch: { Icon: Globe, color: "text-cyan-500", chip: "bg-cyan-500/10 border-cyan-500/20" },
  TodoWrite: { Icon: ListTodo, color: "text-pink-500", chip: "bg-pink-500/10 border-pink-500/20" },
  Task: { Icon: Sparkles, color: "text-state-review", chip: "bg-state-review/10 border-state-review/20" },
};

const FALLBACK: ToolMeta = {
  Icon: Wrench,
  color: "text-muted-foreground",
  chip: "bg-muted/40 border-border/60",
};

export function getToolMeta(name: string | undefined): ToolMeta {
  const canonical = canonicalToolName(name);
  return canonical ? TOOL_META[canonical] : FALLBACK;
}

/** Pull the most informative single line out of a tool's input object. */
export function toolInputPreview(name: string | undefined, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const canonical = canonicalToolName(name);
  const keys = canonical
    ? TOOL_INPUT_KEYS[canonical]
    : ["command", "file_path", "path", "query", "url", "pattern"];
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Coerce a tool_result block's content into a single string. */
export function toolResultText(block: SdkContentBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (p && typeof p === "object") {
          const obj = p as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          return JSON.stringify(obj, null, 2);
        }
        return String(p);
      })
      .join("\n");
  }
  if (c == null) return "";
  return JSON.stringify(c, null, 2);
}

/** Heuristic: is a tool_result block an error response. */
export function isErrorResult(block: SdkContentBlock): boolean {
  const maybe = block as unknown as { is_error?: boolean };
  return maybe.is_error === true;
}

export function StatusDot({ state }: { state: "running" | "ok" | "error" }) {
  if (state === "running") {
    return <Loader2 className="size-3 animate-spin text-muted-foreground" />;
  }
  if (state === "error") {
    return <CircleAlert className="size-3 text-state-blocked" />;
  }
  return <CircleCheck className="size-3 text-state-done/80" />;
}

export { ChevronDown, ChevronRight };
