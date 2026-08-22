// The real binary: `npm run orch`. Talks to a live server; the only thing it
// knows about the cockpit is which client to hand it, and which run to open.
//
//   orch                        the last top-level run
//   orch "<goal>" [-p persona]  start a run, then open it
//   orch open <id>              open that run
//
// The list verbs (floor, inbox, tail, say, …) arrive with M3.

import React from "react";
import { render } from "ink";
import { App, newRunInput, parseArgv, resolvePersona } from "./app.js";
import { createClient, UnauthorizedError } from "./api/client.js";

const url = process.env.ORCH_URL ?? "http://localhost:3000";
const client = createClient({ url, token: process.env.ORCH_TOKEN });

// Exit codes (PRD §6.5): 0 ok, 1 user error, 2 server error.
function die(message: string, code: 1 | 2): never {
  process.stderr.write(`orch: ${message}\n`);
  process.exit(code);
}

const cli = parseArgv(process.argv.slice(2));
if (cli.kind === "error") die(cli.message, 1);

// Probe before rendering: a 401 that lands after the alternate screen is up is
// a cockpit full of empty panes. One line on stderr and a non-zero exit is the
// honest answer, and it is scriptable.
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
let initial: number | null = cli.kind === "open" ? cli.id : null;
if (cli.kind === "new") {
  const personas = await client.personas().catch(() => []);
  const found = cli.persona === null ? null : resolvePersona(personas, cli.persona);
  if (found && found.id === null) die(found.notice, 1);
  const personaId = found === null ? null : found.id;
  const row = personaId === null ? null : (personas.find((p) => p.id === personaId) ?? null);
  try {
    const created = await client.createRun(newRunInput(cli.goal, personaId, row));
    initial = created.id;
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 2);
  }
}

// Alternate screen so the cockpit owns the terminal and leaves it clean on exit.
const ALT_ON = "\x1b[?1049h\x1b[H";
const ALT_OFF = "\x1b[?1049l";
process.stdout.write(ALT_ON);
const app = render(<App client={client} initial={initial} />, { exitOnCtrlC: true });
app.waitUntilExit().finally(() => process.stdout.write(ALT_OFF));
