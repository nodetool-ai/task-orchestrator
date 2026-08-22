import React from "react";
import { Box, Text } from "ink";
import { C, Hair, Keys, useGlyphs } from "../theme.js";
import { fitKeys, layoutHelp, layoutPending, type KeyHint } from "./layout.js";

// The commands the cockpit can actually honour today (PRD §6.4). M2 added the
// three that write: /new, /spawn and /cancel; M4 added /model and /budget,
// which patch the open run and are listed now that they do something.
export const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/floor", help: "all agents as a tree" },
  { cmd: "/inbox", help: "what needs you" },
  { cmd: "/new", help: "start an agent  /new implementor <goal>" },
  { cmd: "/open", help: "look at a run  /open #45" },
  { cmd: "/spawn", help: "ask this agent to delegate  /spawn reviewer T-42" },
  { cmd: "/cancel", help: "stop this run and its live children" },
  { cmd: "/model", help: "retune this run  /model claude-sonnet-4-5" },
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

// The composer. Addressing: when `to` is set the prompt shows a coloured
// @#id chip, and the message would go to that run instead of the current one.
export function Prompt({
  value,
  to,
  pendingCount,
  width,
  busy,
  maxHelp,
}: {
  value: string;
  to: number | null;
  pendingCount: number;
  width: number;
  busy: boolean;
  /** How many help lines the screen has room for; the rest are dropped rather
   *  than pushing the transcript off the top. */
  maxHelp?: number;
}) {
  const g = useGlyphs();
  const cmds = layoutHelp(matchCommands(value).slice(0, maxHelp ?? Infinity), width, g);
  const pending = layoutPending(pendingCount, width, g);
  const keys: KeyHint[] =
    to !== null
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
      {cmds.length > 0 && (
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
        <Text color={C.fg}>{value}</Text>
        <Text color={busy ? C.muted : C.fg}>{busy ? g.ellipsis : g.bar}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Keys items={fitKeys(keys, width)} />
      </Box>
    </Box>
  );
}
