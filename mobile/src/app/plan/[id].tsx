import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { DetailHeader } from "@/components/shell";
import { Icon } from "@/components/Icon";
import { StateIcon } from "@/components/StateIcon";
import { LiveDot, Mono, MonoTag, Press, ProgressBar, SectionHead, StatePill, Tile } from "@/components/primitives";
import { MiniMarkdown } from "@/components/MiniMarkdown";
import { Loading } from "@/components/Loading";
import { useData } from "@/data/DataProvider";
import { useSheets } from "@/data/SheetsProvider";
import { api } from "@/lib/api";
import type { PlanDetail, TaskFull } from "@/lib/types";
import { planGlyphState } from "@/lib/model";
import { money } from "@/lib/format";
import { useTheme } from "@/theme";

const ACTIVE = new Set(["pending", "preparing", "running", "pushing"]);

export default function PlanDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sessions } = useData();
  const { openSpawn, openTask } = useSheets();

  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.plan(String(id)));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load plan");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const tasks = plan?.tasks ?? [];
  const taskIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);

  const activeRuns = useMemo(
    () => sessions.filter((s) => s.taskId && taskIds.has(s.taskId) && ACTIVE.has(s.status)),
    [sessions, taskIds]
  );
  const queued = tasks.filter((t) => t.state === "todo");
  const shipped = tasks.filter((t) => t.state === "merged");

  if (!plan) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <DetailHeader onBack={() => router.back()} backLabel="Plans" />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {err ? <Text style={{ color: c.muted }}>{err}</Text> : <Loading />}
        </View>
      </View>
    );
  }

  const glyph = planGlyphState(plan.state);
  const { done, total } = plan.progress;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <DetailHeader onBack={() => router.back()} backLabel="Plans">
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatePill state={glyph} size="xs" />
            <MonoTag>{plan.id}</MonoTag>
          </View>
          <Text style={{ marginTop: 9, marginBottom: 8, fontSize: 19, fontWeight: "600", color: c.fg, lineHeight: 24 }}>
            {plan.title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <ProgressBar value={done} max={Math.max(1, total)} color={plan.state === "done" ? c.sDone : c.sProgress} height={4} />
            </View>
            <Mono style={{ fontSize: 11, color: c.muted }}>
              {done}/{total}
            </Mono>
            {plan.owner ? <Mono style={{ fontSize: 11, color: c.muted2 }}>{plan.owner}</Mono> : null}
          </View>
        </View>
      </DetailHeader>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <Tile label="Overview">
          <MiniMarkdown body={plan.body} />
        </Tile>

        {activeRuns.length ? (
          <>
            <View style={{ height: 18 }} />
            <SectionHead glyph={<LiveDot size={11} />} title="Active runs" count={activeRuns.length} />
            <View style={{ gap: 8 }}>
              {activeRuns.map((r) => {
                const t = tasks.find((x) => x.id === r.taskId);
                return (
                  <Press
                    key={r.id}
                    onPress={() => router.push(`/run/${r.id}`)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      padding: 13,
                      backgroundColor: c.surface,
                      borderWidth: 1,
                      borderColor: c.hairline,
                      borderRadius: 13,
                    }}
                  >
                    <StateIcon state="in_progress" size={14} spin />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontSize: 13.5, color: c.fg }}>
                        {t?.title || `Run ${r.id}`}
                      </Text>
                      <Mono style={{ fontSize: 10.5, color: c.muted2, marginTop: 2 }}>
                        {money(r.totalCostUsd ?? 0)}
                      </Mono>
                    </View>
                    <Icon name="chev-r" size={14} stroke={2} color={c.muted} />
                  </Press>
                );
              })}
            </View>
          </>
        ) : null}

        {queued.length ? (
          <>
            <View style={{ height: 18 }} />
            <SectionHead glyph={<StateIcon state="todo" size={13} />} title="Queued tasks" count={queued.length} />
            <View style={{ gap: 8 }}>
              {queued.map((t) => (
                <QueuedRow key={t.id} task={t} planTitle={plan.title} onRun={openSpawn} onOpen={() => openTask(t.id)} />
              ))}
            </View>
          </>
        ) : null}

        {shipped.length ? (
          <>
            <View style={{ height: 18 }} />
            <SectionHead glyph={<StateIcon state="done" size={13} />} title="Shipped" count={shipped.length} />
            <View style={{ gap: 8 }}>
              {shipped.map((t) => (
                <Press
                  key={t.id}
                  onPress={() => openTask(t.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 11,
                    padding: 13,
                    backgroundColor: c.surface,
                    borderWidth: 1,
                    borderColor: c.hairline,
                    borderRadius: 13,
                  }}
                >
                  <StateIcon state="done" size={14} />
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, color: c.fg }}>
                    {t.title}
                  </Text>
                  <MonoTag dim>{t.id}</MonoTag>
                </Press>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function QueuedRow({
  task,
  planTitle,
  onRun,
  onOpen,
}: {
  task: TaskFull;
  planTitle: string;
  onRun: (q: {
    id: string;
    title: string;
    planId: string;
    planTitle: string;
    criteria: number;
    tags: string[];
    assignee: string | null;
  }) => void;
  onOpen: () => void;
}) {
  const { c } = useTheme();
  return (
    <Press
      onPress={onOpen}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        padding: 13,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        borderRadius: 13,
      }}
    >
      <StateIcon state="todo" size={13} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ fontSize: 13.5, color: c.fg, lineHeight: 18 }}>
          {task.title}
        </Text>
        <Mono style={{ fontSize: 10.5, color: c.muted2, marginTop: 3 }}>{task.criteria.length} criteria</Mono>
      </View>
      <Press
        onPress={() =>
          onRun({
            id: task.id,
            title: task.title,
            planId: task.planId,
            planTitle,
            criteria: task.criteria.length,
            tags: task.tags,
            assignee: task.assignee,
          })
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 9,
          backgroundColor: c.raised,
          borderWidth: 1,
          borderColor: c.hairlineStrong,
        }}
      >
        <Icon name="spark" size={12} color={c.fg} />
        <Text style={{ color: c.fg, fontSize: 12, fontWeight: "600" }}>Run</Text>
      </Press>
    </Press>
  );
}
