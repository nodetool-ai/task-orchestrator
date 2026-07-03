"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ui/dialog-provider";
import { ErrorText } from "@/components/ui/error-text";
import { Tooltip } from "@/components/ui/tooltip";
import { describe } from "@/lib/utils";

interface Props {
  endpoint: string;
  redirectTo: string;
  confirmMessage: string;
  label?: string;
  iconOnly?: boolean;
  ariaLabel?: string;
}

export function DeleteButton({
  endpoint,
  redirectTo,
  confirmMessage,
  label = "Delete",
  iconOnly = false,
  ariaLabel,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!(await confirm({ message: confirmMessage, confirmLabel: label, tone: "danger" }))) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, { method: "DELETE" });
        if (!res.ok && res.status !== 204) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        router.push(redirectTo);
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <>
      <Tooltip content={ariaLabel ?? label}>
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          aria-label={ariaLabel ?? label}
          className={
            iconOnly
              ? "inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-state-blocked hover:bg-muted/60 disabled:opacity-50"
              : "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-state-blocked hover:border-state-blocked/60 disabled:opacity-50"
          }
        >
          <Trash2 className="size-3.5" />
          {!iconOnly && <span>{pending ? "Deleting…" : label}</span>}
        </button>
      </Tooltip>
      <ErrorText className="text-[11px]">{error}</ErrorText>
    </>
  );
}
