import React from "react";
import { Box, Text } from "ink";
import { C, Hair, Keys } from "../theme.js";

// The commands the cockpit can actually honour today (PRD §6.4). M2 added the
// three that write: /new, /spawn and /cancel. /model and /budget arrive with
// M4 and are still not advertised, because a listed command that answers
// "arrives later" is worse than one that is not listed at all.
export const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/floor", help: "all agents as a tree" },
  { cmd: "/inbox", help: "what needs you" },
  { cmd: "/new", help: "start an agent  /new implementor <goal>" },
  { cmd: "/open", help: "look at a run  /open #45" },
  { cmd: "/spawn", help: "ask this agent to delegate  /spawn reviewer T-42" },
  { cmd: "/cancel", help: "stop this run and its live children" },
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
}: {
  value: string;
  to: number | null;
  pendingCount: number;
  width: number;
  busy: boolean;
}) {
  const cmds = matchCommands(value);
  return (
    <Box flexDirection="column" width={width}>
      {cmds.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {cmds.map((c) => (
            <Text key={c.cmd}>
              <Text color={C.fg}>{c.cmd.padEnd(9)}</Text>
              <Text color={C.muted}>{c.help}</Text>
            </Text>
          ))}
        </Box>
      )}
      {pendingCount > 0 && to === null && (
        <Box>
          <Text color={C.review}>⚑ </Text>
          <Text color={C.muted}>
            {pendingCount === 1 ? "an agent is waiting on you" : `${pendingCount} agents are waiting on you`}
          </Text>
          <Text color={C.muted}>
            {" · "}
            <Text color={C.fg}>tab</Text> to answer
          </Text>
        </Box>
      )}
      <Hair width={width} />
      <Box>
        <Text color={to !== null ? C.review : C.you}>{"❯ "}</Text>
        {to !== null && (
          <Text color={C.review} bold>
            @#{to}{" "}
          </Text>
        )}
        <Text color={C.fg}>{value}</Text>
        <Text color={busy ? C.muted : C.fg}>{busy ? "…" : "▏"}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Keys
          items={
            to !== null
              ? [
                  ["↵", "answer"],
                  ["esc", "cancel"],
                ]
              : [
                  ["↵", "send"],
                  ["/", "commands"],
                  ["tab", "answer agent"],
                  ["^k", "jump"],
                  ["^f", "floor"],
                  ["^n", "needs you"],
                  ["^b", "rail"],
                ]
          }
        />
      </Box>
    </Box>
  );
}
