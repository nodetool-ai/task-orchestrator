import React from "react";
import { Box, Text } from "ink";
import type { ModelOption } from "../model/models.js";
import { C, Hair, Keys, useGlyphs } from "../theme.js";
import { fitKeys, layoutCompletions, layoutHelp, layoutPending, type KeyHint } from "./layout.js";

// The commands the cockpit can actually honour today (PRD §6.4). M2 added the
// three that write: /new, /spawn and /cancel; M4 added /model and /budget,
// which patch the open run and are listed now that they do something.
export const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/floor", help: "all agents as a tree" },
  { cmd: "/inbox", help: "what needs you" },
  { cmd: "/new", help: "start an agent  /new implementor <goal>" },
  { cmd: "/open", help: "look at a run  /open #45" },
  { cmd: "/say", help: "message another run  /say #45 try the fix" },
  { cmd: "/spawn", help: "ask this agent to delegate  /spawn reviewer T-42" },
  { cmd: "/cancel", help: "stop this run and its live children" },
  { cmd: "/model", help: "retune this run  /model claude-sonnet-4-6" },
  { cmd: "/budget", help: "cap this run  /budget $5  ·  /budget 20 turns" },
  { cmd: "/trace", help: "toggle the full tool trace" },
  { cmd: "/quit", help: "leave; agents keep running" },
];

export function matchCommands(input: string) {
  if (!input.startsWith("/")) return [];
  const head = input.split(" ")[0];
  if (input.includes(" ")) return COMMANDS.filter((c) => c.cmd === head);
  return COMMANDS.filter((c) => c.cmd.startsWith(head));
}

/**
 * What `tab` makes of a half-typed command word. One match completes it with
 * the trailing space that invites the arguments — even a word typed in full,
 * which otherwise could only end by addressing an agent by mistake. Several
 * matches complete their longest common prefix; when even that adds nothing,
 * null stands aside.
 */
export function completeCommand(input: string): string | null {
  if (!input.startsWith("/") || input.includes(" ")) return null;
  const matches = matchCommands(input);
  if (matches.length === 0) return null;
  if (matches.length === 1) return `${matches[0]!.cmd} `;
  let prefix = matches[0]!.cmd;
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.cmd.length && prefix[i] === m.cmd[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length > input.length ? prefix : null;
}

// The composer. Addressing: when `to` is set the prompt shows a coloured
// @#id chip, and the message would go to that run instead of the current one.
export function Prompt({
  value,
  cur,
  to,
  pendingCount,
  width,
  busy,
  maxHelp,
  completions,
  completionIndex,
}: {
  value: string;
  /** Where the next keystroke lands in `value`; end-of-line when omitted.
   *  Mid-line it is painted as an inverse block, readline-style. */
  cur?: number;
  to: number | null;
  pendingCount: number;
  width: number;
  busy: boolean;
  /** How many help lines the screen has room for; the rest are dropped rather
   *  than pushing the transcript off the top. */
  maxHelp?: number;
  /** `/model` suggestions. While non-empty they replace the command help and
   *  `tab` completes the highlighted row instead of addressing an agent. */
  completions?: ModelOption[];
  completionIndex?: number;
}) {
  const g = useGlyphs();
  const at = cur ?? value.length;
  const cmds = layoutHelp(matchCommands(value).slice(0, maxHelp ?? Infinity), width, g);
  const comps = layoutCompletions((completions ?? []).slice(0, maxHelp ?? Infinity), width, g);
  const pending = layoutPending(pendingCount, width, g);
  const completing = comps.length > 0;
  const keys: KeyHint[] = completing
    ? [
        [g.enter, "send"],
        ["tab", "complete"],
        [g.move, "pick"],
      ]
    : to !== null
      ? [
          [g.enter, "answer"],
          ["esc", "cancel"],
        ]
      : [
          [g.enter, "send"],
          ["/", "commands"],
          ["tab", "answer agent"],
          ["^k", "jump"],
          ["^f", "floor"],
          ["^n", "needs you"],
          ["^b", "rail"],
        ];
  return (
    <Box flexDirection="column" width={width}>
      {completing && (
        <Box flexDirection="column" paddingLeft={2}>
          {comps.map((c, i) => (
            <Text key={c.value} inverse={i === completionIndex}>
              <Text color={C.fg}>{c.value}</Text>
              <Text color={C.muted}>{c.label}</Text>
            </Text>
          ))}
        </Box>
      )}
      {!completing && cmds.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {cmds.map((c) => (
            <Text key={c.cmd}>
              <Text color={C.fg}>{c.cmd}</Text>
              <Text color={C.muted}>{c.help}</Text>
            </Text>
          ))}
        </Box>
      )}
      {pendingCount > 0 && to === null && (
        <Box>
          <Text color={C.review}>{pending[0]}</Text>
          <Text color={C.muted}>{pending[1]}</Text>
          <Text color={C.muted}>{pending[2]}</Text>
          <Text color={C.fg}>{pending[3]}</Text>
          <Text color={C.muted}>{pending[4]}</Text>
        </Box>
      )}
      <Hair width={width} />
      <Box>
        <Text color={to !== null ? C.review : C.you}>{`${g.caret} `}</Text>
        {to !== null && (
          <Text color={C.review} bold>
            @#{to}{" "}
          </Text>
        )}
        {at < value.length ? (
          <>
            <Text color={C.fg}>{value.slice(0, at)}</Text>
            {/* The block cursor sits on the character it would replace. */}
            <Text color={C.fg} inverse>
              {value.slice(at, at + 1)}
            </Text>
            <Text color={C.fg}>{value.slice(at + 1)}</Text>
          </>
        ) : (
          <>
            <Text color={C.fg}>{value}</Text>
            <Text color={busy ? C.muted : C.fg}>{busy ? g.ellipsis : g.bar}</Text>
          </>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Keys items={fitKeys(keys, width)} />
      </Box>
    </Box>
  );
}
