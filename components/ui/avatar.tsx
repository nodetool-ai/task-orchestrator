import * as React from "react";
import { Bot, User } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const avatarVariants = cva(
  "mt-0.5 flex shrink-0 items-center justify-center rounded-full text-foreground",
  {
    variants: {
      variant: {
        user: "bg-secondary",
        assistant: "border border-border/60 bg-card",
      },
      size: {
        sm: "size-6",
        md: "size-7",
      },
    },
    defaultVariants: {
      variant: "assistant",
      size: "md",
    },
  }
);

export interface AvatarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof avatarVariants> {}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ variant = "assistant", size = "md", className, ...props }, ref) => {
    const Icon = variant === "user" ? User : Bot;
    return (
      <div
        ref={ref}
        className={cn(avatarVariants({ variant, size }), className)}
        aria-label={variant === "user" ? "User" : "Assistant"}
        {...props}
      >
        <Icon aria-hidden className={cn(size === "sm" ? "size-3" : "size-3.5")} />
      </div>
    );
  }
);
Avatar.displayName = "Avatar";
