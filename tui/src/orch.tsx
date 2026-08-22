// The real binary: `npm run orch` / `orch`. Talks to a live server; this file
// is only a dispatcher — which of the three shapes was asked for, and how the
// process should end.
//
//   orch                        the last top-level run          (TUI)
//   orch "<goal>" [-p persona]  start a run, then open it       (TUI)
//   orch open <id>              open that run                   (TUI)
//   orch floor|inbox|tail|say|new|spawn|cancel                  (stdout)
//   orch task …                 the repo-root cli.ts, unchanged (child)
//   --ascii                     plain glyphs everywhere (also ORCH_ASCII=1)
//
// Everything the verbs decide lives in src/cli/ as pure functions over an
// injected client and injected writers, so the suite covers them without a
// process. What is left here is the part only a process can do: writing to the
// real stdio, catching ^c, owning the alternate screen, and exiting.

import React from "react";
import { render } from "ink";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { App, newRunInput, resolvePersona } from "./app.js";
import { createClient, UnauthorizedError } from "./api/client.js";
import { isCliCommand, parseCli, takeGlobalFlags } from "./cli/parse.js";
import { runCommand } from "./cli/run.js";
import { findRepoRoot, taskSpawn } from "./cli/task.js";

const url = process.env.ORCH_URL ?? "http://localhost:3000";
const client = createClient({ url, token: process.env.ORCH_TOKEN });

// Exit codes (PRD §6.5): 0 ok, 1 user error, 2 server error.
function die(message: string, code: 1 | 2): never {
  process.stderr.write(`orch: ${message}\n`);
  process.exit(code);
}

// `--ascii` (and ORCH_ASCII) is global, so it comes off argv before any verb
// parser sees it — see takeGlobalFlags for why the scan stops where it does.
const { ascii, argv } = takeGlobalFlags(process.argv.slice(2), process.env);
const cmd = parseCli(argv);

// ── orch task … ────────────────────────────────────────────────────────────
if (cmd.kind === "task") {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (root === null) die("orch task needs the repo checkout (no cli.ts above this file)", 1);
  const { command, args, cwd } = taskSpawn(root, cmd.args);
  // stdio inherited: cli.ts streams output and asks for confirmations, and a
  // captured pipe would break both. Its exit code becomes ours.
  const child = spawn(command, args, { stdio: "inherit", cwd });
  child.on("error", (err) => die(`could not run ${command} — ${err.message}`, 2));
  child.on("exit", (code, signal) => {
    // A child killed by a signal has no exit code; 128+n is the shell's own
    // convention for it, so `orch task` reports what `npm run task` would.
    process.exit(signal ? 128 + (signalNumber(signal) ?? 0) : (code ?? 1));
  });
}
// ── the non-interactive verbs ──────────────────────────────────────────────
else if (isCliCommand(cmd)) {
  // ^c ends a follow the way it ends any pipe: cleanly, exit 0. Nothing else
  // here is long-lived, so the handler is only ever felt by `orch tail`.
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  const code = await runCommand(cmd, {
    client,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    signal: stop.signal,
    ascii,
  });
  // exitCode rather than exit(): a piped stdout may still be draining, and a
  // hard exit truncates the last row.
  process.exitCode = code;
}
// ── the cockpit ────────────────────────────────────────────────────────────
else {
  // Probe before rendering: a 401 that lands after the alternate screen is up
  // is a cockpit full of empty panes. One line on stderr and a non-zero exit
  // is the honest answer, and it is scriptable.
  try {
    await client.overview();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      die(`unauthorized at ${url} — ${err.hint}`, 1);
    }
    // Anything else (server down, DNS) is survivable: the store retries and the
    // status line says what is happening.
    process.stderr.write(`orch: ${err instanceof Error ? err.message : String(err)} — starting anyway\n`);
  }

  // `orch "<goal>"` creates the run here rather than inside the cockpit: a bad
  // persona or a refused POST is a shell error with an exit code, not a notice
  // on a screen that is about to be torn down.
  let initial: number | null = cmd.kind === "tui" ? cmd.open : null;
  if (cmd.kind === "tui-new") {
    const personas = await client.personas().catch(() => []);
    const found = cmd.persona === null ? null : resolvePersona(personas, cmd.persona);
    if (found && found.id === null) die(found.notice, 1);
    const personaId = found === null ? null : found.id;
    const row = personaId === null ? null : (personas.find((p) => p.id === personaId) ?? null);
    try {
      const created = await client.createRun(newRunInput(cmd.goal, personaId, row));
      initial = created.id;
    } catch (err) {
      die(err instanceof Error ? err.message : String(err), 2);
    }
  }

  // Alternate screen so the cockpit owns the terminal and leaves it clean on exit.
  const ALT_ON = "\x1b[?1049h\x1b[H";
  const ALT_OFF = "\x1b[?1049l";
  process.stdout.write(ALT_ON);
  const app = render(<App client={client} initial={initial} baseUrl={url} ascii={ascii} />, {
    exitOnCtrlC: true,
  });
  app.waitUntilExit().finally(() => process.stdout.write(ALT_OFF));
}

/** The few signals a delegated CLI realistically dies on. */
function signalNumber(signal: NodeJS.Signals): number | null {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? null;
}
