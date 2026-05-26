"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatComposerHandle {
  focus: () => void;
  setValue: (next: string) => void;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  sending: boolean;
  placeholder?: string;
  hint?: React.ReactNode;
  /** Slot above the input row (banners, status, suggestions). */
  header?: React.ReactNode;
}

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  { value, onChange, onSubmit, onStop, sending, placeholder, hint, header },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (next: string) => {
      onChange(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  }));

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  }

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !sending;

  return (
    <div className="border-t border-border/60 bg-background/80 backdrop-blur px-4 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        {header}
        <div
          className={cn(
            "group relative flex flex-col rounded-2xl border border-border/60 bg-card/60 shadow-sm transition-colors",
            "focus-within:border-foreground/30 focus-within:bg-card/80"
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? "Ask anything…"}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none max-h-60"
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
            <div className="flex items-center gap-1 pl-1.5 text-[10px] text-muted-foreground">
              <kbd className="rounded border border-border/60 bg-background/60 px-1 py-px font-mono text-[10px]">
                ⏎
              </kbd>
              <span>to send</span>
              <span className="px-1 opacity-50">·</span>
              <kbd className="rounded border border-border/60 bg-background/60 px-1 py-px font-mono text-[10px]">
                ⇧⏎
              </kbd>
              <span>for newline</span>
            </div>
            {sending ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-1.5 rounded-full bg-state-blocked/80 px-3 py-1.5 text-[11px] font-medium text-background transition-colors hover:bg-state-blocked"
                aria-label="Stop generation"
              >
                <Square className="size-3 fill-current" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSend}
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-full transition-all",
                  canSend
                    ? "bg-foreground text-background hover:bg-foreground/90 shadow-sm scale-100"
                    : "bg-muted text-muted-foreground/60 scale-95"
                )}
                aria-label="Send message"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </button>
            )}
          </div>
        </div>
        {hint && (
          <p className="text-center text-[10px] text-muted-foreground/80">{hint}</p>
        )}
      </div>
    </div>
  );
});
