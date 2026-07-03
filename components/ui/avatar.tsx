import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface AvatarProps {
  variant: "user" | "assistant";
  className?: string;
}

export function Avatar({ variant, className }: AvatarProps) {
  const Icon = variant === "user" ? User : Bot;
  return (
    <div
      className={cn(
        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-foreground",
        variant === "user" ? "bg-secondary" : "border border-border/60 bg-card",
        className
      )}
      aria-label={variant === "user" ? "User" : "Assistant"}
    >
      <Icon aria-hidden className="size-3.5" />
    </div>
  );
}
