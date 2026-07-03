import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const chipVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default:
          "border-border/60 bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        selected:
          "border-foreground/40 bg-foreground/10 text-foreground hover:bg-foreground/15",
        danger:
          "border-state-blocked/30 bg-state-blocked/5 text-state-blocked hover:bg-state-blocked/10",
        dangerSelected:
          "border-state-blocked/40 bg-state-blocked/80 text-background hover:bg-state-blocked",
      },
      mono: {
        true: "font-mono text-[11px] font-normal",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      mono: false,
    },
  }
);

type ChipTone = "neutral" | "danger";

type LegacyChipProps = {
  selected?: boolean;
  tone?: ChipTone;
};

function variantFromLegacy(
  variant: VariantProps<typeof chipVariants>["variant"],
  selected?: boolean,
  tone: ChipTone = "neutral"
) {
  if (variant) return variant;
  if (tone === "danger") return selected ? "dangerSelected" : "danger";
  return selected ? "selected" : "default";
}

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants>,
    LegacyChipProps {}

export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, variant, selected, tone, mono, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        chipVariants({ variant: variantFromLegacy(variant, selected, tone), mono }),
        className
      )}
      {...props}
    />
  )
);
Chip.displayName = "Chip";

export interface ChipButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof chipVariants>,
    LegacyChipProps {}

export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ className, variant, selected, tone, mono, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        chipVariants({ variant: variantFromLegacy(variant, selected, tone), mono }),
        className
      )}
      {...props}
    />
  )
);
ChipButton.displayName = "ChipButton";
