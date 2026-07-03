import * as React from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function ComposerInputShell({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-end gap-2 rounded-2xl border border-border/60 bg-card/40 px-3 py-2 transition-colors focus-within:border-foreground/30",
        className
      )}
      {...props}
    />
  );
}

export const ComposerTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={1}
    className={cn(
      "max-h-48 flex-1 resize-none bg-transparent py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
ComposerTextarea.displayName = "ComposerTextarea";

interface ComposerSendButtonProps {
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  className?: string;
}

export function ComposerSendButton({
  pending = false,
  disabled,
  onClick,
  ariaLabel = "Send",
  className,
}: ComposerSendButtonProps) {
  return (
    <Button
      size="icon"
      onClick={onClick}
      disabled={disabled || pending}
      aria-label={ariaLabel}
      className={className}
    >
      {pending ? <Spinner className="size-4" /> : <ArrowUp className="size-4" />}
    </Button>
  );
}
