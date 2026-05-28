"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, pending]);

  const openConfirm = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    setConfirming(true);
  };

  const cancel = () => {
    if (pending) return;
    setError(null);
    setConfirming(false);
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setConfirming(false);
      router.push(redirectTo);
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={openConfirm}
        disabled={pending}
        aria-label={ariaLabel ?? label}
        title={ariaLabel ?? label}
        className={
          iconOnly
            ? "inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-state-blocked hover:bg-muted/60 disabled:opacity-50"
            : "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-state-blocked hover:border-state-blocked/60 disabled:opacity-50"
        }
      >
        <Trash2 className="size-3.5" />
        {!iconOnly && <span>{pending ? "Deleting…" : label}</span>}
      </button>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={cancel}
          className="fixed inset-0 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-fade-in"
          style={{ zIndex: 100 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
          >
            <p className="text-sm text-foreground">{confirmMessage}</p>
            {error && <p className="mt-2 text-[11px] text-state-blocked">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={pending}
                className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md bg-state-blocked px-3 py-1.5 text-xs font-medium text-white hover:bg-state-blocked/90 disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                {pending ? "Deleting…" : label}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
