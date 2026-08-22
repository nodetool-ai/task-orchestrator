// argv is the only surface an operator can get wrong without a keyboard, so
// every shape of it — including the ones that must be refused — is described
// here rather than discovered against a live server.

import { describe, expect, it } from "vitest";
import { isCliCommand, parseCli, takeGlobalFlags, type Command } from "../../src/cli/parse.js";

const cmd = (...argv: string[]): Command => parseCli(argv);

describe("parseCli — the interactive forms", () => {
  it("keeps the three TUI shapes working", () => {
    expect(cmd()).toEqual({ kind: "tui", open: null });
    expect(cmd("open", "45")).toEqual({ kind: "tui", open: 45 });
    expect(cmd("open", "#45")).toEqual({ kind: "tui", open: 45 });
    expect(cmd("ship the CLI plan")).toEqual({ kind: "tui-new", goal: "ship the CLI plan", persona: null });
    expect(cmd("-p", "concierge", "ship it")).toEqual({ kind: "tui-new", goal: "ship it", persona: "concierge" });
  });

  it("joins an unquoted goal instead of refusing it", () => {
    expect(cmd("ship", "the", "plan")).toEqual({ kind: "tui-new", goal: "ship the plan", persona: null });
  });

  it("refuses a run id that is not one", () => {
    expect(cmd("open", "banana").kind).toBe("error");
    expect(cmd("open", "0").kind).toBe("error");
    expect(cmd("open").kind).toBe("error");
    expect(cmd("open", "1", "2").kind).toBe("error");
  });
});

describe("parseCli — the verbs", () => {
  it("lists with and without --json", () => {
    expect(cmd("floor")).toEqual({ kind: "floor", json: false });
    expect(cmd("floor", "--json")).toEqual({ kind: "floor", json: true });
    expect(cmd("inbox")).toEqual({ kind: "inbox", json: false });
    expect(cmd("inbox", "--json")).toEqual({ kind: "inbox", json: true });
    expect(cmd("tail", "44", "--json")).toEqual({ kind: "tail", id: 44, json: true });
  });

  it("takes the message, the goal and the spawn argument as the rest of the line", () => {
    expect(cmd("say", "45", "use", "pi")).toEqual({ kind: "say", id: 45, text: "use pi", json: false });
    expect(cmd("new", "planner", "ship the CLI")).toEqual({
      kind: "new",
      persona: "planner",
      goal: "ship the CLI",
      json: false,
    });
    expect(cmd("spawn", "43", "implementor", "T-0006")).toEqual({
      kind: "spawn",
      id: 43,
      persona: "implementor",
      arg: "T-0006",
      json: false,
    });
    expect(cmd("cancel", "#43")).toEqual({ kind: "cancel", id: 43, json: false });
  });

  it("refuses a missing or malformed argument", () => {
    for (const argv of [
      ["tail"],
      ["tail", "x"],
      ["say", "45"],
      ["say", "x", "hello"],
      ["new", "planner"],
      ["new"],
      ["spawn", "43", "implementor"],
      ["spawn", "43"],
      ["cancel"],
      ["cancel", "43", "44"],
      ["floor", "extra"],
    ]) {
      expect(parseCli(argv), argv.join(" ")).toMatchObject({ kind: "error" });
    }
  });

  it("refuses an unknown option rather than treating it as text", () => {
    expect(cmd("floor", "--jsonn")).toEqual({ kind: "error", message: "unknown option --jsonn" });
    expect(cmd("say", "45", "-x")).toMatchObject({ kind: "error" });
  });

  it("lets `--` start a message with a dash", () => {
    expect(cmd("say", "45", "--", "--not-a-flag")).toEqual({
      kind: "say",
      id: 45,
      text: "--not-a-flag",
      json: false,
    });
  });

  it("hands everything after `task` to cli.ts untouched, flags included", () => {
    expect(cmd("task", "list", "--json", "--state", "doing")).toEqual({
      kind: "task",
      args: ["list", "--json", "--state", "doing"],
    });
    expect(cmd("task")).toEqual({ kind: "task", args: [] });
  });

  it("answers help without touching the server", () => {
    expect(cmd("--help")).toEqual({ kind: "help" });
    expect(cmd("-h")).toEqual({ kind: "help" });
    expect(cmd("help")).toEqual({ kind: "help" });
  });
});

describe("isCliCommand", () => {
  // The dispatcher's whole job: a verb runs in-process against stdout, the
  // other three shapes need a renderer or a child process.
  it("separates what runCommand can execute from what needs a process", () => {
    expect(isCliCommand(cmd("floor"))).toBe(true);
    expect(isCliCommand(cmd("help"))).toBe(true);
    expect(isCliCommand(cmd("open", "x"))).toBe(true); // an error is printed, not rendered
    expect(isCliCommand(cmd())).toBe(false);
    expect(isCliCommand(cmd("a goal"))).toBe(false);
    expect(isCliCommand(cmd("task", "list"))).toBe(false);
  });
});

// `--ascii` says what the terminal can draw, so it is global rather than a
// per-verb flag — and stripping it must not disturb argv the parsers below
// still have to refuse or keep verbatim.
describe("takeGlobalFlags", () => {
  it("takes --ascii from anywhere before the verb's arguments", () => {
    expect(takeGlobalFlags(["--ascii", "floor"])).toEqual({ ascii: true, colors: null, argv: ["floor"] });
    expect(takeGlobalFlags(["floor", "--ascii", "--json"])).toEqual({
      ascii: true,
      colors: null,
      argv: ["floor", "--json"],
    });
    expect(takeGlobalFlags(["floor"])).toEqual({ ascii: false, colors: null, argv: ["floor"] });
  });

  it("takes --16color the same way, and leaves the palette undecided without it", () => {
    expect(takeGlobalFlags(["--16color", "floor"])).toEqual({ ascii: false, colors: "ansi16", argv: ["floor"] });
    expect(takeGlobalFlags(["--16colour", "--ascii"])).toEqual({ ascii: true, colors: "ansi16", argv: [] });
    // null, not "truecolor": nothing was asked for, so the environment decides.
    expect(takeGlobalFlags(["floor"]).colors).toBe(null);
    expect(takeGlobalFlags(["floor"], { ORCH_COLORS: "16" }).colors).toBe("ansi16");
    expect(takeGlobalFlags(["floor"], { ORCH_COLORS: "truecolor" }).colors).toBe("truecolor");
    expect(takeGlobalFlags(["floor"], { ORCH_COLORS: "nonsense" }).colors).toBe(null);
    expect(takeGlobalFlags(["say", "1", "--", "--16color"]).colors).toBe(null);
  });

  it("leaves it alone after `--` and after `task`", () => {
    expect(takeGlobalFlags(["say", "1", "--", "--ascii"])).toEqual({
      ascii: false,
      colors: null,
      argv: ["say", "1", "--", "--ascii"],
    });
    expect(takeGlobalFlags(["task", "list", "--ascii"])).toEqual({
      ascii: false,
      colors: null,
      argv: ["task", "list", "--ascii"],
    });
  });

  it("honours ORCH_ASCII, and lets an explicit off mean off", () => {
    expect(takeGlobalFlags(["floor"], { ORCH_ASCII: "1" }).ascii).toBe(true);
    expect(takeGlobalFlags(["floor"], { ORCH_ASCII: "yes" }).ascii).toBe(true);
    expect(takeGlobalFlags(["floor"], { ORCH_ASCII: "0" }).ascii).toBe(false);
    expect(takeGlobalFlags(["floor"], { ORCH_ASCII: "" }).ascii).toBe(false);
    expect(takeGlobalFlags(["floor"], {}).ascii).toBe(false);
  });

  // The stripped argv is what every parser below sees, so the shapes they
  // already know must survive the pass untouched.
  it("hands the verb parsers an argv they still understand", () => {
    const { ascii, argv } = takeGlobalFlags(["--ascii", "tail", "44", "--json"]);
    expect(ascii).toBe(true);
    expect(parseCli(argv)).toEqual({ kind: "tail", id: 44, json: true });
  });
});
