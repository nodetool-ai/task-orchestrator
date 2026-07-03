"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import type { AttachmentMeta } from "@/lib/types";
import { cn, describe, formatBytes, relativeDate } from "@/lib/utils";
import { ErrorText } from "@/components/ui/error-text";

interface Props {
  scope: "task" | "plan";
  ownerId: string;
  attachments: AttachmentMeta[];
}

export function Attachments({ scope, ownerId, attachments }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const uploadBase = `/api/${scope === "task" ? "tasks" : "plans"}/${ownerId}/attachments`;

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    startTransition(async () => {
      try {
        for (const file of list) {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch(uploadBase, { method: "POST", body: form });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setError(body.error ?? `Upload failed (HTTP ${res.status})`);
            break;
          }
        }
      } catch (err) {
        setError(describe(err));
      } finally {
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      }
    });
  };

  const remove = (id: number) => {
    setError(null);
    setDeletingId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
        if (!res.ok && res.status !== 204) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `Delete failed (HTTP ${res.status})`);
        }
      } catch (err) {
        setError(describe(err));
      } finally {
        setDeletingId(null);
        router.refresh();
      }
    });
  };

  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onFiles(e.target.files)}
      />

      {attachments.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No attachments yet.</p>
      ) : (
        <div className="space-y-3">
          {images.length > 0 && (
            <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {images.map((a) => (
                <li
                  key={a.id}
                  className="group relative overflow-hidden rounded-md border border-border/60 bg-card/30"
                >
                  <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/attachments/${a.id}`}
                      alt={a.filename}
                      className="h-28 w-full object-cover"
                    />
                  </a>
                  <div className="flex items-center justify-between gap-1 px-2 py-1 text-[10px] text-muted-foreground">
                    <span className="truncate" title={a.filename}>
                      {a.filename}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatBytes(a.sizeBytes)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    disabled={pending}
                    aria-label={`Delete ${a.filename}`}
                    title="Delete"
                    className="absolute right-1 top-1 rounded bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-state-blocked group-hover:opacity-100 disabled:opacity-50"
                  >
                    {deletingId === a.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {files.length > 0 && (
            <ul className="rounded-md border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
              {files.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <a
                    href={`/api/attachments/${a.id}?download=1`}
                    className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                    title={a.filename}
                  >
                    {a.filename}
                  </a>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {formatBytes(a.sizeBytes)}
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground tabular-nums hidden sm:inline"
                    title={a.mimeType}
                  >
                    {relativeDate(a.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    disabled={pending}
                    aria-label={`Delete ${a.filename}`}
                    title="Delete"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-state-blocked disabled:opacity-50"
                  >
                    {deletingId === a.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs",
          "text-muted-foreground hover:text-foreground hover:border-foreground/40 disabled:opacity-50"
        )}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5" />
        )}
        {pending ? "Uploading…" : "Upload image or file"}
      </button>

      <ErrorText className="text-[11px]">{error}</ErrorText>
    </div>
  );
}

/** Section header with a paperclip + count, for use above <Attachments />. */
export function AttachmentsHeading({ count }: { count: number }) {
  return (
    <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
      <Paperclip className="size-3.5 text-muted-foreground" />
      Attachments
      {count > 0 && (
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
      )}
    </h2>
  );
}
