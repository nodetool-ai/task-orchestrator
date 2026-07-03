import { cn } from "@/lib/utils";

interface TypingDotsProps {
  className?: string;
  dotClassName?: string;
  label?: string;
}

export function TypingDots({ className, dotClassName, label = "Thinking" }: TypingDotsProps) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-label={label}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-foreground/60 animate-pulse", dotClassName)} />
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:120ms]",
          dotClassName
        )}
      />
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:240ms]",
          dotClassName
        )}
      />
    </span>
  );
}
