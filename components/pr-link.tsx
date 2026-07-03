import { GitPullRequest } from "lucide-react";
import { cn, prNumberLabel, prShortLabel } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

interface PrLinkProps {
  url: string;
  label?: "short" | "number" | "none";
  variant?: "inline" | "badge";
  className?: string;
  iconClassName?: string;
  external?: boolean;
}

export function PrLink({
  url,
  label = "short",
  variant = "inline",
  className,
  iconClassName,
  external = false,
}: PrLinkProps) {
  const text = label === "number" ? prNumberLabel(url) : label === "short" ? prShortLabel(url) : null;

  return (
    <Tooltip content={prShortLabel(url)} className="relative z-10">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "inline-flex items-center gap-1 transition-colors",
          variant === "badge"
            ? "rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-xs hover:bg-secondary"
            : "text-[11px] text-muted-foreground hover:text-foreground",
          className
        )}
      >
        <GitPullRequest className={cn("size-3.5 text-state-review", iconClassName)} />
        {text && <span className="font-mono text-current">{text}</span>}
        {external && <span className="text-muted-foreground">↗</span>}
      </a>
    </Tooltip>
  );
}
