#!/usr/bin/env node
// CLI for the SQLite-backed tasks system.
// Imports repo functions directly — no HTTP server needed.

import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as repo from "./lib/repo";
import * as agent from "./lib/agent";
import * as users from "./lib/users";
import { createMagicToken } from "./lib/magic-link";
import { sql } from "./db";
import { TASK_STATES, isTerminalStatus, type TaskState, type SessionStatus } from "./lib/types";
import { assistantText, toolUses, type SdkMessageEnvelope } from "./lib/sdk-message";
import { collectRunnerInventory } from "./lib/runner/inventory";
import { reapOrphanVolumes } from "./lib/runner/fly";
import { makeFlyClient } from "./lib/runner/fly-client";

function isTaskState(s: string): s is TaskState {
  return (TASK_STATES as readonly string[]).includes(s);
}

type Args = { _: string[]; [k: string]: unknown };

// Flags that are always boolean (never consume a following token as their
// value), so a positional after them stays a positional. Everything else is
// value-bearing and supports both `--flag=value` and space-separated
// `--flag value` forms.
const BOOLEAN_FLAGS = new Set(["json", "no-follow", "reap"]);

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      // Space-separated value form: `--flag value`. Consume the next token as
      // the value unless this is a known boolean flag or the next token is
      // itself a flag / absent (in which case the flag is a boolean true).
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        args[name] = next;
        i++;
      } else {
        args[name] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): string[] | undefined {
  if (typeof v !== "string") return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseBackend(v: unknown): "pi" | "claude" | undefined {
  const s = asString(v)?.trim().toLowerCase();
  if (s === undefined) return undefined;
  if (s === "pi" || s === "claude") return s;
  throw new Error(`Unknown --backend '${s}'. Expected 'pi' or 'claude'.`);
}

// ──────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────

async function cmdList(args: Args) {
  const filters: Parameters<typeof repo.listTasks>[0] = {};
  const state = asString(args.state);
  if (state) {
    if (!isTaskState(state)) {
      throw new Error(`Invalid --state: ${state}. Allowed: ${TASK_STATES.join(", ")}`);
    }
    filters.state = state;
  }
  const plan = asString(args.plan);
  if (plan) filters.planId = plan;
  const assignee = asString(args.assignee);
  if (assignee) filters.assignee = assignee;
  const tasks = await repo.listTasks(filters);
  if (args.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    console.log("(no tasks)");
    return 0;
  }
  console.log(`${pad("ID", 18)} ${pad("STATE", 14)} ${pad("ASSIGNEE", 12)} TITLE`);
  for (const t of tasks) {
    console.log(
      `${pad(t.id, 18)} ${pad(t.state, 14)} ${pad(t.assignee ?? "—", 12)} ${t.title}`
    );
  }
  return 0;
}

async function cmdPlans(args: Args) {
  const plans = await repo.listPlans();
  if (args.json) {
    console.log(JSON.stringify(plans, null, 2));
    return 0;
  }
  if (plans.length === 0) {
    console.log("(no plans)");
    return 0;
  }
  for (const p of plans) {
    const prog = await repo.planProgress(p.id);
    console.log(`${pad(p.id, 36)} ${pad(p.state, 10)} ${prog.done}/${prog.total}  ${p.title}`);
  }
  return 0;
}

async function cmdShow(args: Args) {
  const id = args._.shift();
  if (!id) throw new Error("Usage: show <id>");
  if (id.startsWith("P-")) {
    const plan = await repo.getPlan(id);
    if (!plan) throw new Error(`Plan not found: ${id}`);
    const tasks = await repo.listTasks({ planId: id });
    if (args.json) {
      console.log(JSON.stringify({ plan, tasks, progress: await repo.planProgress(id) }, null, 2));
      return 0;
    }
    const prog = await repo.planProgress(id);
    console.log(`${plan.id}  [${plan.state}]  ${plan.title}`);
    if (plan.owner) console.log(`  owner: @${plan.owner}`);
    if (plan.body) console.log(`\n${plan.body}\n`);
    console.log(`  progress: ${prog.done}/${prog.total} done (${prog.pct}%)`);
    if (tasks.length) {
      console.log("\nTasks:");
      for (const t of tasks) {
        console.log(`  ${pad(t.id, 18)} ${pad(t.state, 14)} ${t.title}`);
      }
    }
    return 0;
  }
  const task = await repo.getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (args.json) {
    console.log(JSON.stringify(task, null, 2));
    return 0;
  }
  console.log(`${task.id}  [${task.state}]  ${task.title}`);
  console.log(`  plan: ${task.planId}`);
  if (task.assignee) console.log(`  assignee: @${task.assignee}`);
  if (task.tags.length) console.log(`  tags: ${task.tags.join(", ")}`);
  if (task.dependencies.length) console.log(`  deps: ${task.dependencies.join(", ")}`);
  if (task.body) console.log(`\n${task.body}`);
  if (task.criteria.length) {
    console.log("\nAcceptance criteria:");
    for (const c of task.criteria) {
      console.log(`  [${c.done ? "x" : " "}] (${c.id}) ${c.text}`);
    }
  }
  if (task.notes.length) {
    console.log("\nNotes:");
    for (const n of task.notes) {
      console.log(`  @${n.author} ${n.createdAt.toISOString()}`);
      console.log(`    ${n.body.replace(/\n/g, "\n    ")}`);
    }
  }
  return 0;
}

async function cmdNewPlan(args: Args) {
  const title = asString(args.title);
  if (!title) throw new Error("--title is required");
  const plan = await repo.createPlan({
    title,
    id: asString(args.id),
    owner: asString(args.owner),
    body: asString(args.body) ?? "",
    tags: asArray(args.tags) ?? [],
    date: asString(args.date),
  });
  console.log(`Created plan ${plan.id}`);
  return 0;
}

async function cmdNewTask(args: Args) {
  const title = asString(args.title);
  const plan = asString(args.plan);
  if (!title) throw new Error("--title is required");
  if (!plan) throw new Error("--plan is required");
  const task = await repo.createTask({
    planId: plan,
    title,
    id: asString(args.id),
    assignee: asString(args.assignee) ?? null,
    body: asString(args.body) ?? "",
    estimate: asString(args.estimate) ?? null,
    tags: asArray(args.tags) ?? [],
    dependencies: asArray(args.dependencies) ?? [],
    criteria: asArray(args.criteria) ?? [],
    date: asString(args.date),
  });
  console.log(`Created task ${task.id}`);
  return 0;
}

async function cmdTransition(args: Args) {
  const id = args._.shift();
  const state = args._.shift();
  if (!id || !state) throw new Error("Usage: transition <id> <state>");
  if (!TASK_STATES.includes(state as TaskState)) throw new Error(`Invalid state: ${state}`);
  const before = await repo.getTask(id);
  if (!before) throw new Error(`Task not found: ${id}`);
  const after = await repo.transitionTask(id, {
    state: state as TaskState,
    assignee: asString(args.assignee),
    note: asString(args.note),
  });
  console.log(`${id}: ${before.state} → ${after.state}`);
  return 0;
}

async function cmdNote(args: Args) {
  const id = args._.shift();
  const body = asString(args.body);
  if (!id || !body) throw new Error("Usage: note <task-id> --body=... [--author=...]");
  const author = asString(args.author) ?? process.env.USER ?? "you";
  await repo.addNote(id, author, body);
  console.log(`Added note to ${id}`);
  return 0;
}

async function cmdCrit(args: Args) {
  const sub = args._.shift();
  if (sub === "add") {
    const id = args._.shift();
    const text = asString(args.text) ?? args._.join(" ");
    if (!id || !text) throw new Error('Usage: crit add <task-id> --text="..."');
    await repo.addCriterion(id, text);
    console.log(`Added criterion to ${id}`);
    return 0;
  }
  if (sub === "done" || sub === "undone") {
    const cid = args._.shift();
    if (!cid) throw new Error(`Usage: crit ${sub} <criterion-id>`);
    const cidNum = parseInt(cid, 10);
    if (Number.isNaN(cidNum)) throw new Error(`Invalid criterion id: ${cid}`);
    await repo.updateCriterion(cidNum, { done: sub === "done" });
    console.log(`Criterion ${cid}: done=${sub === "done"}`);
    return 0;
  }
  if (sub === "rm") {
    const cid = args._.shift();
    if (!cid) throw new Error("Usage: crit rm <criterion-id>");
    const cidNum = parseInt(cid, 10);
    if (Number.isNaN(cidNum)) throw new Error(`Invalid criterion id: ${cid}`);
    await repo.deleteCriterion(cidNum);
    console.log(`Removed criterion ${cid}`);
    return 0;
  }
  throw new Error("Usage: crit <add|done|undone|rm>");
}

async function cmdAttach(args: Args) {
  const sub = args._.shift();
  if (sub === "add") {
    const ownerId = args._.shift();
    const path = asString(args.file) ?? args._.shift();
    if (!ownerId || !path) {
      throw new Error("Usage: attach add <P-...|T-...> <file> [--name=...] [--mime=...]");
    }
    const content = readFileSync(path);
    const filename = asString(args.name) ?? basename(path);
    const mimeType = asString(args.mime) ?? mimeFromName(filename);
    const author = asString(args.author) ?? process.env.USER ?? "you";
    const owner = ownerId.startsWith("P-") ? { planId: ownerId } : { taskId: ownerId };
    const meta = await repo.addAttachment({ ...owner, filename, mimeType, content, author });
    console.log(`Attached #${meta.id} ${meta.filename} (${meta.kind}, ${meta.sizeBytes} bytes) to ${ownerId}`);
    return 0;
  }
  if (sub === "list") {
    const ownerId = args._.shift();
    if (!ownerId) throw new Error("Usage: attach list <P-...|T-...>");
    const owner = ownerId.startsWith("P-") ? { planId: ownerId } : { taskId: ownerId };
    const list = await repo.listAttachments(owner);
    if (args.json) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (list.length === 0) {
      console.log("(no attachments)");
      return 0;
    }
    for (const a of list) {
      console.log(`  ${pad("#" + a.id, 6)} ${pad(a.kind, 9)} ${pad(String(a.sizeBytes), 9)} ${a.filename} (${a.mimeType})`);
    }
    return 0;
  }
  if (sub === "get") {
    const idArg = args._.shift();
    const out = asString(args.out);
    if (!idArg || !out) throw new Error("Usage: attach get <attachment-id> --out=<path>");
    const idNum = parseInt(idArg, 10);
    if (Number.isNaN(idNum)) throw new Error(`Invalid attachment id: ${idArg}`);
    const att = await repo.getAttachment(idNum);
    if (!att) throw new Error(`Attachment not found: ${idArg}`);
    writeFileSync(out, att.content);
    console.log(`Wrote ${att.sizeBytes} bytes to ${out}`);
    return 0;
  }
  if (sub === "rm") {
    const idArg = args._.shift();
    if (!idArg) throw new Error("Usage: attach rm <attachment-id>");
    const idNum = parseInt(idArg, 10);
    if (Number.isNaN(idNum)) throw new Error(`Invalid attachment id: ${idArg}`);
    await repo.deleteAttachment(idNum);
    console.log(`Removed attachment ${idArg}`);
    return 0;
  }
  throw new Error("Usage: attach <add|list|get|rm> ...");
}

function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    log: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

async function cmdPlanTransition(args: Args) {
  const id = args._.shift();
  const state = args._.shift();
  if (!id || !state) throw new Error("Usage: plan-state <plan-id> <state>");
  const before = await repo.getPlan(id);
  if (!before) throw new Error(`Plan not found: ${id}`);
  const after = await repo.updatePlan(id, {
    state: state as Parameters<typeof repo.updatePlan>[1]["state"],
  });
  console.log(`${id}: ${before.state} → ${after.state}`);
  return 0;
}

async function cmdAgent(args: Args) {
  const sub = args._[0];
  if (sub === "list") {
    args._.shift();
    const sessions = await agent.listSessions();
    if (args.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return 0;
    }
    if (sessions.length === 0) {
      console.log("(no sessions)");
      return 0;
    }
    for (const s of sessions) {
      const cost = s.totalCostUsd !== null ? `$${s.totalCostUsd.toFixed(4)}` : "";
      console.log(
        `#${pad(String(s.id), 4)} ${pad(s.status, 12)} ${pad(s.taskId, 18)} ${pad(s.branch ?? "—", 28)} ${pad(cost, 10)} ${s.prUrl ?? ""}`
      );
    }
    return 0;
  }
  if (sub === "cancel") {
    args._.shift();
    const sid = args._.shift();
    if (!sid) throw new Error("Usage: agent cancel <session-id>");
    const session = await agent.cancelSession(parseInt(sid, 10));
    console.log(`#${session.id}: ${session.status}`);
    return 0;
  }
  if (sub === "resume") {
    args._.shift();
    const sid = args._.shift();
    if (!sid) throw new Error("Usage: agent resume <session-id> [--model=...] [--no-follow]");
    const prior = await agent.getSession(parseInt(sid, 10));
    if (!prior) throw new Error(`Session #${sid} not found`);
    const session = await agent.startSession({
      taskId: prior.taskId,
      model: asString(args.model) ?? prior.model ?? undefined,
      // Omitted → startSession inherits the prior session's backend.
      backend: parseBackend(args.backend),
      resumeOf: prior.id,
    });
    console.log(`Resumed as session #${session.id} (from #${prior.id})`);
    if (args["no-follow"]) return 0;
    await tailSession(session.id);
    return 0;
  }

  // Default: agent <task-id> [--model=...] [--backend=pi|claude] [--no-follow]
  const taskId = args._.shift();
  if (!taskId) throw new Error("Usage: agent <task-id> [--model=...] [--backend=pi|claude] [--no-follow]");
  const session = await agent.startSession({
    taskId,
    model: asString(args.model),
    backend: parseBackend(args.backend),
  });
  console.log(`Started session #${session.id} for ${taskId}`);
  if (args["no-follow"]) return 0;
  await tailSession(session.id);
  return 0;
}

// Tail a session through to a terminal status. Single code path:
// if the session is already terminal at attach time, drain stored events
// and return immediately. Otherwise subscribe and wait for the bus to
// emit a terminal status event.
async function tailSession(sessionId: number) {
  const current = await agent.getSession(sessionId);
  if (current && isTerminalStatus(current.status)) {
    for (const e of await agent.getSessionEvents(sessionId)) printAgentEvent(e);
    return;
  }
  await new Promise<void>((resolveP) => {
    const off = agent.subscribe(sessionId, (event) => {
      printAgentEvent(event);
      if (event.type === "status") {
        const s = (event.payload as { status?: string })?.status;
        if (s && isTerminalStatus(s as SessionStatus)) {
          off();
          resolveP();
        }
      }
    });
  });
}

function printAgentEvent(event: { type: string; payload: unknown; createdAt: Date }) {
  const ts = event.createdAt.toISOString().slice(11, 19);
  const p = event.payload as Record<string, unknown> | undefined;
  switch (event.type) {
    case "status":
      console.log(`[${ts}] ▸ ${String(p?.status)}${p?.error ? ` — ${p.error}` : ""}`);
      break;
    case "shell":
      console.log(`[${ts}] $ ${String(p?.cmd)}`);
      break;
    case "shell_out": {
      const s = String(p?.data ?? "").trimEnd();
      if (s) console.log(s.split("\n").map((l) => `         ${l}`).join("\n"));
      break;
    }
    case "agent": {
      const m = p as SdkMessageEnvelope;
      if (m?.type === "assistant") {
        const text = assistantText(m.message?.content);
        if (text) console.log(`[${ts}] ◆ ${text}`);
        for (const t of toolUses(m.message?.content)) {
          console.log(`[${ts}]   • tool: ${t.name}`);
        }
      } else if (m?.type === "result") {
        console.log(`[${ts}] ✓ result`);
      }
      break;
    }
    case "pr":
      console.log(`[${ts}] PR: ${String(p?.url)}`);
      break;
    case "warning":
      console.warn(`[${ts}] ! ${String(p?.message)}`);
      break;
  }
}

async function readPasswordInteractive(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let buf = "";
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          reject(new Error("Aborted"));
          return;
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function resolvePassword(args: Args): Promise<string> {
  const inline = asString(args.password);
  if (inline) return inline;
  const pw = await readPasswordInteractive("Password: ");
  if (!pw) throw new Error("Password is required (use --password=... for non-interactive)");
  return pw;
}

async function cmdUser(args: Args): Promise<number> {
  const sub = args._.shift();
  switch (sub) {
    case "add": {
      const email = args._.shift();
      if (!email) throw new Error("Usage: user add <email> [--password=...]");
      const pw = await resolvePassword(args);
      const u = await users.createUser(email, pw);
      console.log(`+ ${u.email}`);
      return 0;
    }
    case "passwd": {
      const email = args._.shift();
      if (!email) throw new Error("Usage: user passwd <email> [--password=...]");
      const pw = await resolvePassword(args);
      await users.setPassword(email, pw);
      console.log(`updated ${email}`);
      return 0;
    }
    case "link": {
      const email = args._.shift();
      if (!email) throw new Error("Usage: user link <email> [--origin=https://...]");
      const user = await users.findUser(email);
      if (!user) throw new Error(`No user with email ${email}`);
      const token = await createMagicToken(user.email);
      const origin = asString(args.origin) || "https://tasks.nodetool.ai";
      const url = `${origin}/login-link?token=${encodeURIComponent(token)}`;
      console.log(url);
      return 0;
    }
    case "rm": {
      const email = args._.shift();
      if (!email) throw new Error("Usage: user rm <email>");
      const ok = await users.deleteUser(email);
      if (!ok) throw new Error(`No user with email ${email}`);
      console.log(`- ${email}`);
      return 0;
    }
    case "list":
    case undefined: {
      const all = await users.listUsers();
      if (args.json) {
        console.log(JSON.stringify(all.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt })), null, 2));
        return 0;
      }
      if (all.length === 0) {
        console.log("(no users)");
        return 0;
      }
      console.log(`${pad("ID", 6)} ${pad("EMAIL", 32)} CREATED`);
      for (const u of all) {
        console.log(`${pad(String(u.id), 6)} ${pad(u.email, 32)} ${u.createdAt.toISOString()}`);
      }
      return 0;
    }
    default:
      throw new Error("Usage: user <add|passwd|link|rm|list> ...");
  }
}

function formatAge(ms: number | null): string {
  if (ms == null) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function cmdRunners(args: Args): Promise<number> {
  const inv = await collectRunnerInventory();
  if (args.json) {
    console.log(JSON.stringify(inv, null, 2));
    return 0;
  }

  if (inv.rows.length === 0) {
    console.log("(no runner machines or volumes)");
  } else {
    console.log(
      `${pad("RUN", 6)} ${pad("MACHINE", 20)} ${pad("M-STATE", 10)} ${pad("VOLUME", 22)} ${pad("V-STATE", 10)} ${pad("SIZE", 6)} ${pad("AGE", 6)} ${pad("$/MO", 8)} ORPHAN`
    );
    for (const r of inv.rows) {
      console.log(
        `${pad(r.runId != null ? "#" + r.runId : "—", 6)} ` +
          `${pad(r.machineId ?? "—", 20)} ` +
          `${pad(r.machineState ?? "—", 10)} ` +
          `${pad(r.volumeId ?? "—", 22)} ` +
          `${pad(r.volumeState ?? "—", 10)} ` +
          `${pad(r.sizeGb != null ? `${r.sizeGb}G` : "—", 6)} ` +
          `${pad(formatAge(r.ageMs), 6)} ` +
          `${pad(`$${r.estMonthlyCostUsd.toFixed(2)}`, 8)} ` +
          `${r.orphan ? "⚠ orphan" : ""}`
      );
    }
  }

  const t = inv.totals;
  console.log(
    `\n${t.machines} machines, ${t.volumes} volumes, ${t.totalGb} GB, ~$${t.estMonthlyCostUsd.toFixed(2)}/mo (${t.orphanVolumes} orphan volumes)`
  );

  if (args.reap) {
    // Delegate to the SAME guarded reaper the sweep uses — it re-lists volumes
    // and applies isReapableVolume's full safety checks (vol_run_* naming +
    // 10-min grace window + the non-"gone" mapping protection). The inventory
    // `orphan` flag is display-only and deliberately NOT used to pick destroy
    // targets: it lacks those guards and could point at a volume that isn't ours
    // or is still mid-provision.
    let client;
    try {
      client = makeFlyClient();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\nCannot reap — Fly client unavailable: ${message}`);
      return 1;
    }
    const destroyed = await reapOrphanVolumes(client);
    if (destroyed.length === 0) {
      console.log("\nNo orphan volumes to reap.");
    } else {
      console.log(`\nReaped ${destroyed.length} orphan volume(s):`);
      for (const id of destroyed) console.log(`  destroyed ${id}`);
    }
  }

  return 0;
}

function help() {
  console.log(`Usage: npm run task -- <command> [args]

Commands:
  list                              List tasks. --state=X --plan=X --assignee=X --json
  plans                             List plans. --json
  show <id>                         Show task or plan detail. --json

  new plan --title="..."            Create plan. --owner=X --tags=a,b --body=... --date=YYYY-MM-DD
  new task --plan=P-... --title=... Create task. --assignee=X --tags=a,b --dependencies=T-...,T-...
                                    --criteria="text1,text2" --estimate=2h --body=... --date=...

  transition <T-...> <state>        Move task. --assignee=X --note="..."
  plan-state <P-...> <state>        Move plan.
  note <T-...> --body="..." [--author=...]
                                    Append a note to a task.
  crit add <T-...> --text="..."     Add an acceptance criterion.
  crit done <criterion-id>          Mark criterion done.
  crit undone <criterion-id>        Mark criterion undone.
  crit rm <criterion-id>            Remove criterion.

  attach add <P-...|T-...> <file>   Attach an image/artifact. --name=... --mime=...
  attach list <P-...|T-...> [--json]  List attachments on a plan or task.
  attach get <attachment-id> --out=<path>  Write an attachment's bytes to a file.
  attach rm <attachment-id>         Delete an attachment.

  agent <T-...> [--model=...]       Start an agent session for a task and tail
                                    events. Use --no-follow to detach and
                                    --backend=pi|claude to pick the agent
                                    backend (default: deployment env).
  agent list [--json]               List all agent sessions.
  agent cancel <session-id>         Cancel an active session.
  agent resume <session-id>         Resume a prior (terminal) session; pass
                                    --model=... / --backend=... to change
                                    models or backends on resume (backend
                                    defaults to the prior session's).

  user list [--json]                List sign-in users.
  user add <email> [--password=...] Create a user. Prompts for password if omitted.
  user passwd <email> [--password=...]
                                    Update a user's password.
  user link <email> [--origin=...]  Generate a one-time magic login link.
  user rm <email>                   Delete a user.

  runners [--json] [--reap]         List runner Machines + volumes with state, run, age, est. cost. --reap destroys orphan volumes.

States:
  Tasks: ${TASK_STATES.join(", ")}

DB: data.db (override with TASK_ORCH_DB env var).
`);
}

// ──────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  try {
    let code = 0;
    switch (cmd) {
      case "list":
        code = await cmdList(args);
        break;
      case "plans":
        code = await cmdPlans(args);
        break;
      case "show":
        code = await cmdShow(args);
        break;
      case "new": {
        const sub = args._.shift();
        if (sub === "plan") code = await cmdNewPlan(args);
        else if (sub === "task") code = await cmdNewTask(args);
        else throw new Error("Usage: new <plan|task> ...");
        break;
      }
      case "transition":
        code = await cmdTransition(args);
        break;
      case "plan-state":
        code = await cmdPlanTransition(args);
        break;
      case "note":
        code = await cmdNote(args);
        break;
      case "crit":
        code = await cmdCrit(args);
        break;
      case "attach":
        code = await cmdAttach(args);
        break;
      case "agent":
        code = await cmdAgent(args);
        break;
      case "user":
        code = await cmdUser(args);
        break;
      case "runners":
        code = await cmdRunners(args);
        break;
      case "help":
      case undefined:
        help();
        break;
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
    shutdown(code);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`tasks: ${message}`);
    shutdown(1);
  }
}

function shutdown(code: number): never {
  try {
    void sql.end();
  } catch {
    // ignore — process is exiting anyway
  }
  process.exit(code);
}

main().catch((err) => {
  console.error("tasks:", err instanceof Error ? err.message : String(err));
  shutdown(1);
});
