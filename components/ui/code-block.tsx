import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const codeBlockVariants = cva(
  "whitespace-pre-wrap rounded-md border px-3 py-2 font-mono text-[11px] leading-5",
  {
    variants: {
      tone: {
        default: "border-border/60 bg-background/80 text-foreground/90",
        muted: "border-border/60 bg-card/40 text-muted-foreground",
        error: "border-state-blocked/40 bg-state-blocked/10 text-state-blocked/90",
      },
      selectable: {
        true: "select-all",
        false: "",
      },
    },
    defaultVariants: {
      tone: "default",
      selectable: false,
    },
  }
);

export interface CodeBlockProps
  extends React.HTMLAttributes<HTMLPreElement>,
    VariantProps<typeof codeBlockVariants> {}

export const CodeBlock = React.forwardRef<HTMLPreElement, CodeBlockProps>(
  ({ className, tone, selectable, ...props }, ref) => (
    <pre
      ref={ref}
      className={cn(codeBlockVariants({ tone, selectable }), className)}
      {...props}
    />
  )
);
CodeBlock.displayName = "CodeBlock";
