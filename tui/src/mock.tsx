// The design surface: the same cockpit, fed by fake server fixtures. Runs
// offline with no server — this is how the layout gets reviewed.

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { takeGlobalFlags } from "./cli/parse.js";
import { applyColorMode } from "./theme.js";
import { createFakeClient } from "./data.js";

// The design surface honours --ascii too: reviewing the plain-glyph layout is
// the only way to see whether a column budget still adds up without unicode.
const { ascii, colors } = takeGlobalFlags(process.argv.slice(2), process.env);
// --16color too: the design surface is where the degraded palette gets looked
// at, and a 24-bit terminal can only see it by being told to.
if (colors !== null) applyColorMode(colors);

// Alternate screen so the cockpit owns the terminal and leaves it clean on exit.
const ALT_ON = "\x1b[?1049h\x1b[H";
const ALT_OFF = "\x1b[?1049l";
process.stdout.write(ALT_ON);
const app = render(<App client={createFakeClient()} ascii={ascii} />, { exitOnCtrlC: true });
app.waitUntilExit().finally(() => process.stdout.write(ALT_OFF));
