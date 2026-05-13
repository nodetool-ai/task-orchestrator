// Unified run detail page. Dispatches on whether the run originated from
// a task (renders session-style activity log) or a chat (renders the
// existing ChatThread). Both flavours share the agent_runs row.

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/auth";
import * as agent from "@/lib/agent";
import * as chat from "@/lib/chat";
import * as repo from "@/lib/repo";
import { getRun } from "@/lib/runs";
import { SessionStatusPill } from "@/components/session-status-pill";
import { SessionLog } from "@/components/session-log";
import { CancelSessionButton } from "@/components/cancel-session-button";
import { ResumeSessionButton } from "@/components/resume-session-button";
import { Meta } from "@/components/meta";
import { ChatThread } from "@/components/chat/chat-thread";
import { formatDateTime, relativeDate } from "@/lib/utils";
import { isTerminalStatus, type SessionStatus } from "@/lib/types";

const INITIAL_EVENT_LIMIT = 100;

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) notFound();

  const run = getRun(runId);
  if (!run) notFound();

  if (run.origin === "chat") {
    return <ChatRunDetail runId={runId} />;
  }
  return <TaskRunDetail runId={runId} />;
}

async function TaskRunDetail({ runId }: { runId: number }) {
  const session = agent.getSession(runId);
  if (!session) notFound();
  const task = repo.getTask(session.taskId);
  const events = agent.getSessionEvents(runId, 0, INITIAL_EVENT_LIMIT);
  const live = agent.isLive(runId);
  const status = session.status as SessionStatus;
  const terminal = isTerminalStatus(status);
  const resumable = terminal && status !== "completed" && !!session.sdkSessionId;

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/runs"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Runs
      </Link>

      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
          <span className="tabular-nums">run #{session.id}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {task?.title ?? session.taskId}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SessionStatusPill status={status} />
          {task && (
            <Link
              href={`/tasks/${task.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 py-0.5 text-xs hover:bg-secondary"
            >
              <span className="font-mono text-muted-foreground">{task.id}</span>
            </Link>
          )}
          {session.prUrl && (
            <a
              className="text-xs text-foreground underline decoration-muted-foreground hover:decoration-foreground"
              href={session.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              PR ↗
            </a>
          )}
          {!terminal && <CancelSessionButton sessionId={session.id} />}
          {resumable && <ResumeSessionButton sessionId={session.id} />}
        </div>
      </header>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-6 text-xs">
        <Meta label="Model">{session.model ?? "—"}</Meta>
        <Meta label="Branch">
          {session.branch ? (
            <code className="font-mono text-foreground">{session.branch}</code>
          ) : (
            "—"
          )}
        </Meta>
        <Meta label="Started" hint={relativeDate(session.startedAt)}>
          {formatDateTime(session.startedAt)}
        </Meta>
        <Meta label="Completed">
          {session.completedAt ? formatDateTime(session.completedAt) : "—"}
        </Meta>
        <Meta label="Cost">
          {session.totalCostUsd !== null ? `$${session.totalCostUsd.toFixed(4)}` : "—"}
        </Meta>
        <Meta label="Tokens">
          {session.inputTokens !== null || session.outputTokens !== null
            ? `${(session.inputTokens ?? 0).toLocaleString()} in · ${(session.outputTokens ?? 0).toLocaleString()} out`
            : "—"}
        </Meta>
        {session.resumeOf !== null && (
          <Meta label="Resumed from">
            <Link
              href={`/runs/${session.resumeOf}`}
              className="font-mono text-foreground hover:underline"
            >
              #{session.resumeOf}
            </Link>
          </Meta>
        )}
        {session.sdkSessionId && (
          <Meta label="SDK session">
            <code className="font-mono text-[11px] text-muted-foreground">
              {session.sdkSessionId}
            </code>
          </Meta>
        )}
        {session.worktreePath && (
          <Meta label="Worktree" className="col-span-2 md:col-span-4">
            <code className="font-mono text-[11px] text-foreground/80">
              {session.worktreePath}
            </code>
          </Meta>
        )}
        {session.error && (
          <Meta label="Error" className="col-span-2 md:col-span-4">
            <span className="text-state-blocked">{session.error}</span>
          </Meta>
        )}
      </dl>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Activity</h2>
        <SessionLog
          sessionId={session.id}
          initialEvents={events}
          initialStatus={status}
          live={live}
        />
      </section>
    </article>
  );
}

async function ChatRunDetail({ runId }: { runId: number }) {
  const session = await auth();
  const userId = session?.user?.id ? Number(session.user.id) : null;
  const row = chat.getChat(runId, userId);
  if (!row) notFound();

  const messages = chat.listMessages(row.id);
  const { cwd } = chat.resolveChatCwd(row);
  const repositories = repo.listRepositories().map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath,
  }));

  // ChatThread expects to fill a parent with a defined height; the root
  // layout's `container py-8` doesn't give it one, so we escape the padding
  // and pin to viewport height like the old /chat layout did.
  return (
    <div className="-my-8 h-[calc(100vh-3rem-1px)] flex flex-col">
      <ChatThread
        chat={row}
        initialMessages={messages}
        userEmail={session?.user?.email ?? null}
        repoRoot={cwd}
        defaultModel={chat.getDefaultModel()}
        repositories={repositories}
      />
    </div>
  );
}
