// The real binary: `npm run orch`. Talks to a live server; the only thing it
// knows about the cockpit is which client to hand it.

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { createClient, UnauthorizedError } from "./api/client.js";

const url = process.env.ORCH_URL ?? "http://localhost:3000";
const client = createClient({ url, token: process.env.ORCH_TOKEN });

// Probe before rendering: a 401 that lands after the alternate screen is up is
// a cockpit full of empty panes. One line on stderr and a non-zero exit is the
// honest answer, and it is scriptable.
try {
  await client.overview();
} catch (err) {
  if (err instanceof UnauthorizedError) {
    process.stderr.write(`orch: unauthorized at ${url} — ${err.hint}\n`);
    process.exit(1);
  }
  // Anything else (server down, DNS) is survivable: the store retries and the
  // status line says what is happening.
  process.stderr.write(`orch: ${err instanceof Error ? err.message : String(err)} — starting anyway\n`);
}

// Alternate screen so the cockpit owns the terminal and leaves it clean on exit.
const ALT_ON = "\x1b[?1049h\x1b[H";
const ALT_OFF = "\x1b[?1049l";
process.stdout.write(ALT_ON);
const app = render(<App client={client} />, { exitOnCtrlC: true });
app.waitUntilExit().finally(() => process.stdout.write(ALT_OFF));
