import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  action?: React.ReactNode;
  headerClassName?: string;
  titleClassName?: string;
}

export const PageSection = React.forwardRef<HTMLElement, PageSectionProps>(
  ({ title, action, className, headerClassName, titleClassName, children, ...props }, ref) => (
    <section ref={ref} className={cn("mt-10 space-y-3", className)} {...props}>
      {(title || action) && (
        <div className={cn("flex items-baseline justify-between gap-3", headerClassName)}>
          {title && (
            <h2 className={cn("text-sm font-semibold tracking-tight", titleClassName)}>
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  )
);
PageSection.displayName = "PageSection";
