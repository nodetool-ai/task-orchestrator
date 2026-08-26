// The keyboard and command surface lives inside an Ink component, and this
// repo has no component harness — so every decision that is not about
// painting is a pure function exported from app.tsx, and this file is the
// only place those decisions are checked. What matters here is the wording
// the agent parses (`/spawn`), the argv the shell hands us, and the two
// counts an operator acts on: the tab cycle and the live children a cancel
// would kill.

import { describe, expect, it } from "vitest";
import {
  budgetLabel,
  confirmLine,
  glyphs,
  liveKids,
  newRunInput,
  nextInCycle,
  openCommand,
  openUrlFor,
  parseArgv,
  parseBudget,
  resolvePersona,
  spawnMessage,
} from "../../src/app.js";
import { completeCommand } from "../../src/views/prompt.js";

const PERSONAS = [
  { id: "implementor", name: "Implementor", budgetMaxTurns: 40, budgetMaxSeconds: null },
  { id: "reviewer", name: "Reviewer", budgetMaxTurns: null, budgetMaxSeconds: null },
];

describe("resolvePersona", () => {
  it("matches an id or a display name, case-insensitively", () => {
    expect(resolvePersona(PERSONAS, "implementor").id).toBe("implementor");
    expect(resolvePersona(PERSONAS, "Reviewer").id).toBe("reviewer");
    expect(resolvePersona(PERSONAS, "  IMPLEMENTOR ").id).toBe("implementor");
  });

  it("names the valid personas when the typed one is unknown", () => {
    const r = resolvePersona(PERSONAS, "architekt");
    expect(r.id).toBeNull();
    expect(r.notice).toContain("architekt");
    expect(r.notice).toContain("implementor, reviewer");
    expect(r.notice?.split("\n")).toHaveLength(1);
  });

  it("asks for a persona when nothing was typed", () => {
    expect(resolvePersona(PERSONAS, "").id).toBeNull();
  });

  // The list is empty until ensurePersonas() lands; refusing to start a run
  // because of a cold cache would be worse than letting the server decide.
  it("passes the name through while the persona list is cold", () => {
    expect(resolvePersona([], "implementor")).toEqual({ id: "implementor", notice: null });
  });
});

describe("newRunInput", () => {
  it("starts a chat run without a working copy", () => {
    // cwdStrategy `none` is load-bearing: the server rejects a non-deferred
    // worktree run with no taskId.
    expect(newRunInput("ship it", null)).toEqual({ goal: "ship it", cwdStrategy: "none" });
  });

  it("carries only the persona budgets that are set", () => {
    expect(newRunInput("ship it", "implementor", PERSONAS[0])).toEqual({
      goal: "ship it",
      personaId: "implementor",
      cwdStrategy: "none",
      budget: { maxTurns: 40 },
    });
    expect(newRunInput("ship it", "reviewer", PERSONAS[1])).not.toHaveProperty("budget");
  });
});

describe("nextInCycle", () => {
  it("walks the list and wraps", () => {
    expect(nextInCycle([7, 8, 9], null)).toBe(7);
    expect(nextInCycle([7, 8, 9], 7)).toBe(8);
    expect(nextInCycle([7, 8, 9], 9)).toBe(7);
  });

  it("restarts at the head when the chip points somewhere no longer waiting", () => {
    expect(nextInCycle([7, 8], 42)).toBe(7);
  });

  it("has nothing to address when nobody waits", () => {
    expect(nextInCycle([], null)).toBeNull();
    expect(nextInCycle([], 7)).toBeNull();
  });
});

describe("spawnMessage", () => {
  // Fixed wording: the orchestrator prompt recognises these two sentences.
  it("names the task when the argument is a task id", () => {
    expect(spawnMessage("reviewer", "T-tui-08")).toBe(
      "Spawn a reviewer sub-agent for task T-tui-08 using the spawn tool.",
    );
    expect(spawnMessage("reviewer", "t-42")).toContain("for task t-42");
  });

  it("passes anything else through as a goal", () => {
    expect(spawnMessage("implementor", "wire the floor up")).toBe(
      "Spawn a implementor sub-agent using the spawn tool with this goal: wire the floor up",
    );
    // A goal that merely starts with T- is not a task id.
    expect(spawnMessage("implementor", "T-shirt sizing please")).toContain("with this goal:");
  });
});

describe("liveKids", () => {
  const subtree = [
    { id: 1, status: "running" as const },
    { id: 2, status: "running" as const },
    { id: 3, status: "done" as const },
    { id: 4, status: "parked" as const },
    { id: 5, status: "idle" as const },
  ];

  it("counts live descendants, never the run itself", () => {
    expect(liveKids(subtree, 1)).toBe(2); // #2 running, #4 parked
    expect(liveKids([{ id: 1, status: "running" }], 1)).toBe(0);
  });
});

describe("confirmLine", () => {
  it("says what dies and which key confirms, on one line", () => {
    expect(confirmLine(45, 3, "c")).toBe("cancel #45 and 3 live children? c again to confirm · esc to abort");
    expect(confirmLine(45, 1, "↵")).toContain("1 live child?");
    expect(confirmLine(45, 2, "c").split("\n")).toHaveLength(1);
  });
});

describe("parseArgv", () => {
  it("opens the last top-level run with no arguments", () => {
    expect(parseArgv([])).toEqual({ kind: "open", id: null });
  });

  it("opens a run by id, with or without the #", () => {
    expect(parseArgv(["open", "45"])).toEqual({ kind: "open", id: 45 });
    expect(parseArgv(["open", "#45"])).toEqual({ kind: "open", id: 45 });
  });

  it("rejects an open that is not a run id", () => {
    expect(parseArgv(["open"]).kind).toBe("error");
    expect(parseArgv(["open", "abc"]).kind).toBe("error");
    expect(parseArgv(["open", "0"]).kind).toBe("error");
    expect(parseArgv(["open", "45", "46"]).kind).toBe("error");
  });

  it("takes a goal, with the persona either side of it", () => {
    expect(parseArgv(["ship the cockpit"])).toEqual({
      kind: "new",
      goal: "ship the cockpit",
      persona: null,
    });
    expect(parseArgv(["ship it", "-p", "implementor"])).toEqual({
      kind: "new",
      goal: "ship it",
      persona: "implementor",
    });
    expect(parseArgv(["--persona", "reviewer", "look at #45"])).toEqual({
      kind: "new",
      goal: "look at #45",
      persona: "reviewer",
    });
  });

  // An unquoted goal arrives word by word; joining is friendlier than a usage
  // error, and a quoted goal still round-trips exactly.
  it("joins an unquoted goal", () => {
    expect(parseArgv(["ship", "the", "cockpit"])).toMatchObject({ goal: "ship the cockpit" });
  });

  it("refuses a dangling flag, an unknown flag, and an empty goal", () => {
    expect(parseArgv(["-p"]).kind).toBe("error");
    expect(parseArgv(["goal", "-x"]).kind).toBe("error");
    expect(parseArgv(["-p", "implementor"]).kind).toBe("error");
    expect(parseArgv(["   "]).kind).toBe("error");
  });
});

// ── /budget ────────────────────────────────────────────────────────────────
// The one command where a misread argument costs money: "5" meaning five
// dollars instead of five turns caps a run two orders of magnitude tighter
// than the operator asked for, so every shape they can type is nailed down.

describe("parseBudget", () => {
  it("reads a dollar cap from the shapes a `$` marks", () => {
    expect(parseBudget("$5")).toEqual({ budget: { usd: 5 }, notice: null });
    expect(parseBudget("5usd")).toEqual({ budget: { usd: 5 }, notice: null });
    expect(parseBudget("5 USD")).toEqual({ budget: { usd: 5 }, notice: null });
    expect(parseBudget(" $2.50 ")).toEqual({ budget: { usd: 2.5 }, notice: null });
  });

  it("reads a turn cap, a bare number included", () => {
    expect(parseBudget("20 turns")).toEqual({ budget: { turns: 20 }, notice: null });
    expect(parseBudget("20turn")).toEqual({ budget: { turns: 20 }, notice: null });
    expect(parseBudget("20t")).toEqual({ budget: { turns: 20 }, notice: null });
    expect(parseBudget("20")).toEqual({ budget: { turns: 20 }, notice: null });
  });

  it("refuses nothing, zero, a fraction of a turn, and anything unparseable", () => {
    for (const arg of ["", "   ", "0", "$0", "-5", "2.5", "2.5 turns", "lots", "$", "5 dollars"]) {
      const r = parseBudget(arg);
      expect(r.budget).toBeNull();
      expect(r.notice?.split("\n")).toHaveLength(1);
    }
  });
});

describe("budgetLabel", () => {
  it("says nothing when the run inherits both caps", () => {
    expect(budgetLabel({ budgetUsd: null, budgetTurns: null })).toBe("");
  });

  it("names whichever caps are set", () => {
    expect(budgetLabel({ budgetUsd: 5, budgetTurns: null })).toBe("$5 cap");
    expect(budgetLabel({ budgetUsd: null, budgetTurns: 20 })).toBe("20t cap");
    expect(budgetLabel({ budgetUsd: 2.5, budgetTurns: 20 })).toBe("$2.5/20t cap");
  });
});

// ── the `o` key ────────────────────────────────────────────────────────────

describe("openUrlFor", () => {
  it("prefers the run's PR", () => {
    const url = "https://github.com/acme/orch/pull/12";
    expect(openUrlFor({ id: 45, prUrl: url }, "http://localhost:3000")).toBe(url);
  });

  it("falls back to the run's own page, trailing slashes and all", () => {
    expect(openUrlFor({ id: 45, prUrl: null }, "http://localhost:3000")).toBe(
      "http://localhost:3000/runs/45",
    );
    expect(openUrlFor({ id: 45, prUrl: "  " }, "https://orch.example.com//")).toBe(
      "https://orch.example.com/runs/45",
    );
  });
});

describe("openCommand", () => {
  it("uses the launcher each platform actually ships", () => {
    expect(openCommand("darwin", "u")).toEqual({ command: "open", args: ["u"] });
    expect(openCommand("linux", "u")).toEqual({ command: "xdg-open", args: ["u"] });
    expect(openCommand("freebsd", "u")).toEqual({ command: "xdg-open", args: ["u"] });
  });

  // The empty argument is `start`'s window title. Without it the url becomes
  // the title and no browser opens.
  it("keeps the empty title argument on Windows", () => {
    expect(openCommand("win32", "u")).toEqual({ command: "cmd", args: ["/c", "start", "", "u"] });
  });
});

// ── --ascii ────────────────────────────────────────────────────────────────

describe("glyphs", () => {
  it("swaps every mark for a single-column ASCII one", () => {
    const a = glyphs(true);
    const u = glyphs(false);
    // `border` is the odd one out: Ink draws the palette's frame itself, so
    // the fallback is the name of a border style rather than a character.
    // `spinner` is a list of frames, checked on its own below.
    const marks = Object.entries(a).filter(
      ([k]) => k !== "status" && k !== "move" && k !== "border" && k !== "spinner",
    );
    for (const [key, mark] of marks) {
      expect(typeof mark).toBe("string");
      expect(mark, key).toMatch(/^[\x20-\x7e]$/);
      expect(mark).not.toBe((u as unknown as Record<string, string>)[key]);
    }
    for (const [state, mark] of Object.entries(a.status)) {
      expect(mark, state).toMatch(/^[\x20-\x7e]$/);
    }
    // The spinner animates in place, so a two-column frame would make the
    // line it sits on jitter by a column every 120 ms.
    expect(a.spinner.length).toBeGreaterThan(1);
    for (const frame of a.spinner) expect(frame).toMatch(/^[\x20-\x7e]$/);
    for (const frame of u.spinner) expect(frame).toHaveLength(1);
  });

  it("falls the box drawing back to | and -", () => {
    expect(glyphs(true).border).toBe("classic");
    expect(glyphs(false).border).toBe("round");
    expect(glyphs(true).rule).toBe("-");
    expect(glyphs(true).rail).toBe("|");
    expect(glyphs(true).bar).toBe("|");
    expect(glyphs(false).rule).toBe("─");
    expect(glyphs(false).rail).toBe("│");
  });
});

describe("completeCommand", () => {
  it("completes an unambiguous prefix with the space that invites arguments", () => {
    expect(completeCommand("/flo")).toBe("/floor ");
    expect(completeCommand("/o")).toBe("/open ");
    expect(completeCommand("/new")).toBe("/new "); // already whole: still wants its space
  });

  it("completes a shared prefix while the word is still ambiguous", () => {
    expect(completeCommand("/s")).toBeNull(); // /say and /spawn share only what is typed
    expect(completeCommand("/sp")).toBe("/spawn ");
  });

  it("stands aside once there are arguments or nothing to add", () => {
    expect(completeCommand("/model sonnet")).toBeNull(); // tab belongs to model completion
    expect(completeCommand("/floor ")).toBeNull();
    expect(completeCommand("/zzz")).toBeNull();
    expect(completeCommand("hello")).toBeNull(); // plain words are for agents
  });
});
