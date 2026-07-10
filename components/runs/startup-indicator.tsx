"use client";

import { useEffect, useState } from "react";
import { Check, ScrollText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { TypingDots } from "@/components/ui/typing-dots";
import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/lib/types";

interface Props {
  /** Persisted placement: 'server' = the in-process lightweight loop (a "light
   *  chat"), 'worker' = a detached container/Machine that has to boot first. */
  runtime: "server" | "worker";
  status: SessionStatus;
  /** Open the worker (boot) log panel — offered for container runs so the user
   *  can see the real container output while it comes up. */
  onShowLog?: () => void;
}

// The boot of a container-backed run walks pending → preparing → running before
// the agent produces a single token. Each maps to a human step so the user can
// watch progress instead of staring at three anonymous dots for a minute.
const WORKER_STEPS: Array<{ status: SessionStatus; label: string }> = [
  { status: "pending", label: "Queued for a runner" },
  { status: "preparing", label: "Booting agent container" },
  { status: "running", label: "Starting the agent session" },
];

function workerStepIndex(status: SessionStatus): number {
  const i = WORKER_STEPS.findIndex((s) => s.status === status);
  // A status outside the boot arc (idle/parked resuming, etc.) is treated as
  // "on the last step" — the container is up and we're waiting on the agent.
  return i === -1 ? WORKER_STEPS.length - 1 : i;
}

// A ticking "elapsed" counter, started when the indicator mounts (i.e. when the
// turn began waiting). Only surfaced once a wait is long enough to be worth
// reassuring about, so a snappy start shows nothing.
function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

export function StartupIndicator({ runtime, status, onShowLog }: Props) {
  const elapsed = useElapsedSeconds();
  const elapsedLabel = elapsed >= 3 ? `${elapsed}s` : null;

  // A light chat has no container to boot, and a worker run whose container is
  // already warm (status past the pending/preparing boot arc) is just waking
  // the agent — neither is a cold boot, so show one calm line rather than a
  // fake boot sequence.
  const booting = runtime === "worker" && (status === "pending" || status === "preparing");
  if (!booting) {
    const label = runtime === "server" ? "Starting chat…" : "Waking the agent…";
    const detail =
      runtime === "server"
        ? "Warming up the model — the first reply may take a moment."
        : "The container is warm — resuming the agent session.";
    return (
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <TypingDots label={label} />
          <span>{label}</span>
          {elapsedLabel && (
            <span className="tabular-nums text-muted-foreground/70">
              {elapsedLabel}
            </span>
          )}
        </div>
        <p className="mt-1 pl-0.5 text-[11px] text-muted-foreground/70">{detail}</p>
      </div>
    );
  }

  const active = workerStepIndex(status);

  return (
    <div className="mx-4 my-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
        <Spinner className="size-3 text-state-progress" />
        <span>Booting agent container</span>
        {elapsedLabel && (
          <span className="tabular-nums font-normal text-muted-foreground/70">
            {elapsedLabel}
          </span>
        )}
        {onShowLog && (
          <button
            type="button"
            onClick={onShowLog}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <ScrollText className="size-3" /> Boot log
          </button>
        )}
      </div>

      <ol className="mt-2 space-y-1">
        {WORKER_STEPS.map((step, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <li
              key={step.status}
              className={cn(
                "flex items-center gap-2 text-[11px]",
                done && "text-muted-foreground/70",
                current && "text-foreground",
                !done && !current && "text-muted-foreground/40"
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {done ? (
                  <Check className="size-3 text-state-done" />
                ) : current ? (
                  <Spinner className="size-3 text-state-progress" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {elapsed >= 30 && (
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Cold starts can take up to a minute while the machine provisions.
        </p>
      )}
    </div>
  );
}
