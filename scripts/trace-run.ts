#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";

const execFileAsync = promisify(execFile);

type Args = {
  _: string[];
  fly: boolean;
  app: string;
  out?: string;
  json: boolean;
  tailEvents: number;
  tailMessages: number;
  logs: boolean;
};

type Trace = {
  root: number;
  ids: number[];
  generatedAt: string;
  source: "local" | "fly";
  runs: any[];
  runners: any[];
  eventCounts: any[];
  runnerEvents: any[];
  msgCounts: any[];
  recentEvents: any[];
  recentMessages: any[];
  inbox: any[];
  timers: any[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    _: [],
    fly: false,
    app: process.env.FLY_APP ?? "task-orchestrator",
    json: false,
    tailEvents: 25,
    tailMessages: 10,
    logs: true,
  };
  for (const a of argv) {
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = a.slice(2, eq === -1 ? undefined : eq);
    const value = eq === -1 ? "true" : a.slice(eq + 1);
    if (key === "fly") args.fly = value !== "false";
    else if (key === "app") args.app = value;
    else if (key === "out") args.out = value;
    else if (key === "json") args.json = value !== "false";
    else if (key === "tail-events") args.tailEvents = Number(value);
    else if (key === "tail-messages") args.tailMessages = Number(value);
    else if (key === "logs") args.logs = value !== "false";
    else throw new Error(`Unknown option --${key}`);
  }
  return args;
}

function usage(): never {
  throw new Error(
    [
      "Usage: npm run trace-run -- <run-id> [--fly] [--out=trace.json]",
      "",
      "Options:",
      "  --fly                 Query the deployed DB via flyctl ssh console.",
      "  --app=<name>          Fly web/control app for --fly DB queries.",
      "  --tail-events=<n>     Recent agent_events per run (default 25).",
      "  --tail-messages=<n>   Recent agent_messages per run (default 10).",
      "  --logs=false          Skip flyctl logs enrichment.",
      "  --json                Print full JSON to stdout.",
    ].join("\n")
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function queryScript(root: number, tailEvents: number, tailMessages: number): string {
  return `
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: false });
const root = ${JSON.stringify(root)};
const tailEvents = ${JSON.stringify(tailEvents)};
const tailMessages = ${JSON.stringify(tailMessages)};
try {
  const runs = await sql\`
    WITH RECURSIVE tree AS (
      SELECT *, 0 AS depth, ARRAY[id] AS path
        FROM agent_runs
       WHERE id = \${root}
      UNION ALL
      SELECT c.*, t.depth + 1, t.path || c.id
        FROM agent_runs c
        JOIN tree t ON c.parent_run_id = t.id
       WHERE NOT c.id = ANY(t.path)
    )
    SELECT id, parent_run_id, task_id, plan_id, repo_id, goal, status,
           persona_id, backend, model, cwd_strategy, tools_profile,
           branch, pr_url, error, outcome, result, park_reason,
           pending_question, attempt, heartbeat_at, worker_scope, worker_pid,
           worker_exit_code, worker_log, started_at, completed_at, depth
      FROM tree
     ORDER BY path
  \`;
  const ids = runs.map((r) => r.id);
  const idStrings = ids.map(String);
  const runners = ids.length
    ? await sql\`SELECT * FROM runner_instances WHERE run_id = ANY(\${ids}) ORDER BY run_id\`
    : [];
  const eventCounts = ids.length
    ? await sql\`
        SELECT run_id, type, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at
          FROM agent_events
         WHERE run_id = ANY(\${ids})
         GROUP BY run_id, type
         ORDER BY run_id, type
      \`
    : [];
  const runnerEvents = ids.length
    ? await sql\`
        SELECT id, run_id, type, payload, created_at
          FROM agent_events
         WHERE run_id = ANY(\${ids})
           AND type LIKE 'runner_%'
         ORDER BY run_id, id
      \`
    : [];
  const msgCounts = ids.length
    ? await sql\`
        SELECT run_id, role, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at
          FROM agent_messages
         WHERE run_id = ANY(\${ids})
         GROUP BY run_id, role
         ORDER BY run_id, role
      \`
    : [];
  const recentEvents = ids.length
    ? await sql\`
        SELECT *
          FROM (
            SELECT id, run_id, type, payload, created_at,
                   row_number() OVER (PARTITION BY run_id ORDER BY id DESC) rn
              FROM agent_events
             WHERE run_id = ANY(\${ids})
          ) x
         WHERE rn <= \${tailEvents}
         ORDER BY run_id, id
      \`
    : [];
  const recentMessages = ids.length
    ? await sql\`
        SELECT *
          FROM (
            SELECT id, run_id, role, content, created_at,
                   row_number() OVER (PARTITION BY run_id ORDER BY id DESC) rn
              FROM agent_messages
             WHERE run_id = ANY(\${ids})
          ) x
         WHERE rn <= \${tailMessages}
         ORDER BY run_id, id
      \`
    : [];
  const inbox = ids.length
    ? await sql\`
        SELECT *
          FROM inbox_events
         WHERE target_run_id = ANY(\${ids})
            OR (source_kind = 'run' AND source_id = ANY(\${idStrings}))
         ORDER BY id
      \`
    : [];
  const timers = ids.length
    ? await sql\`SELECT * FROM run_timers WHERE run_id = ANY(\${ids}) ORDER BY id\`
    : [];
  console.log(JSON.stringify({
    root,
    ids,
    generatedAt: new Date().toISOString(),
    runs,
    runners,
    eventCounts,
    runnerEvents,
    msgCounts,
    recentEvents,
    recentMessages,
    inbox,
    timers,
  }));
} finally {
  await sql.end();
}
`;
}

function stripFlyNoise(stdout: string): string {
  const start = stdout.indexOf("{");
  if (start === -1) return stdout.trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return stdout.slice(start).trim();
}

async function queryLocal(root: number, tailEvents: number, tailMessages: number): Promise<Trace> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for local tracing. Use --fly to query the deployed DB.");
  }
  const script = queryScript(root, tailEvents, tailMessages);
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: process.env,
    maxBuffer: 200 * 1024 * 1024,
  });
  return { ...JSON.parse(stdout), source: "local" };
}

async function queryFly(root: number, args: Args): Promise<Trace> {
  const command = `node --input-type=module -e ${shellQuote(queryScript(root, args.tailEvents, args.tailMessages))}`;
  const { stdout } = await execFileAsync("flyctl", ["ssh", "console", "-a", args.app, "-C", command], {
    maxBuffer: 200 * 1024 * 1024,
  });
  return { ...JSON.parse(stripFlyNoise(stdout)), source: "fly" };
}

function summarize(trace: Trace): string {
  const lines = [
    `Run tree #${trace.root}: ${trace.ids.join(" -> ").replace(/ -> /g, ", ")}`,
    `Source: ${trace.source}, generated ${trace.generatedAt}`,
    "",
    "Runs:",
  ];
  for (const run of trace.runs) {
    const prefix = "  ".repeat(Number(run.depth ?? 0));
    const bits = [
      `#${run.id}`,
      `status=${run.status}`,
      `goal=${run.goal}`,
      run.task_id ? `task=${run.task_id}` : null,
      run.pr_url ? `pr=${run.pr_url}` : null,
      run.error ? `error=${String(run.error).split("\n")[0]}` : null,
    ].filter(Boolean);
    lines.push(`${prefix}- ${bits.join(" ")}`);
  }
  lines.push("", "Runner instances:");
  for (const r of trace.runners) {
    lines.push(
      `- #${r.run_id} state=${r.state} machine=${r.machine_id ?? "-"} volume=${r.volume_id ?? "-"} lastStarted=${r.last_started_at ?? "-"}`
    );
  }
  lines.push("", "Inbox/timers:");
  const pendingInbox = trace.inbox.filter((e) => e.status === "pending");
  const pendingTimers = trace.timers.filter((t) => t.status === "pending");
  lines.push(`- inbox total=${trace.inbox.length} pending=${pendingInbox.length}`);
  lines.push(`- timers total=${trace.timers.length} pending=${pendingTimers.length}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawRunId = args._[0];
  if (!rawRunId) usage();
  const runId = Number(rawRunId);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error(`Invalid run id: ${rawRunId}`);

  const trace = args.fly
    ? await queryFly(runId, args)
    : await queryLocal(runId, args.tailEvents, args.tailMessages);

  if (args.out) {
    const outPath = path.resolve(args.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(trace, null, 2));
    console.log(`Wrote ${outPath}`);
  }

  if (args.json) {
    console.log(JSON.stringify(trace, null, 2));
  } else {
    console.log(summarize(trace));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
