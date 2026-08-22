import React from "react";
import { Box, Text } from "ink";
import { byId, type InboxItem } from "../data.js";
import { C, Hair, Keys } from "../theme.js";

export const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/floor", help: "all agents as a tree" },
  { cmd: "/inbox", help: "what needs you" },
  { cmd: "/new", help: "start a new top-level agent  /new <persona> <goal>" },
  { cmd: "/open", help: "talk to a run  /open #45" },
  { cmd: "/spawn", help: "ask this agent to delegate  /spawn implementor T-0006" },
  { cmd: "/cancel", help: "stop this run (and its children)" },
  { cmd: "/model", help: "switch model for this run" },
  { cmd: "/budget", help: "raise or lower the budget" },
  { cmd: "/quit", help: "leave; agents keep running" },
];

export function matchCommands(input: string) {
  if (!input.startsWith("/")) return [];
  const head = input.split(" ")[0];
  if (input.includes(" ")) return COMMANDS.filter((c) => c.cmd === head);
  return COMMANDS.filter((c) => c.cmd.startsWith(head));
}

// The composer. Addressing: when `to` is set the prompt shows a coloured
// @#id chip, and the message goes to that run instead of the current one.
export function Prompt({
  value,
  to,
  pending,
  width,
  busy,
}: {
  value: string;
  to: number | null;
  pending: InboxItem[];
  width: number;
  busy: boolean;
}) {
  const cmds = matchCommands(value);
  const questions = pending.filter((p) => p.kind === "question");
  return (
    <Box flexDirection="column" width={width}>
      {cmds.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginBottom={0}>
          {cmds.map((c) => (
            <Text key={c.cmd}>
              <Text color={C.fg}>{c.cmd.padEnd(9)}</Text>
              <Text color={C.muted}>{c.help}</Text>
            </Text>
          ))}
        </Box>
      )}
      {questions.length > 0 && to === null && (
        <Box>
          <Text color={C.review}>⚑ </Text>
          <Text color={C.muted}>
            {questions.length === 1
              ? `${byId(questions[0].run).persona} #${questions[0].run} is waiting on you`
              : `${questions.length} agents are waiting on you`}{" "}
            · <Text color={C.fg}>tab</Text> to answer
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
        <Text>{value}</Text>
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
