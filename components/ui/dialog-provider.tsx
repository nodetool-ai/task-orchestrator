"use client";

import * as React from "react";

type ConfirmOptions = {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
};

type PromptOptions = {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type ConfirmRequest = {
  kind: "confirm";
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
};

type PromptRequest = {
  kind: "prompt";
  opts: PromptOptions;
  resolve: (value: string | null) => void;
};

type DialogRequest = ConfirmRequest | PromptRequest;

type DialogApi = {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
};

const DialogContext = React.createContext<DialogApi | null>(null);

function settle(req: DialogRequest, accepted: boolean, value: string) {
  if (req.kind === "confirm") req.resolve(accepted);
  else req.resolve(accepted ? value : null);
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = React.useState<DialogRequest | null>(null);
  const activeRef = React.useRef<DialogRequest | null>(null);
  activeRef.current = req;

  const open = React.useCallback((next: DialogRequest) => {
    // A new dialog supersedes any unanswered one — resolve it as dismissed
    // so its awaiting caller doesn't hang forever.
    if (activeRef.current) settle(activeRef.current, false, "");
    setReq(next);
  }, []);

  const api = React.useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          const normalized = typeof opts === "string" ? { message: opts } : opts;
          open({ kind: "confirm", opts: normalized, resolve });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          open({ kind: "prompt", opts, resolve });
        }),
    }),
    [open]
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && <DialogHost req={req} onClose={() => setReq(null)} />}
    </DialogContext.Provider>
  );
}

function DialogHost({ req, onClose }: { req: DialogRequest; onClose: () => void }) {
  const isPrompt = req.kind === "prompt";
  const [value, setValue] = React.useState(
    req.kind === "prompt" ? req.opts.initialValue ?? "" : ""
  );
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isPrompt) inputRef.current?.focus();
  }, [isPrompt]);

  const finish = React.useCallback(
    (accepted: boolean, v: string) => {
      settle(req, accepted, v);
      onClose();
    },
    [req, onClose]
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false, "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  const tone = req.kind === "confirm" ? req.opts.tone ?? "default" : "default";
  const confirmLabel = req.opts.confirmLabel ?? (req.kind === "prompt" ? "OK" : "Confirm");
  const cancelLabel = req.opts.cancelLabel ?? "Cancel";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => finish(false, "")}
      className="fixed inset-0 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-fade-in"
      style={{ zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        {req.kind === "confirm" ? (
          <p className="text-sm text-foreground">{req.opts.message}</p>
        ) : (
          <>
            <label className="block text-sm text-foreground">{req.opts.title}</label>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finish(true, value);
                }
              }}
              placeholder={req.opts.placeholder}
              className="mt-2 w-full rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40"
            />
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => finish(false, "")}
            className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => finish(true, value)}
            className={
              tone === "danger"
                ? "rounded-md bg-state-blocked px-3 py-1.5 text-xs font-medium text-white hover:bg-state-blocked/90"
                : "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useConfirm() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("useConfirm must be used within a DialogProvider");
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("usePrompt must be used within a DialogProvider");
  return ctx.prompt;
}
