import React from "react";
import { render } from "ink";
import { App } from "./app.js";

// Alternate screen so the cockpit owns the terminal and leaves it clean on exit.
const ALT_ON = "\x1b[?1049h\x1b[H";
const ALT_OFF = "\x1b[?1049l";
process.stdout.write(ALT_ON);
const app = render(<App />, { exitOnCtrlC: true });
app.waitUntilExit().finally(() => process.stdout.write(ALT_OFF));
