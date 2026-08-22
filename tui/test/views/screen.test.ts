// T-tui-13's "manual pass at 80×24, 100×30 and 160×50" as arithmetic. There
// is no TTY in the suite, so instead of looking at three terminals we assert
// the property a look would have been checking: nothing any region produces
// is wider than the columns it was given, and the vertical budget adds up to
// the rows there are.
//
// Every case runs under both glyph tables, because an ASCII fallback that is
// not one column wide would break the arithmetic without breaking a type.

import { describe, expect, it } from "vitest";
import { buildForest, floorGroups, type Forest } from "../../src/model/forest.js";
import { framesFromMessages } from "../../src/model/frames.js";
import { toInboxItems } from "../../src/model/inbox.js";
import { buildPalette } from "../../src/model/palette.js";
import { statusWord } from "../../src/model/status.js";
import { age, usd } from "../../src/model/time.js";
import { glyphs, type Glyphs } from "../../src/model/glyphs.js";
import type { RunIndexRow } from "../../src/api/types.js";
import { globalInboxRows, messageRows, planSummaries, runIndexRows, taskSummaries } from "../../src/data.js";
import { COMMANDS } from "../../src/views/prompt.js";
import {
  chatHeaderEmpty,
  fitKeys,
  keysWidth,
  layoutChatHeader,
  layoutFloorHead,
  layoutHelp,
  layoutInboxHead,
  layoutInboxRow,
  layoutPalette,
  layoutPaletteRow,
  layoutPending,
  layoutRow,
  rosterRowWidth,
  rosterWindow,
  screenLayout,
  type KeyHint,
} from "../../src/views/layout.js";
import { lineWidth, moreLine, transcriptLines } from "../../src/views/transcript.js";

const SIZES: [cols: number, rows: number][] = [
  [80, 24],
  [100, 30],
  [160, 50],
];

const TABLES: [name: string, g: Glyphs][] = [
  ["unicode", glyphs(false)],
  ["ascii", glyphs(true)],
];

const NOW = Date.now();

// The mock fixtures are the shipped design story; the adversarial rows are
// everything an operator can actually put in front of them — a four-digit run
// id, a persona nobody shortened, a title from a task tracker, ten levels of
// delegation and a five-figure spend.
const LONG_TITLE =
  "T-0007 end-to-end coverage for the acceptance criteria of the terminal cockpit, including the rail";
const LONG_PERSONA = "senior-implementor-with-a-long-name";

function seed(over: Partial<RunIndexRow> & { id: number }): RunIndexRow {
  return {
    goal: LONG_TITLE,
    status: "running",
    origin: "task",
    title: LONG_TITLE,
    taskId: "T-0007",
    taskTitle: LONG_TITLE,
    planId: "P-cli",
    planTitle: "Task orchestrator CLI",
    repoId: null,
    repoName: null,
    parentRunId: null,
    prUrl: "https://github.com/acme/task-orchestrator/pull/31245",
    model: "claude-opus-4-1-20250805",
    budgetMaxUsd: 12.5,
    budgetMaxTurns: 200,
    totalCostUsd: 1234.56,
    error: null,
    startedAt: new Date(NOW - 400 * 24 * 3600_000).toISOString(),
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 3,
    personaId: LONG_PERSONA,
    ...over,
  } as RunIndexRow;
}

/** Ten levels deep, so the branch prefix alone is twenty columns. */
const ADVERSARIAL: RunIndexRow[] = Array.from({ length: 10 }, (_, i) =>
  seed({ id: 1230 + i, parentRunId: i === 0 ? null : 1229 + i }),
);

const FIXTURES: [name: string, forest: Forest][] = [
  ["mock", buildForest(runIndexRows)],
  ["adversarial", buildForest(ADVERSARIAL)],
];

const INBOX = [
  ...toInboxItems(globalInboxRows),
  ...toInboxItems([
    {
      ...(globalInboxRows[0] as (typeof globalInboxRows)[number]),
      id: "long",
      runId: 1234,
      personaId: LONG_PERSONA,
      personaName: LONG_PERSONA,
      text: LONG_TITLE,
    },
  ]),
];

const FRAMES = framesFromMessages(messageRows);

describe("screenLayout", () => {
  it("fits the vertical budget at every supported size", () => {
    for (const [cols, rows] of SIZES) {
      for (const rail of [false, true]) {
        for (const help of [0, 1, COMMANDS.length]) {
          for (const pending of [false, true]) {
            const s = screenLayout(cols, rows, { rail, help, pending });
            // header + hair + status line are the three the main column always
            // paints; the rest is the transcript and the composer.
            expect(3 + s.promptH + s.bodyH, `${cols}x${rows}`).toBeLessThanOrEqual(rows);
            expect(s.bodyH).toBeGreaterThanOrEqual(3);
            expect(s.helpShown).toBeLessThanOrEqual(help);
            expect(s.railW + (s.railW ? 1 : 0) + s.mainW).toBe(cols);
          }
        }
      }
    }
  });

  it("hides the rail below 110 columns and keeps the main pane whole", () => {
    expect(screenLayout(80, 24, { rail: true }).railW).toBe(0);
    expect(screenLayout(80, 24, { rail: true }).mainW).toBe(80);
    expect(screenLayout(100, 30, { rail: true }).railW).toBe(0);
    expect(screenLayout(160, 50, { rail: true }).railW).toBe(38);
    expect(screenLayout(160, 50, { rail: true }).mainW).toBe(121);
    expect(screenLayout(160, 50, { rail: false }).mainW).toBe(160);
  });

  it("drops command help before it drops the transcript", () => {
    // A ten-line help list under a three-line transcript is the wrong trade,
    // so on a short terminal the help is what gives way.
    const short = screenLayout(80, 12, { rail: false, help: COMMANDS.length, pending: true });
    expect(short.bodyH).toBe(3);
    expect(short.helpShown).toBeLessThan(COMMANDS.length);
    expect(3 + short.promptH + short.bodyH).toBeLessThanOrEqual(12);
  });
});

describe("no region overflows its width", () => {
  for (const [cols, rows] of SIZES) {
    for (const [table, g] of TABLES) {
      describe(`${cols}x${rows} ${table}`, () => {
        // Both rail states: with it, the main pane is 121 columns at 160 and
        // the rail is 37; without it the pane is the whole terminal.
        const screens = [
          screenLayout(cols, rows, { rail: false, help: COMMANDS.length, pending: true }),
          screenLayout(cols, rows, { rail: true, help: COMMANDS.length, pending: true }),
        ];

        it("floor rows and the roster", () => {
          for (const s of screens) {
            for (const [name, forest] of FIXTURES) {
              const { live, rest } = floorGroups(forest, g);
              for (const row of [...live, ...rest]) {
                const cost = usd(forest.subtreeCost(row.run.id));
                const cells = layoutRow({
                  prefix: row.prefix,
                  id: row.run.id,
                  persona: row.run.persona,
                  title: row.run.title,
                  pr: row.run.pr,
                  status: statusWord(row.run.status),
                  age: age(row.run.startedAt, NOW),
                  cost,
                  width: s.mainW,
                  glyphs: g,
                });
                expect(cells.total, `${name} #${row.run.id}`).toBeLessThanOrEqual(s.mainW);
                // The id is the one cell that must never be clipped: `#123` in
                // place of `#1234` is a wrong row, not a narrow one.
                expect(cells.id.trim()).toBe(`#${row.run.id}`);

                if (s.railW === 0) continue;
                const rail = layoutRow({
                  prefix: row.prefix,
                  id: row.run.id,
                  persona: row.run.persona,
                  title: row.run.title,
                  pr: row.run.pr,
                  status: statusWord(row.run.status),
                  age: age(row.run.startedAt, NOW),
                  cost,
                  width: rosterRowWidth(s.railW - 1),
                  compact: true,
                  glyphs: g,
                });
                // The cursor column and the rail's own padding sit left of it,
                // and the rail's separator column left of that.
                expect(1 + 1 + rail.total + 1).toBeLessThanOrEqual(s.railW);
              }
            }
          }
        });

        it("the roster's vertical budget", () => {
          const { shown, more } = rosterWindow(40, rows);
          // header, its blank line, the cost footer, and the "+n more" tally.
          expect(shown + (more > 0 ? 1 : 0) + 3).toBeLessThanOrEqual(rows);
        });

        it("needs-you rows and heading", () => {
          for (const s of screens) {
            for (const it of INBOX) {
              const cells = layoutInboxRow({
                mark: g.flag,
                runId: it.runId,
                persona: it.persona,
                label: "review",
                text: it.text,
                age: age(it.at, NOW),
                width: s.mainW,
                glyphs: g,
              });
              expect(cells.total).toBeLessThanOrEqual(s.mainW);
              expect(cells.id.trim()).toBe(`#${it.runId}`);
            }
            const head = layoutInboxHead({
              count: 12345,
              width: s.mainW,
              glyphs: g,
              keys: [
                [g.move, "move"],
                [g.enter, "answer / open"],
                ["o", "open"],
                ["d", "dismiss"],
                ["esc", "back"],
              ],
            });
            expect(head.total).toBeLessThanOrEqual(s.mainW);
          }
        });

        it("the floor heading, hints and all", () => {
          for (const s of screens) {
            const head = layoutFloorHead({
              live: 128,
              needsYou: 12,
              today: usd(12345.67),
              width: s.mainW,
              glyphs: g,
              keys: [
                [g.enter, "talk"],
                ["o", "open"],
                ["c", "cancel"],
                ["n", "new"],
                ["esc", "back"],
              ],
            });
            expect(head.total).toBeLessThanOrEqual(s.mainW);
          }
        });

        it("the chat header", () => {
          for (const s of screens) {
            for (const [name, forest] of FIXTURES) {
              for (const run of forest.runs) {
                const parent = forest.ancestors(run.id)[0] ?? null;
                const cells = layoutChatHeader({
                  persona: run.persona,
                  id: run.id,
                  title: run.title,
                  crumb: parent ? `${parent.persona} #${parent.id} ${g.crumb} ` : "",
                  right: `12m · 9 agents · ${run.model ?? "claude-opus-4-1-20250805"} · $12.5/200t cap · ${usd(1234.56)}`,
                  width: s.mainW,
                  glyphs: g,
                });
                expect(cells.total, `${name} #${run.id}`).toBeLessThanOrEqual(s.mainW);
              }
            }
            expect(chatHeaderEmpty(s.mainW, g).length).toBeLessThanOrEqual(s.mainW);
          }
        });

        it("transcript lines, traced and not", () => {
          for (const s of screens) {
            for (const [name, forest] of FIXTURES) {
              for (const trace of [false, true]) {
                const lines = transcriptLines(FRAMES, {
                  forest,
                  width: s.mainW,
                  trace,
                  selfId: 42,
                  g,
                });
                for (const l of lines) {
                  expect(lineWidth(l), `${name} ${l.key}`).toBeLessThanOrEqual(s.mainW);
                }
              }
            }
            expect(moreLine(1234, s.mainW, g).length).toBeLessThanOrEqual(s.mainW);
          }
        });

        it("the jump palette", () => {
          for (const s of screens) {
            const box = layoutPalette(s.mainW);
            expect(box.width).toBeLessThanOrEqual(s.mainW);
            // Border and paddingX take two columns on each side.
            expect(box.inner + 4).toBeLessThanOrEqual(box.width);
            expect(8 + box.queryW + 1).toBeLessThanOrEqual(box.inner);
            const items = buildPalette(
              [...(FIXTURES[1]?.[1].runs ?? []), ...(FIXTURES[0]?.[1].runs ?? [])],
              taskSummaries,
              planSummaries,
            );
            for (const p of items) {
              expect(layoutPaletteRow(p, box, g).total).toBeLessThanOrEqual(box.inner);
            }
          }
        });

        it("the composer: help, the needs-you nudge and the key hints", () => {
          for (const s of screens) {
            for (const c of layoutHelp(COMMANDS, s.mainW, g)) {
              // Two columns of indent before the command column.
              expect(2 + c.cmd.length + c.help.length).toBeLessThanOrEqual(s.mainW);
            }
            for (const count of [1, 12345]) {
              const parts = layoutPending(count, s.mainW, g);
              expect(parts.reduce((n, p) => n + p.length, 0)).toBeLessThanOrEqual(s.mainW);
            }
            const keys: KeyHint[] = [
              [g.enter, "send"],
              ["/", "commands"],
              ["tab", "answer agent"],
              ["^k", "jump"],
              ["^f", "floor"],
              ["^n", "needs you"],
              ["^b", "rail"],
            ];
            expect(keysWidth(fitKeys(keys, s.mainW))).toBeLessThanOrEqual(s.mainW);
          }
        });
      });
    }
  }
});

// 80 columns is the contract (PRD §6.2), so the hints an operator is meant to
// learn the cockpit from have to survive it whole.
describe("at exactly 80 columns", () => {
  for (const [table, g] of TABLES) {
    it(`keeps every composer hint on screen (${table})`, () => {
      const keys: KeyHint[] = [
        [g.enter, "send"],
        ["/", "commands"],
        ["tab", "answer agent"],
        ["^k", "jump"],
        ["^f", "floor"],
        ["^n", "needs you"],
        ["^b", "rail"],
      ];
      expect(fitKeys(keys, 80)).toHaveLength(keys.length);
    });

    it(`keeps a top-level floor row's every column (${table})`, () => {
      const cells = layoutRow({
        prefix: "",
        id: 1234,
        persona: "implementor",
        title: "T-0007 end-to-end against acceptance criteria",
        pr: { number: 312, ci: "pass" },
        status: "running",
        age: "12m",
        cost: "$1.20",
        width: 80,
        glyphs: g,
      });
      expect(cells.total).toBe(80);
      for (const cell of [cells.id, cells.persona, cells.title, cells.pr, cells.status, cells.age, cells.cost]) {
        expect(cell).not.toBe("");
      }
    });
  }
});

// Narrower than anything supported, but a terminal can be dragged there and
// the cockpit must not paint outside the box while it happens.
describe("below the supported sizes", () => {
  it("never overflows, down to a single column", () => {
    const g = glyphs(true);
    const forest = FIXTURES[1]?.[1] as Forest;
    for (let w = 1; w <= 80; w++) {
      const box = layoutPalette(w);
      expect(box.width).toBeLessThanOrEqual(w);
      expect(layoutPaletteRow({ kind: "task", id: "T-0007", label: LONG_TITLE }, box, g).total).toBeLessThanOrEqual(
        box.inner,
      );
      expect(
        layoutInboxRow({
          mark: g.flag,
          runId: 1234,
          persona: LONG_PERSONA,
          label: "review",
          text: LONG_TITLE,
          age: "400d",
          width: w,
          glyphs: g,
        }).total,
      ).toBeLessThanOrEqual(w);
      expect(
        layoutChatHeader({
          persona: LONG_PERSONA,
          id: 1234,
          title: LONG_TITLE,
          crumb: `${LONG_PERSONA} #1233 ${g.crumb} `,
          right: "12m · 9 agents · claude-opus-4-1-20250805 · $12.5/200t cap · $1234.56",
          width: w,
          glyphs: g,
        }).total,
      ).toBeLessThanOrEqual(w);
      // The frame builders stop shrinking at a four-column clip, so below
      // eighteen columns — less than a quarter of the narrowest supported
      // terminal — a transcript line can be wider than the pane. Nothing else
      // has a floor like that.
      if (w >= 18) {
        for (const l of transcriptLines(FRAMES, { forest, width: w, trace: true, selfId: 42, g })) {
          expect(lineWidth(l), `${w} ${l.key}`).toBeLessThanOrEqual(w);
        }
      }
      expect(layoutPending(3, w, g).reduce((n, p) => n + p.length, 0)).toBeLessThanOrEqual(w);
      expect(chatHeaderEmpty(w, g).length).toBeLessThanOrEqual(w);
    }
  });
});
