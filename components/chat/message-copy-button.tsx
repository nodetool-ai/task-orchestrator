"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

interface Props {
  text: string;
  className?: string;
}

export function MessageCopyButton({ text, className }: Props) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  return (
    <Tooltip content="Copy to clipboard">
      <button
        type="button"
        onClick={copy}
        disabled={copied}
        aria-label="Copy to clipboard"
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/60 disabled:opacity-80",
          className
        )}
      >
        {copied ? (
          <Check className="size-3 text-state-done" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
    </Tooltip>
  );
}
