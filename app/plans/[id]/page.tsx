import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PlanRepositories } from "@/components/plan-repositories";
import { DeleteButton } from "@/components/delete-button";
import * as repo from "@/lib/repo";
import { STATE_LABEL, TASK_BOARD_STATES, type TaskState } from "@/lib/types";
import { StateChanger } from "@/components/state-changer";
import { StateIcon } from "@/components/state-icon";
import { MarkdownBody } from "@/components/markdown-body";
import { Progress } from "@/components/ui/progress";
import { TaskRow } from "@/components/task-row";
import { NewTaskForm } from "@/components/new-task-form";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = repo.getPlan(id);
  if (!plan) notFound();

  const tasks = repo.listTasks({ planId: plan.id });
  const { done, total, pct } = repo.planProgress(plan.id);
  const allRepositories = repo.listRepositories();

  const groupOrder: TaskState[] = [...TASK_BOARD_STATES, "cancelled"];

  return (
    <article className="mx-auto max-w-3xl">
      <Link
        href="/plans"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="size-3.5" /> Plans
      </Link>

      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <span className="tabular-nums">{plan.id}</span>
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-tight">{plan.title}</h1>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StateChanger kind="plan" planId={plan.id} current={plan.state} />
        {plan.owner && <span className="text-xs text-muted-foreground">@{plan.owner}</span>}
        <span className="text-xs text-muted-foreground">Created {formatDate(plan.createdAt)}</span>
        <div className="ml-auto">
          <DeleteButton
            endpoint={`/api/plans/${plan.id}`}
            redirectTo="/plans"
            confirmMessage={`Delete plan "${plan.title}"? This removes all ${total} task${total === 1 ? "" : "s"} under it. This cannot be undone.`}
            label="Delete plan"
          />
        </div>
      </div>

      <div className="mt-3">
        <PlanRepositories
          planId={plan.id}
          repos={plan.repos}
          allRepositories={allRepositories}
        />
      </div>

      {total > 0 && (
        <div className="mt-5 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Progress</span>
            <span className="tabular-nums">
              {done} / {total} done · {pct}%
            </span>
          </div>
          <Progress value={pct} className="mt-2 h-1" />
        </div>
      )}

      <div className="my-8 h-px bg-border/60" />

      <MarkdownBody source={plan.body} />

      <section className="mt-12">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold tracking-tight">Tasks</h2>
          <NewTaskForm
            planId={plan.id}
            repoOptions={plan.repos.map((r) => ({ id: r.id, name: r.name }))}
          />
        </div>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <div className="space-y-6">
            {groupOrder.map((state) => {
              const group = tasks.filter((t) => t.state === state);
              if (group.length === 0) return null;
              return (
                <div key={state} className="space-y-1.5">
                  <div className="flex items-center gap-2 px-3">
                    <StateIcon state={state} />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {STATE_LABEL[state]}
                    </h3>
                    <span className="text-xs text-muted-foreground tabular-nums">{group.length}</span>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
                    {group.map((t) => (
                      <div key={t.id} className="px-3">
                        <TaskRow task={t} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </article>
  );
}
