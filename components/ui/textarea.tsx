import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Same field recipe as Input. `mono` is the prompt-editor treatment from
// DESIGN.md §5: the value will be sent to the agent as a literal string.
const textareaVariants = cva(
  "w-full border bg-background text-foreground placeholder:text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
  {
    variants: {
      uiSize: {
        md: "rounded-md border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/40",
        sm: "rounded-sm border-border/60 px-2 py-1.5 text-xs outline-none focus:border-foreground/40",
      },
      mono: {
        true: "font-mono text-[11px] leading-relaxed text-foreground/90",
        false: "",
      },
    },
    defaultVariants: { uiSize: "md", mono: false },
  }
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, uiSize, mono, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaVariants({ uiSize, mono }), className)}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export { textareaVariants };
