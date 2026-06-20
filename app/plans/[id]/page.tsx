import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { PlanRepositories } from "@/components/plan-repositories";
import { DeleteButton } from "@/components/delete-button";
import { ExecutePlanButton } from "@/components/execute-plan-button";
import * as repo from "@/lib/repo";
import { listRuns } from "@/lib/runs";
import { STATE_LABEL, TASK_BOARD_STATES, type TaskState } from "@/lib/types";
import { StateChanger } from "@/components/state-changer";
import { StateIcon } from "@/components/state-icon";
import { MarkdownBody } from "@/components/markdown-body";
import { Progress } from "@/components/ui/progress";
import { TaskRow } from "@/components/task-row";
import { NewTaskForm } from "@/components/new-task-form";
import { PlanChatBox } from "@/components/plan-chat-box";
import { Attachments, AttachmentsHeading } from "@/components/attachments";
import { SessionStatusPill } from "@/components/session-status-pill";
import { buildPlanChatPromptPrefix } from "@/lib/run-templates";
import { formatDate, relativeDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = repo.getPlan(id);
  if (!plan) notFound();

  const tasks = repo.listTasks({ planId: plan.id });
  const { done, total, pct } = repo.planProgress(plan.id);
  const allRepositories = repo.listRepositories();
  const personas = repo.listPersonas();
  const planChats = listRuns({ planId: plan.id }).slice(0, 8);
  const chatPromptPrefix = buildPlanChatPromptPrefix(plan, tasks);

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
        <div className="ml-auto flex items-center gap-2">
          <ExecutePlanButton
            planId={plan.id}
            openTaskCount={tasks.filter((t) => t.state !== "done" && t.state !== "cancelled").length}
          />
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

      <section className="mt-8">
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

      <section className="mt-10 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Chat about this plan</h2>
          <span className="text-[11px] text-muted-foreground">
            agent can create tasks, edit the plan, change state
          </span>
        </div>
        <PlanChatBox
          planId={plan.id}
          repoOptions={plan.repos.map((r) => ({ id: r.id, name: r.name }))}
          promptPrefix={chatPromptPrefix}
          personas={personas}
        />
      </section>

      {planChats.length > 0 && (
        <section className="mt-8 space-y-3">
          <h2 className="text-sm font-semibold tracking-tight">Recent chats on this plan</h2>
          <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
            {planChats.map((r) => (
              <Link
                key={r.id}
                href={`/runs/${r.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <MessagesSquare className="size-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0">
                  #{r.id}
                </span>
                <SessionStatusPill status={r.status} />
                <span className="text-sm flex-1 truncate text-foreground/90">
                  {r.title ?? `Chat about ${plan.id}`}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {relativeDate(r.startedAt)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="my-8 h-px bg-border/60" />

      <MarkdownBody source={plan.body} />

      <section className="mt-10 space-y-3">
        <AttachmentsHeading count={plan.attachments.length} />
        <Attachments scope="plan" ownerId={plan.id} attachments={plan.attachments} />
      </section>
    </article>
  );
}
