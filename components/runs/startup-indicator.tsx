"use client";

import { useEffect, useState } from "react";
import { Check, ScrollText, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { TypingDots } from "@/components/ui/typing-dots";
import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/lib/types";
import {
  templateBuildView,
  type TemplateBuildState,
} from "@/lib/runner/box-template-events";
import {
  boxBootView,
  type BoxBootState,
} from "@/lib/runner/box-boot-events";

interface Props {
  status: SessionStatus;
  /** Live template-build state (spec 2026-07-17); non-null only while a box
   *  template is being built/failed for this run's dispatch. */
  templateBuild?: TemplateBuildState | null;
  /** Live box boot / worker-startup state; non-null once this run's box begins
   *  forking/provisioning, through to the worker channel being hosted. Drives a
   *  step-by-step stepper in place of the coarse status-based boot guess. */
  boxBoot?: BoxBootState | null;
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

export function StartupIndicator({ status, templateBuild, boxBoot, onShowLog }: Props) {
  const elapsed = useElapsedSeconds();
  const elapsedLabel = elapsed >= 3 ? `${elapsed}s` : null;

  if (templateBuild && templateBuild.phase !== "ready") {
    // The 1s elapsed tick above re-renders us every second, so computing the
    // view with Date.now() at render keeps all timers live.
    const v = templateBuildView(templateBuild, Date.now());
    const failed = v.phase === "failed";
    return (
      <div className="mx-4 my-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          {failed ? (
            <X className="size-3 text-state-blocked" />
          ) : (
            <Spinner className="size-3 text-state-progress" />
          )}
          <span>{v.title}</span>
          <span className="tabular-nums font-normal text-muted-foreground/70">
            {v.elapsedLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{v.expectation}</p>

        <ol className="mt-2 space-y-1">
          {v.steps.map((step) => (
            <li
              key={step.step}
              className={cn(
                "flex items-center gap-2 text-[11px]",
                step.state === "done" && "text-muted-foreground/70",
                step.state === "active" && "text-foreground",
                step.state === "failed" && "text-state-blocked",
                step.state === "todo" && "text-muted-foreground/40"
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {step.state === "done" ? (
                  <Check className="size-3 text-state-done" />
                ) : step.state === "active" ? (
                  <Spinner className="size-3 text-state-progress" />
                ) : step.state === "failed" ? (
                  <X className="size-3 text-state-blocked" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span>{step.label}</span>
              {step.elapsedSeconds != null && step.elapsedSeconds >= 3 && (
                <span className="tabular-nums text-muted-foreground/70">
                  {step.elapsedSeconds}s
                </span>
              )}
            </li>
          ))}
        </ol>

        {v.showReassurance && (
          <p className="mt-2 text-[11px] text-muted-foreground/70">{v.reassurance}</p>
        )}
        {failed && (
          <div className="mt-2 text-[11px] text-state-blocked">
            <pre className="whitespace-pre-wrap font-mono">{v.error}</pre>
            <p className="mt-1 text-muted-foreground/70">{v.failureHint}</p>
          </div>
        )}
      </div>
    );
  }

  // Live box boot / worker startup: once real lifecycle events arrive they
  // drive an accurate step-by-step stepper, replacing the coarse status-based
  // guess below. Shown until the terminal ready/failed phase.
  if (boxBoot && boxBoot.phase !== "ready") {
    const v = boxBootView(boxBoot, Date.now());
    const failed = v.phase === "failed";
    return (
      <div className="mx-4 my-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          {failed ? (
            <X className="size-3 text-state-blocked" />
          ) : (
            <Spinner className="size-3 text-state-progress" />
          )}
          <span>{v.title}</span>
          <span className="tabular-nums font-normal text-muted-foreground/70">
            {v.elapsedLabel}
          </span>
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
        <p className="mt-1 text-[11px] text-muted-foreground/70">{v.expectation}</p>

        <ol className="mt-2 space-y-1">
          {v.steps.map((step) => (
            <li
              key={step.step}
              className={cn(
                "flex items-center gap-2 text-[11px]",
                step.state === "done" && "text-muted-foreground/70",
                step.state === "active" && "text-foreground",
                step.state === "failed" && "text-state-blocked",
                step.state === "todo" && "text-muted-foreground/40"
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {step.state === "done" ? (
                  <Check className="size-3 text-state-done" />
                ) : step.state === "active" ? (
                  <Spinner className="size-3 text-state-progress" />
                ) : step.state === "failed" ? (
                  <X className="size-3 text-state-blocked" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span>{step.label}</span>
              {step.elapsedSeconds != null && step.elapsedSeconds >= 3 && (
                <span className="tabular-nums text-muted-foreground/70">
                  {step.elapsedSeconds}s
                </span>
              )}
            </li>
          ))}
        </ol>

        {failed && (
          <div className="mt-2 text-[11px] text-state-blocked">
            <pre className="whitespace-pre-wrap font-mono">{v.error}</pre>
            <p className="mt-1 text-muted-foreground/70">{v.failureHint}</p>
          </div>
        )}
      </div>
    );
  }

  // A worker run whose container is already warm (status past the
  // pending/preparing boot arc) is just waking the agent — not a cold boot, so
  // show one calm line rather than a fake boot sequence.
  const booting = status === "pending" || status === "preparing";
  if (!booting) {
    const label = "Waking the agent…";
    const detail = "The container is warm — resuming the agent session.";
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

      {templateBuild?.phase === "ready" && (
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <Check className="size-3 text-state-done" />
          </span>
          <span>
            {templateBuildView(templateBuild, Date.now()).readyLabel ??
              "Template ready"}
          </span>
        </div>
      )}

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
