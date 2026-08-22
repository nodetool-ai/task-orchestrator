// argv → one command. Pure, so every shape an operator can type is covered by
// a test instead of by a manual run against a live server (PRD §6.5).
//
// The three interactive forms (`orch`, `orch "<goal>"`, `orch open <id>`) and
// the non-interactive verbs share one namespace, so the first word decides:
// a known verb is a verb, anything else is a goal.

/** The interactive forms, as app.tsx has always described them. */
import { orchColors, type ColorMode } from "../model/colors.js";

export type Cli =
  | { kind: "open"; id: number | null }
  | { kind: "new"; goal: string; persona: string | null }
  | { kind: "error"; message: string };

export type Command =
  // Interactive: hand the terminal to Ink.
  | { kind: "tui"; open: number | null }
  | { kind: "tui-new"; goal: string; persona: string | null }
  // Non-interactive verbs. `json` is carried by all of them: a verb with
  // nothing to list still answers `{"ok":true,…}` so a script never has to
  // special-case one of them.
  | { kind: "floor"; json: boolean }
  | { kind: "inbox"; json: boolean }
  | { kind: "tail"; id: number; json: boolean }
  | { kind: "say"; id: number; text: string; json: boolean }
  | { kind: "new"; persona: string; goal: string; json: boolean }
  | { kind: "spawn"; id: number; persona: string; arg: string; json: boolean }
  | { kind: "cancel"; id: number; json: boolean }
  /** Everything after `task`, verbatim — cli.ts owns its own argv. */
  | { kind: "task"; args: string[] }
  | { kind: "help" }
  | { kind: "error"; message: string };

/** Commands `runCommand` can execute. The rest need a process (Ink, or a
 *  child) and are dispatched by orch.tsx. */
export type CliCommand = Exclude<Command, { kind: "tui" } | { kind: "tui-new" } | { kind: "task" }>;

export function isCliCommand(cmd: Command): cmd is CliCommand {
  return cmd.kind !== "tui" && cmd.kind !== "tui-new" && cmd.kind !== "task";
}

export const USAGE = `orch — terminal cockpit for the task orchestrator

  orch                            open the last top-level run (TUI)
  orch "<goal>" [-p persona]      start a run and open it (TUI)
  orch open <id>                  open that run (TUI)

  orch floor [--json]             the run tree, one row per run
  orch inbox [--json]             what needs you
  orch tail <id> [--json]         follow a run's transcript until ^c
  orch say <id> "<text>"          message or answer a run
  orch new <persona> "<goal>"     start a run, print its id, detach
  orch spawn <id> <persona> <goal|T-id>
                                  ask that run to delegate
  orch cancel <id>                cancel a run and its subtree
  orch task …                     the cli.ts verbs, unchanged

  --ascii                         plain-ASCII glyphs and box drawing, anywhere
                                  before the verb (or ORCH_ASCII=1)
  --16color                       the six hues as ANSI colour names, for a
                                  terminal that cannot paint 24-bit
                                  (or ORCH_COLORS=16; the default is detected)

Exit codes: 0 ok, 1 user error, 2 server error. Data on stdout, notes on stderr.
Env: ORCH_URL (default http://localhost:3000), ORCH_TOKEN, ORCH_ASCII, ORCH_COLORS.`;

/**
 * `--ascii` and `--16color` are global, not per-verb: they say what the
 * terminal can draw, which is a property of the session and not of the
 * command. Stripping them here keeps every parser below unchanged — they still
 * refuse any dash-word they do not know, which is what makes a typo an error
 * rather than a goal.
 *
 * The scan stops at `--` (a message may legitimately contain `--ascii`) and at
 * `task`, whose argv belongs to cli.ts and is none of our business.
 *
 * `colors` is null when nothing was asked for, which is not the same as asking
 * for truecolor: the palette is detected from the environment then, and only
 * an explicit flag overrides that.
 */
export function takeGlobalFlags(
  argv: readonly string[],
  env: { ORCH_ASCII?: string | undefined; ORCH_COLORS?: string | undefined } = {},
): { ascii: boolean; colors: ColorMode | null; argv: string[] } {
  let ascii = asciiEnv(env.ORCH_ASCII);
  let colors = orchColors(env.ORCH_COLORS);
  const rest: string[] = [];
  let mine = true;
  for (const a of argv) {
    if (mine && a === "--ascii") {
      ascii = true;
      continue;
    }
    if (mine && (a === "--16color" || a === "--16colour")) {
      colors = "ansi16";
      continue;
    }
    if (a === "--" || a === "task") mine = false;
    rest.push(a);
  }
  return { ascii, colors, argv: rest };
}

/** ORCH_ASCII is a switch, so anything but an explicit off means on: a user
 *  who exported it at all wants the plain glyphs. */
export function asciiEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

const VERBS = new Set(["floor", "inbox", "tail", "say", "new", "spawn", "cancel", "open", "task", "help"]);

export function parseCli(argv: readonly string[]): Command {
  const first = argv[0];

  // Before anything else: cli.ts parses its own flags (including `--json`),
  // so nothing after `task` is ours to read.
  if (first === "task") return { kind: "task", args: argv.slice(1) };
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === undefined || !VERBS.has(first)) return fromTui(parseArgv(argv));

  const flags = takeFlags(argv.slice(1));
  if ("message" in flags) return { kind: "error", message: flags.message };
  const { json, rest } = flags;

  switch (first) {
    case "open": {
      // The one verb that is still interactive: `orch open` shares its name
      // with `/open` and stays the TUI, as it has been since M2.
      const id = runId(rest[0]);
      if (rest.length !== 1 || id === null) return usageError("orch open <id>", rest[0]);
      return { kind: "tui", open: id };
    }
    case "floor":
      if (rest.length > 0) return usageError("orch floor [--json]", rest[0]);
      return { kind: "floor", json };
    case "inbox":
      if (rest.length > 0) return usageError("orch inbox [--json]", rest[0]);
      return { kind: "inbox", json };
    case "tail": {
      const id = runId(rest[0]);
      if (rest.length !== 1 || id === null) return usageError("orch tail <id> [--json]", rest[0]);
      return { kind: "tail", id, json };
    }
    case "say": {
      const id = runId(rest[0]);
      if (id === null) return usageError('orch say <id> "<text>"', rest[0]);
      // An unquoted message arrives as several words; joining them is
      // friendlier than refusing, and quoting still round-trips exactly.
      const text = rest.slice(1).join(" ").trim();
      if (!text) return usageError('orch say <id> "<text>"');
      return { kind: "say", id, text, json };
    }
    case "new": {
      const persona = (rest[0] ?? "").trim();
      const goal = rest.slice(1).join(" ").trim();
      if (!persona || !goal) return usageError('orch new <persona> "<goal>"');
      return { kind: "new", persona, goal, json };
    }
    case "spawn": {
      const id = runId(rest[0]);
      if (id === null) return usageError("orch spawn <id> <persona> <goal|T-id>", rest[0]);
      const persona = (rest[1] ?? "").trim();
      const arg = rest.slice(2).join(" ").trim();
      if (!persona || !arg) return usageError("orch spawn <id> <persona> <goal|T-id>");
      return { kind: "spawn", id, persona, arg, json };
    }
    case "cancel": {
      const id = runId(rest[0]);
      if (rest.length !== 1 || id === null) return usageError("orch cancel <id>", rest[0]);
      return { kind: "cancel", id, json };
    }
    default:
      return { kind: "error", message: `unknown verb ${first}` };
  }
}

/** `orch` argv for the three TUI forms. Kept exported (and re-exported from
 *  app.tsx) because it is the shape the cockpit's own tests describe. */
export function parseArgv(argv: readonly string[]): Cli {
  const args = [...argv];
  if (args.length === 0) return { kind: "open", id: null };

  if (args[0] === "open") {
    if (args.length !== 2) return { kind: "error", message: "usage: orch open <id>" };
    const id = Number((args[1] ?? "").replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) return { kind: "error", message: `not a run id: ${args[1]}` };
    return { kind: "open", id };
  }

  const words: string[] = [];
  let persona: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-p" || a === "--persona") {
      const v = args[++i];
      if (v === undefined) return { kind: "error", message: `${a} needs a persona` };
      persona = v;
      continue;
    }
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown option ${a}` };
    words.push(a);
  }
  // An unquoted goal arrives as several words; joining them is friendlier
  // than refusing, and quoting still round-trips exactly.
  const goal = words.join(" ").trim();
  if (!goal) return { kind: "error", message: 'usage: orch "<goal>" [-p persona]' };
  return { kind: "new", goal, persona };
}

function fromTui(cli: Cli): Command {
  if (cli.kind === "open") return { kind: "tui", open: cli.id };
  if (cli.kind === "new") return { kind: "tui-new", goal: cli.goal, persona: cli.persona };
  return { kind: "error", message: cli.message };
}

/** `--json` anywhere after the verb; any other dash-word is a typo, and a
 *  typo that is silently treated as a goal or a message is worse than a
 *  refusal. `--` ends the options, so a message may start with a dash. */
function takeFlags(args: readonly string[]): { json: boolean; rest: string[] } | { message: string } {
  let json = false;
  const rest: string[] = [];
  let literal = false;
  for (const a of args) {
    if (literal) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      literal = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") return { message: `unknown option ${a}` };
    rest.push(a);
  }
  return { json, rest };
}

function usageError(usage: string, got?: string): Command {
  const what = got === undefined ? "" : ` — not "${got}"`;
  return { kind: "error", message: `usage: ${usage}${what}` };
}

function runId(word: string | undefined): number | null {
  if (word === undefined) return null;
  const n = Number(word.replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}
