import React from "react";
import { Box, Text } from "ink";
import type { Forest } from "../model/forest.js";
import type { Run } from "../model/run.js";
import { verbFor } from "../model/verbs.js";
import { duration } from "../model/time.js";
import { C, useGlyphs, usd } from "../theme.js";
import { layoutSpinner } from "./layout.js";
import { glimmerAt, RUNWAY, spinnerFrame, useClock } from "./anim.js";
import { useMotion } from "./motion.js";

// Claude Code's live line, in the cockpit's dialect. The shape is theirs:
// a breathing asterisk, one verb, and a dim parenthesised byline that gives
// up its parts from the right when the pane is narrow. The contents are ours
// — an agent count and a subtree cost say more here than a token counter.

export function LiveLine({
  run,
  forest,
  width,
  now,
}: {
  run: Run;
  forest: Forest;
  width: number;
  /** The store's clock. Used when motion is off, so the timer still counts. */
  now: number;
}) {
  const g = useGlyphs();
  const motion = useMotion();
  const time = useClock(motion);
  // The store ticks every two seconds, which is fine for a run's age and far
  // too slow for a turn timer. With motion on we are re-rendering at 20 fps
  // anyway, so the timer reads the wall clock and counts every second.
  const elapsed = (motion ? Date.now() : now) - run.startedAt;
  const kids = forest.childrenOf(run.id).length;

  const cells = layoutSpinner({
    verb: verbFor(run.id),
    parts: [
      duration(elapsed),
      kids > 0 ? `${kids} agent${kids === 1 ? "" : "s"}` : "",
      usd(forest.subtreeCost(run.id)),
      "/cancel to stop",
    ],
    width,
    glyphs: g,
  });

  const frames = g.spinner;
  const glyph = motion ? spinnerFrame(time, frames) : (frames[frames.length - 1] as string);

  return (
    <Box width={width}>
      <Text color={C.running}>{glyph}</Text>
      <Text> </Text>
      <Glimmer text={cells.verb} at={motion ? glimmerAt(time, cells.verb.length) : -RUNWAY} />
      <Text color={C.muted}>{cells.tail}</Text>
    </Box>
  );
}

/** The verb, with the two or three columns under the highlight lifted. Split
 *  into three <Text> runs rather than one per character: a per-character run
 *  is a colour escape per character, twenty times a second. */
function Glimmer({ text, at }: { text: string; at: number }) {
  const start = Math.max(0, at - 1);
  const end = Math.min(text.length, at + 2);
  if (end <= start) return <Text color={C.running}>{text}</Text>;
  return (
    <Text>
      <Text color={C.running}>{text.slice(0, start)}</Text>
      <Text color={C.shimmer}>{text.slice(start, end)}</Text>
      <Text color={C.running}>{text.slice(end)}</Text>
    </Text>
  );
}
