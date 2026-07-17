// The /environments page: every runner provider's execution artifact — a
// Docker image, a Fly runner image, or a Box template snapshot — in one place,
// grouped by provider and versioned by worker build SHA. registerConfigured-
// Environments() makes configured docker/fly images visible without a build;
// listEnvironments() returns everything newest-first for the view.
import { listEnvironments, registerConfiguredEnvironments } from "@/lib/runner/environments";
import { EnvironmentsView } from "@/components/environments/environments-view";

export const dynamic = "force-dynamic";

export default async function EnvironmentsPage() {
  await registerConfiguredEnvironments();
  const rows = await listEnvironments();
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-lg font-semibold">Environments</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        The execution artifact each runner provider launches from — a Docker
        image, a Fly runner image, or a Box template snapshot — versioned by
        worker build SHA.
      </p>
      <EnvironmentsView
        rows={rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          workerSha: r.workerSha,
          state: r.state,
          artifact: r.boxId ?? r.image ?? null,
          detail: r.detail,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          readyAt: r.readyAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
