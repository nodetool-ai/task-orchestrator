"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

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

  const tone = req.kind === "confirm" ? req.opts.tone ?? "default" : "default";
  const confirmLabel = req.opts.confirmLabel ?? (req.kind === "prompt" ? "OK" : "Confirm");
  const cancelLabel = req.opts.cancelLabel ?? "Cancel";

  return (
    <Modal
      onClose={() => finish(false, "")}
      veilClassName="z-[100]"
      className="max-w-sm p-5"
    >
      <>
        {req.kind === "confirm" ? (
          <p className="text-sm text-foreground">{req.opts.message}</p>
        ) : (
          <>
            <label className="block text-sm text-foreground">{req.opts.title}</label>
            <Input
              ref={inputRef}
              uiSize="sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finish(true, value);
                }
              }}
              placeholder={req.opts.placeholder}
              className="mt-2 rounded-md bg-background/60 px-2.5 text-sm"
            />
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => finish(false, "")}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => finish(true, value)}
          >
            {confirmLabel}
          </Button>
        </div>
      </>
    </Modal>
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
