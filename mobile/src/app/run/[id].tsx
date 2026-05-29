import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { DetailHeader, RoundButton } from "@/components/shell";
import { BottomSheet } from "@/components/BottomSheet";
import { Icon } from "@/components/Icon";
import { StateIcon } from "@/components/StateIcon";
import {
  Elapsed,
  Mono,
  MonoTag,
  PersonaChip,
  Press,
  ProgressBar,
  SectionHead,
  Sparkline,
  StatePill,
  Tile,
} from "@/components/primitives";
import { Loading } from "@/components/Loading";
import { useData } from "@/data/DataProvider";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { RunDetail, MessageRow } from "@/lib/types";
import { fmtTok, money, prNumber, shortRunId, fauxSparkline } from "@/lib/format";
import { useTheme, type RunState } from "@/theme";

const ACTIVE = new Set(["pending", "preparing", "running", "pushing"]);
const BLOCKED = new Set(["failed", "budget_exhausted"]);

function uiState(run: RunDetail): RunState {
  if (ACTIVE.has(run.status)) return "in_progress";
  if (BLOCKED.has(run.status)) return "blocked";
  if (run.status === "opening_pr" || run.prUrl) return "review";
  if (run.status === "completed") return "done";
  return "todo";
}

export default function RunDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const runId = Number(id);
  const { tasks, plans, refresh } = useData();

  const [run, setRun] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ctrlOpen, setCtrlOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load run");
    }
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while live.
  useEffect(() => {
    if (!run?.live) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [run?.live, load]);

  const task = useMemo(() => (run?.taskId ? tasks.find((t) => t.id === run.taskId) : null), [run, tasks]);
  const planTitle = useMemo(() => {
    const pid = task?.planId || run?.planId;
    return pid ? plans.find((p) => p.id === pid)?.title || pid : "";
  }, [task, run, plans]);

  if (!run) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <DetailHeader onBack={() => router.back()} backLabel="Floor" />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {err ? <Text style={{ color: c.muted }}>{err}</Text> : <Loading />}
        </View>
      </View>
    );
  }

  const st = uiState(run);
  const live = st === "in_progress";
  const startedMs = new Date(run.startedAt).getTime();
  const budget = run.budgetMaxUsd ?? 25;
  const cost = run.totalCostUsd ?? 0;
  const overBudget = budget > 0 && cost / budget > 0.85;
  const criteria = task?.criteria ?? [];
  const done = criteria.filter((x) => x.done).length;
  const prNum = prNumber(run.prUrl);
  const spark = fauxSparkline(run.id + Math.round(cost * 10));

  const stop = async () => {
    try {
      await api.cancelRun(run.id);
      toast(`Stopped run`);
      load();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Stop failed");
    }
  };
  const resume = async () => {
    try {
      await api.resumeSession(run.id);
      toast(`Resumed run`);
      load();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Resume failed");
    }
  };
  const approve = async () => {
    if (!run.taskId) return;
    try {
      await api.transitionTask(run.taskId, "done");
      toast(prNum ? `Approved #${prNum}` : "Marked done");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not approve");
    }
  };
  const changes = async () => {
    if (!run.taskId) return;
    try {
      await api.transitionTask(run.taskId, "in_progress", { assignee: "claude-agent" });
      toast("Requested changes");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <DetailHeader
        onBack={() => router.back()}
        backLabel="Floor"
        right={<RoundButton icon="more" onPress={() => setCtrlOpen(true)} />}
      >
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatePill state={st} live size="xs" />
            <MonoTag>{shortRunId(run.id, startedMs)}</MonoTag>
            {run.taskId ? <Mono style={{ fontSize: 10.5, color: c.muted2 }}>→ {run.taskId}</Mono> : null}
          </View>
          <Text style={{ marginTop: 9, marginBottom: 3, fontSize: 18, fontWeight: "600", color: c.fg, lineHeight: 23 }}>
            {task?.title || run.title || `Run ${run.id}`}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {planTitle ? <Text style={{ color: c.muted2, fontSize: 12 }}>{planTitle}</Text> : null}
            <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: c.muted2 }} />
            <PersonaChip id={run.personaId} label={run.personaId} model={run.model} showModel strong />
          </View>
        </View>
      </DetailHeader>

      <View style={{ flex: 1 }}>
        <RunBody
          run={run}
          live={live}
          startedMs={startedMs}
          budget={budget}
          cost={cost}
          overBudget={overBudget}
          criteria={criteria}
          done={done}
          prNum={prNum}
          spark={spark}
        />
      </View>

      {/* Sticky action bar */}
      <View
        style={{
          flexDirection: "row",
          gap: 9,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 26,
          borderTopWidth: 1,
          borderTopColor: c.hairline,
          backgroundColor: c.bg,
        }}
      >
        {live ? (
          <>
            <BarBtn icon="pause" label="Pause" onPress={() => toast("Pause isn't available yet")} />
            <BarBtn icon="stop" label="Stop" onPress={stop} />
            <BarBtn icon="spark" label="Instruct" primary onPress={() => setCtrlOpen(true)} />
          </>
        ) : st === "review" ? (
          <>
            <BarBtn icon="edit" label="Changes" onPress={changes} />
            <BarBtn icon="check" label="Approve & merge" primary onPress={approve} />
          </>
        ) : (
          <>
            <BarBtn icon="user" label="Reassign" onPress={() => toast("Reassign isn't available yet")} />
            <BarBtn icon="play" label="Resume" primary onPress={resume} />
          </>
        )}
      </View>

      <BottomSheet open={ctrlOpen} onClose={() => setCtrlOpen(false)} title="Controls" subtitle={shortRunId(run.id, startedMs)} maxHeightPct={0.6}>
        <View style={{ gap: 8 }}>
          {(live
            ? [
                { icon: "stop" as const, label: "Stop run", run: stop },
                { icon: "spark" as const, label: "Send instructions", run: () => toast("Instruct isn't available yet") },
              ]
            : [
                { icon: "play" as const, label: "Resume run", run: resume },
                { icon: "user" as const, label: "Reassign persona", run: () => toast("Reassign isn't available yet") },
              ]
          ).map((a, i) => (
            <Press
              key={a.label}
              onPress={() => {
                setCtrlOpen(false);
                a.run();
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 11,
                padding: 14,
                borderRadius: 12,
                backgroundColor: i === 0 ? c.fg : c.raised,
              }}
            >
              <Icon name={a.icon} size={16} color={i === 0 ? c.bg : c.fg} />
              <Text style={{ fontSize: 14, fontWeight: i === 0 ? "600" : "500", color: i === 0 ? c.bg : c.fg }}>
                {a.label}
              </Text>
            </Press>
          ))}
        </View>
      </BottomSheet>
    </View>
  );
}

function BarBtn({
  icon,
  label,
  onPress,
  primary,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Press
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 46,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderRadius: 12,
        backgroundColor: primary ? c.fg : c.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: c.hairline,
      }}
    >
      <Icon name={icon} size={14} color={primary ? c.bg : c.fg} />
      <Text style={{ fontSize: 13.5, fontWeight: primary ? "600" : "500", color: primary ? c.bg : c.fg }}>{label}</Text>
    </Press>
  );
}

function RunBody({
  run,
  live,
  startedMs,
  budget,
  cost,
  overBudget,
  criteria,
  done,
  prNum,
  spark,
}: {
  run: RunDetail;
  live: boolean;
  startedMs: number;
  budget: number;
  cost: number;
  overBudget: boolean;
  criteria: { id: number; text: string; done: boolean }[];
  done: number;
  prNum: number | null;
  spark: number[];
}) {
  const { c } = useTheme();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
      {/* branch + PR */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          padding: 13,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 12,
        }}
      >
        <Icon name="branch" size={13} color={c.muted} />
        <Mono style={{ fontSize: 11.5, flex: 1, color: c.muted }} numberOfLines={1}>
          {run.branch || "no branch"}
        </Mono>
        {prNum != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name="pr" size={12} color={c.sReview} />
            <Text style={{ color: c.sReview, fontSize: 12, fontWeight: "500" }}>#{prNum}</Text>
          </View>
        ) : (
          <Text style={{ color: c.muted2, fontSize: 11 }}>no PR yet</Text>
        )}
      </View>

      {/* spend */}
      <View style={{ height: 12 }} />
      <Tile label="Spend">
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 7 }}>
          <Mono style={{ fontSize: 26, fontWeight: "500", color: c.fg, letterSpacing: -0.5 }}>{money(cost)}</Mono>
          <Mono style={{ fontSize: 13, color: c.muted2 }}>/ ${budget}</Mono>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name="clock" size={11} color={c.muted} />
            <Elapsed startMs={startedMs} paused={!live} format="hms" style={{ fontSize: 11, color: c.muted, fontFamily: "monospace" }} />
          </View>
        </View>
        <View style={{ height: 9 }} />
        <ProgressBar value={cost} max={Math.max(0.01, budget)} color={overBudget ? c.sBlocked : c.sProgress} height={4} />
        <View style={{ flexDirection: "row", gap: 18, marginTop: 11, alignItems: "flex-end" }}>
          <View style={{ gap: 1 }}>
            <Mono style={{ fontSize: 13, color: c.fg }}>{fmtTok(run.inputTokens ?? 0)}</Mono>
            <Text style={{ fontSize: 10, color: c.muted2 }}>tokens in</Text>
          </View>
          <View style={{ gap: 1 }}>
            <Mono style={{ fontSize: 13, color: c.fg }}>{fmtTok(run.outputTokens ?? 0)}</Mono>
            <Text style={{ fontSize: 10, color: c.muted2 }}>tokens out</Text>
          </View>
          <View style={{ flex: 1 }} />
          <Sparkline values={spark} width={88} height={26} color={c.sProgress} />
        </View>
      </Tile>

      {/* criteria */}
      {criteria.length ? (
        <>
          <View style={{ height: 12 }} />
          <Tile label={`Acceptance criteria · ${done}/${criteria.length}`}>
            <View style={{ gap: 9 }}>
              {criteria.map((cr) => (
                <View key={cr.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
                  <View style={{ marginTop: 1 }}>
                    <StateIcon state={cr.done ? "done" : "todo"} size={13} />
                  </View>
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      lineHeight: 18,
                      color: cr.done ? c.muted : c.fg,
                      textDecorationLine: cr.done ? "line-through" : "none",
                    }}
                  >
                    {cr.text}
                  </Text>
                </View>
              ))}
            </View>
          </Tile>
        </>
      ) : null}

      {/* event stream */}
      <View style={{ height: 18 }} />
      <SectionHead title="Event stream" />
      <EventStream messages={run.messages} />
    </ScrollView>
  );
}

function extractText(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "tool_use" && typeof b.name === "string") parts.push(`→ tool: ${b.name}`);
      else if (b.type === "tool_result") parts.push("← tool result");
      else if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join(" ").trim();
}

const ROLE_META: Record<MessageRow["role"], { label: string; key: "muted" | "fg" | "progress" | "done" }> = {
  system: { label: "sys", key: "muted" },
  agent: { label: "claude", key: "fg" },
  tool: { label: "tool", key: "progress" },
  user: { label: "you", key: "done" },
};

function EventStream({ messages }: { messages: MessageRow[] }) {
  const { c } = useTheme();
  const colorFor = (k: string) =>
    k === "fg" ? c.fg : k === "progress" ? c.sProgress : k === "done" ? c.sDone : c.muted2;
  const sorted = [...messages].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (sorted.length === 0) {
    return <Text style={{ color: c.muted2, fontSize: 12, paddingVertical: 8 }}>No events yet.</Text>;
  }
  return (
    <View>
      {sorted.map((m) => {
        const meta = ROLE_META[m.role] || ROLE_META.system;
        const col = colorFor(meta.key);
        const body = extractText(m.content) || "(no content)";
        const t = new Date(m.createdAt);
        const tstr = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
        return (
          <View
            key={m.id}
            style={{ flexDirection: "row", gap: 9, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.hairline }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingTop: 1 }}>
              <View style={{ width: 6, height: 6, borderRadius: 2, backgroundColor: col }} />
              <Mono style={{ fontSize: 10, color: col, width: 46 }}>{meta.label}</Mono>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 12,
                  lineHeight: 18,
                  color: m.role === "agent" ? c.fg : c.muted,
                  fontFamily: m.role === "agent" ? undefined : "monospace",
                }}
              >
                {body}
              </Text>
              <Mono style={{ fontSize: 9.5, color: c.muted2 }}>{tstr}</Mono>
            </View>
          </View>
        );
      })}
    </View>
  );
}
