import React from "react";
import { Text, View } from "react-native";

import { Icon, type IconName } from "./Icon";
import { StateIcon } from "./StateIcon";
import { SwipeRow } from "./SwipeRow";
import {
  Badge,
  CyclingText,
  Elapsed,
  Mono,
  MonoTag,
  PersonaChip,
  Press,
  ProgressBar,
  Sparkline,
  StatePill,
} from "./primitives";
import { useTheme, stateColor, toAlpha } from "@/theme";
import { money } from "@/lib/format";
import type { FloorRunVM, QueueVM, ReviewVM, ShippedVM, RunSub } from "@/lib/model";

const SUB_LABEL: Record<RunSub, string> = {
  editing: "Editing",
  tool: "Tool",
  thinking: "Thinking",
  starting: "Starting",
};
const SUB_ICON: Record<RunSub, IconName> = {
  editing: "edit",
  tool: "term",
  thinking: "spark",
  starting: "circle",
};

function activityFor(run: FloorRunVM): string[] {
  const title = run.title.slice(0, 46);
  return [
    `Working on "${title}"`,
    "Reading repo files",
    "Running checks",
    "Editing source files",
  ];
}

export function RunCard({
  run,
  onOpen,
  onPause,
  onStop,
}: {
  run: FloorRunVM;
  onOpen: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const { c } = useTheme();
  const overBudget = run.budget > 0 && run.cost / run.budget > 0.85;
  return (
    <SwipeRow
      onTap={onOpen}
      actions={[
        { label: "Pause", icon: "pause", onPress: onPause, bg: c.raised, color: c.fg },
        { label: "Stop", icon: "stop", onPress: onStop, bg: toAlpha(c.sBlocked, 0.22), color: c.sBlocked },
      ]}
    >
      <View style={{ padding: 14, borderWidth: 1, borderColor: c.hairline, borderRadius: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StateIcon state="in_progress" size={14} spin />
          <Text style={{ fontSize: 11, fontWeight: "600", color: c.sProgress, letterSpacing: 0.4, textTransform: "uppercase" }}>
            {SUB_LABEL[run.sub]}
          </Text>
          <MonoTag>{run.shortId}</MonoTag>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name="clock" size={11} color={c.muted} />
            <Elapsed startMs={run.startedAt} style={{ fontSize: 11, color: c.muted, fontFamily: "monospace" }} />
          </View>
        </View>

        <Text numberOfLines={2} style={{ marginTop: 8, fontSize: 15, fontWeight: "500", color: c.fg, lineHeight: 20 }}>
          {run.title}
        </Text>

        <View style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={SUB_ICON[run.sub]} size={12} color={c.muted} />
          <CyclingText items={activityFor(run)} style={{ flex: 1, color: c.muted, fontSize: 12.5 }} />
        </View>

        <View style={{ height: 10 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <PersonaChip id={null} model={run.model} label={run.model} />
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Mono style={{ fontSize: 11, color: c.fg }}>
              {run.progress.done}/{run.progress.total}
            </Mono>
            <View style={{ width: 48 }}>
              <ProgressBar value={run.progress.done} max={Math.max(1, run.progress.total)} color={c.sProgress} height={3} />
            </View>
          </View>
        </View>

        <View style={{ height: 9 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="branch" size={11} color={c.muted2} />
          <Mono style={{ fontSize: 10.5, color: c.muted2, flexShrink: 1 }} numberOfLines={1}>
            {run.branch || "—"}
          </Mono>
          <View style={{ flex: 1 }} />
          <Mono style={{ fontSize: 11, color: overBudget ? c.sBlocked : c.muted }}>{money(run.cost)}</Mono>
          <Mono style={{ fontSize: 10.5, color: c.muted2 }}>/${run.budget}</Mono>
          <Sparkline values={run.sparkline} width={40} height={14} color={c.sProgress} />
        </View>
      </View>
    </SwipeRow>
  );
}

export function ReviewCard({
  item,
  onOpen,
  onApprove,
  onChanges,
}: {
  item: ReviewVM;
  onOpen: () => void;
  onApprove: () => void;
  onChanges: () => void;
}) {
  const { c } = useTheme();
  return (
    <SwipeRow
      onTap={onOpen}
      actions={[
        { label: "Changes", icon: "edit", onPress: onChanges, bg: c.raised, color: c.sProgress },
        { label: "Approve", icon: "check", onPress: onApprove, bg: toAlpha(c.sDone, 0.22), color: c.sDone },
      ]}
    >
      <View style={{ padding: 14, borderWidth: 1, borderColor: c.hairline, borderRadius: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatePill state="review" label="PR open" size="xs" />
          {item.prNum != null ? <Mono style={{ fontSize: 11, color: c.sReview }}>#{item.prNum}</Mono> : null}
          <View style={{ flex: 1 }} />
          {item.model ? <PersonaChip id={null} model={item.model} label={item.model} /> : null}
        </View>
        <Text numberOfLines={2} style={{ marginTop: 8, fontSize: 15, fontWeight: "500", color: c.fg, lineHeight: 20 }}>
          {item.title}
        </Text>
        <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="branch" size={11} color={c.muted2} />
          <Mono style={{ fontSize: 10.5, color: c.muted2, flexShrink: 1 }} numberOfLines={1}>
            {item.branch || "—"}
          </Mono>
          <View style={{ flex: 1 }} />
          <Mono style={{ fontSize: 11, color: c.muted }}>{money(item.cost)}</Mono>
        </View>
      </View>
    </SwipeRow>
  );
}

export function BlockedCard({
  run,
  onOpen,
  onResume,
}: {
  run: FloorRunVM;
  onOpen: () => void;
  onResume: () => void;
}) {
  const { c } = useTheme();
  const budget = run.reason?.toLowerCase().includes("budget");
  return (
    <SwipeRow
      onTap={onOpen}
      actions={[{ label: "Resume", icon: "play", onPress: onResume, bg: toAlpha(c.sProgress, 0.2), color: c.sProgress }]}
    >
      <View style={{ padding: 14, borderWidth: 1, borderColor: c.hairline, borderRadius: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatePill state="blocked" label={budget ? "Budget" : "Criteria"} size="xs" />
          <MonoTag>{run.shortId}</MonoTag>
          <View style={{ flex: 1 }} />
          {run.model ? <PersonaChip id={null} model={run.model} label={run.model} /> : null}
        </View>
        <Text numberOfLines={2} style={{ marginTop: 8, fontSize: 15, fontWeight: "500", color: c.fg, lineHeight: 20 }}>
          {run.title}
        </Text>
        {run.reason ? <Text style={{ marginTop: 8, fontSize: 12, color: c.sBlocked, lineHeight: 17 }}>{run.reason}</Text> : null}
      </View>
    </SwipeRow>
  );
}

export function ShippedItem({ item }: { item: ShippedVM }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        padding: 14,
        borderWidth: 1,
        borderColor: c.hairline,
        borderRadius: 14,
        backgroundColor: c.surface,
      }}
    >
      <StateIcon state="done" size={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, color: c.fg }}>
          {item.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
          {item.prNum != null ? <Mono style={{ fontSize: 10, color: c.sReview }}>#{item.prNum}</Mono> : null}
          <Mono style={{ fontSize: 10, color: c.muted2 }}>{item.shortId}</Mono>
        </View>
      </View>
      <Mono style={{ fontSize: 11, color: c.muted }}>{money(item.cost)}</Mono>
    </View>
  );
}

export function QueueCard({ item, onSpawn }: { item: QueueVM; onSpawn: () => void }) {
  const { c } = useTheme();
  return (
    <View style={{ padding: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.hairline, borderRadius: 15 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StateIcon state="todo" size={13} />
        <MonoTag>{item.id}</MonoTag>
        <View style={{ flex: 1 }} />
        {item.assignee ? (
          <PersonaChip id={item.assignee} label={item.assignee} />
        ) : (
          <Text style={{ color: c.muted2, fontSize: 11 }}>unassigned</Text>
        )}
      </View>
      <Text numberOfLines={2} style={{ marginTop: 8, fontSize: 14.5, fontWeight: "500", color: c.fg, lineHeight: 19 }}>
        {item.title}
      </Text>
      <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Mono style={{ fontSize: 11, color: c.muted }}>{item.criteria} criteria</Mono>
        {item.tags.slice(0, 2).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <View style={{ flex: 1 }} />
        <Press
          onPress={onSpawn}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 10,
            backgroundColor: c.fg,
          }}
        >
          <Icon name="spark" size={12} color={c.bg} />
          <Text style={{ color: c.bg, fontSize: 12.5, fontWeight: "600" }}>Run</Text>
        </Press>
      </View>
    </View>
  );
}

export { stateColor };
