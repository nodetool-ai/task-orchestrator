"use client";

// The environments list, grouped by provider (box / docker / fly). Box and
// docker get an in-app build button (POST /api/environments/build); fly is
// info-only with the copyable build/push command from docs/fly-deployment.md.
// While any row is `building` the list polls via router.refresh() every 5s so
// step `detail` and the eventual ready/failed transition appear without a
// manual reload.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Box, Container, Cloud } from "lucide-react";

import { cn, relativeDate } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { CodeBlock } from "@/components/ui/code-block";

export interface EnvironmentRowView {
  id: number;
  provider: string;
  workerSha: string;
  state: string;
  artifact: string | null;
  detail: string | null;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
}

const PROVIDER_ORDER = ["box", "docker", "fly"] as const;
type Provider = (typeof PROVIDER_ORDER)[number];

const PROVIDER_META: Record<
  Provider,
  { label: string; blurb: string; icon: typeof Box }
> = {
  box: {
    label: "Box",
    blurb: "Archived template box snapshots — run boxes fork from the ready one.",
    icon: Box,
  },
  docker: {
    label: "Docker",
    blurb: "The worker image built from Dockerfile.worker on this host.",
    icon: Container,
  },
  fly: {
    label: "Fly",
    blurb: "The runner image pushed to the Fly registry (built out-of-app).",
    icon: Cloud,
  },
};

const STATE_TONE: Record<string, string> = {
  building: "text-state-progress",
  ready: "text-state-done",
  failed: "text-state-blocked",
  superseded: "text-muted-foreground",
};

const STATE_LABEL: Record<string, string> = {
  building: "Building",
  ready: "Ready",
  failed: "Failed",
  superseded: "Superseded",
};

function StatePill({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/60 px-2 py-0.5 text-xs font-medium",
        STATE_TONE[state] ?? "text-muted-foreground"
      )}
    >
      {state === "building" && <Spinner className="size-3" />}
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

export function EnvironmentsView({ rows }: { rows: EnvironmentRowView[] }) {
  const router = useRouter();
  const anyBuilding = rows.some((r) => r.state === "building");

  // Poll while any build is in flight so detail/state transitions land without
  // a manual reload; stop as soon as nothing is building.
  React.useEffect(() => {
    if (!anyBuilding) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [anyBuilding, router]);

  const byProvider = React.useMemo(() => {
    const map = new Map<string, EnvironmentRowView[]>();
    for (const r of rows) {
      const list = map.get(r.provider) ?? [];
      list.push(r);
      map.set(r.provider, list);
    }
    return map;
  }, [rows]);

  return (
    <div className="mt-6 space-y-8">
      {PROVIDER_ORDER.map((provider) => (
        <ProviderSection
          key={provider}
          provider={provider}
          rows={byProvider.get(provider) ?? []}
          onRefresh={() => router.refresh()}
        />
      ))}
    </div>
  );
}

function ProviderSection({
  provider,
  rows,
  onRefresh,
}: {
  provider: Provider;
  rows: EnvironmentRowView[];
  onRefresh: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const Icon = meta.icon;
  const building = rows.some((r) => r.state === "building");

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{meta.label}</h2>
        <span className="text-[11px] text-muted-foreground">{meta.blurb}</span>
      </div>

      {provider === "fly" ? (
        <FlyBuildCard rows={rows} />
      ) : (
        <BuildButton provider={provider} building={building} onRefresh={onRefresh} />
      )}

      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No {meta.label} environments yet.</p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
          {rows.map((r) => (
            <EnvironmentRowLine key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function EnvironmentRowLine({ row }: { row: EnvironmentRowView }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatePill state={row.state} />
        {row.artifact && (
          <span className="font-mono text-xs text-foreground/90">{row.artifact}</span>
        )}
        <span className="font-mono text-[11px] text-muted-foreground" title={row.workerSha}>
          {row.workerSha.slice(0, 7)}
        </span>
        {row.state === "building" && row.detail && (
          <span className="text-[11px] text-state-progress">{row.detail}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>created {relativeDate(new Date(row.createdAt))}</span>
        {row.readyAt && <span>· ready {relativeDate(new Date(row.readyAt))}</span>}
      </div>
      {row.state === "failed" && row.error && (
        <details className="mt-1.5 text-[11px]">
          <summary className="cursor-pointer text-state-blocked">
            {row.error.length > 120 ? `${row.error.slice(0, 120)}…` : row.error}
          </summary>
          <CodeBlock tone="error" className="mt-1.5" selectable>
            {row.error}
          </CodeBlock>
        </details>
      )}
    </div>
  );
}

function BuildButton({
  provider,
  building,
  onRefresh,
}: {
  provider: "box" | "docker";
  building: boolean;
  onRefresh: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const label = provider === "box" ? "Build template" : "Build image";

  async function build() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/environments/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Build request failed (HTTP ${res.status}).`);
        return;
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const disabled = pending || building;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={build}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/60 px-3 py-1.5 text-xs font-medium transition-colors",
          disabled
            ? "cursor-not-allowed text-muted-foreground"
            : "text-foreground hover:bg-muted/60"
        )}
      >
        {pending && <Spinner className="size-3" />}
        {building ? "Building…" : label}
      </button>
      {error && <span className="text-[11px] text-state-blocked">{error}</span>}
    </div>
  );
}

function FlyBuildCard({ rows }: { rows: EnvironmentRowView[] }) {
  const current = rows.find((r) => r.state === "ready") ?? rows[0];
  const image = current?.artifact ?? "registry.fly.io/<runner-app>:latest";
  const command = `fly deploy --config fly.runner.toml --app <runner-app> \\
  --dockerfile Dockerfile.fly-runner --build-only --push --image-label latest`;

  return (
    <div className="rounded-lg border border-border/60 bg-card/30 px-4 py-3 space-y-2">
      <p className="text-[13px] text-muted-foreground">
        Fly runner images are built and pushed outside the app. Current image:{" "}
        <span className="font-mono text-foreground/90">{image}</span>.
      </p>
      <CodeBlock tone="muted" selectable>
        {command}
      </CodeBlock>
      <p className="text-[11px] text-muted-foreground">
        See <span className="font-mono">docs/fly-deployment.md</span> for the full flow.
      </p>
    </div>
  );
}
