import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { DetailHeader, RoundButton } from "@/components/shell";
import { BottomSheet } from "@/components/BottomSheet";
import { Icon } from "@/components/Icon";
import { StateIcon } from "@/components/StateIcon";
import {
  Elapsed,
  Field,
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
import { Transcript } from "@/components/Transcript";
import { useData } from "@/data/DataProvider";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { RunDetail, TaskState } from "@/lib/types";
import { isReviewState } from "@/lib/task-state";
import { fmtTok, money, prNumber, shortRunId, fauxSparkline } from "@/lib/format";
import { useTheme, type RunState } from "@/theme";

const ACTIVE = new Set(["pending", "preparing", "running", "pushing"]);
const BLOCKED = new Set(["failed", "budget_exhausted"]);

// Derive the UI glyph state from the run status, preferring the task's board
// state when known: once a PR is opened the session is `completed` while the
// task sits in a review state (testing/failing/passing), so the task is the
// source of truth for the action bar.
function uiState(run: RunDetail, taskState?: TaskState): RunState {
  if (ACTIVE.has(run.status)) return "in_progress";
  if ((taskState && isReviewState(taskState)) || run.status === "opening_pr") return "review";
  if (taskState === "blocked" || BLOCKED.has(run.status)) return "blocked";
  if (taskState === "merged" || run.status === "completed") return "done";
  if (run.prUrl) return "review";
  return "todo";
}

// The two planning-agent gates that wait on a human. Maps a review stage to the
// approval action the server expects (POST /api/runs/:id/planning).
function planningApproval(run: RunDetail): "approve_spec" | "approve_plan" | null {
  if (run.planningStage === "spec_review") return "approve_spec";
  if (run.planningStage === "plan_review") return "approve_plan";
  return null;
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
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  // Optimistic overrides for criterion checkboxes, cleared once a refresh
  // brings the server's truth back.
  const [critOverride, setCritOverride] = useState<Record<number, boolean>>({});

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

  const toggleCriterion = useCallback(
    async (cid: number, next: boolean) => {
      if (!run?.taskId) return;
      setCritOverride((m) => ({ ...m, [cid]: next }));
      try {
        await api.updateCriterion(run.taskId, cid, { done: next });
        await refresh();
        setCritOverride((m) => {
          const n = { ...m };
          delete n[cid];
          return n;
        });
      } catch (e) {
        setCritOverride((m) => {
          const n = { ...m };
          delete n[cid];
          return n;
        });
        toast(e instanceof Error ? e.message : "Could not update criterion");
      }
    },
    [run?.taskId, refresh, toast]
  );

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

  const st = uiState(run, task?.state);
  const live = st === "in_progress";
  const approval = planningApproval(run);
  const startedMs = new Date(run.startedAt).getTime();
  const budget = run.budgetMaxUsd ?? 25;
  const cost = run.totalCostUsd ?? 0;
  const overBudget = budget > 0 && cost / budget > 0.85;
  const criteria = (task?.criteria ?? []).map((cr) => ({
    ...cr,
    done: critOverride[cr.id] ?? cr.done,
  }));
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
  const closeRun = async () => {
    try {
      await api.closeRun(run.id);
      toast("Closed run");
      load();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Close failed");
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
      await api.transitionTask(run.taskId, "merged");
      toast(prNum ? `Merged #${prNum}` : "Marked merged");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not approve");
    }
  };
  const changes = async () => {
    if (!run.taskId) return;
    try {
      await api.transitionTask(run.taskId, "blocked", { assignee: "claude-agent" });
      toast("Requested changes");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
  };
  const approvePlanning = async () => {
    if (!approval) return;
    try {
      await api.planningAction(run.id, approval);
      toast(approval === "approve_spec" ? "Approved spec" : "Approved plan");
      load();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Approval failed");
    }
  };
  const sendInstruct = async () => {
    const text = msg.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.sendRunMessage(run.id, text, (m) => toast(`Not delivered: ${m}`));
      setMsg("");
      setCtrlOpen(false);
      toast("Sent to agent");
      // Give the turn a moment to register, then poll it in.
      setTimeout(load, 800);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
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
          onToggleCriterion={run.taskId ? toggleCriterion : undefined}
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
            <BarBtn icon="stop" label="Stop" onPress={stop} />
            <BarBtn icon="more" label="Controls" onPress={() => setCtrlOpen(true)} />
          </>
        ) : approval ? (
          <>
            <BarBtn icon="edit" label="Request changes" onPress={() => setCtrlOpen(true)} />
            <BarBtn
              icon="check"
              label={approval === "approve_spec" ? "Approve spec" : "Approve plan"}
              primary
              onPress={approvePlanning}
            />
          </>
        ) : st === "review" ? (
          <>
            <BarBtn icon="edit" label="Changes" onPress={changes} />
            <BarBtn icon="check" label="Approve & merge" primary onPress={approve} />
          </>
        ) : st === "done" ? (
          <BarBtn icon="spark" label="Instruct" primary onPress={() => setCtrlOpen(true)} />
        ) : (
          <>
            <BarBtn icon="spark" label="Instruct" onPress={() => setCtrlOpen(true)} />
            <BarBtn icon="play" label="Resume" primary onPress={resume} />
          </>
        )}
      </View>

      <BottomSheet
        open={ctrlOpen}
        onClose={() => setCtrlOpen(false)}
        title="Controls"
        subtitle={shortRunId(run.id, startedMs)}
        maxHeightPct={0.75}
      >
        <View style={{ gap: 14 }}>
          {live ? (
            <View
              style={{
                padding: 13,
                borderRadius: 12,
                backgroundColor: c.raised,
                borderWidth: 1,
                borderColor: c.hairline,
              }}
            >
              <Text style={{ fontSize: 12.5, color: c.muted, lineHeight: 18 }}>
                The agent is working. Stop the run to send it new instructions.
              </Text>
            </View>
          ) : (
            <Field label={approval ? "Request changes" : "Send instructions"}>
              <TextInput
                value={msg}
                onChangeText={setMsg}
                multiline
                placeholder={
                  approval
                    ? "What should change before you approve?"
                    : "Message the agent — it takes a turn with your instructions."
                }
                placeholderTextColor={c.muted2}
                style={{
                  minHeight: 88,
                  textAlignVertical: "top",
                  backgroundColor: c.raised,
                  borderWidth: 1,
                  borderColor: c.hairline,
                  borderRadius: 11,
                  padding: 12,
                  color: c.fg,
                  fontSize: 13.5,
                  lineHeight: 19,
                }}
              />
              <Press
                onPress={sendInstruct}
                disabled={sending || !msg.trim()}
                style={{
                  marginTop: 10,
                  minHeight: 46,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  borderRadius: 12,
                  backgroundColor: c.fg,
                  opacity: sending || !msg.trim() ? 0.5 : 1,
                }}
              >
                <Icon name="spark" size={14} color={c.bg} />
                <Text style={{ color: c.bg, fontSize: 14, fontWeight: "600" }}>
                  {sending ? "Sending…" : "Send"}
                </Text>
              </Press>
            </Field>
          )}

          <View style={{ gap: 8 }}>
            {live ? (
              <SheetBtn icon="stop" label="Stop run" onPress={() => runAndClose(stop)} />
            ) : (
              <>
                {st !== "review" && !approval ? (
                  <SheetBtn icon="play" label="Resume run" onPress={() => runAndClose(resume)} />
                ) : null}
                <SheetBtn icon="x" label="Close run" onPress={() => runAndClose(closeRun)} />
              </>
            )}
          </View>
        </View>
      </BottomSheet>
    </View>
  );

  function runAndClose(fn: () => void | Promise<void>) {
    setCtrlOpen(false);
    void fn();
  }
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

function SheetBtn({
  icon,
  label,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Press
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        padding: 14,
        borderRadius: 12,
        backgroundColor: c.raised,
      }}
    >
      <Icon name={icon} size={16} color={c.fg} />
      <Text style={{ fontSize: 14, fontWeight: "500", color: c.fg }}>{label}</Text>
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
  onToggleCriterion,
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
  onToggleCriterion?: (cid: number, next: boolean) => void;
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
            <Elapsed
              startMs={startedMs}
              endMs={run.completedAt ? new Date(run.completedAt).getTime() : null}
              paused={!live}
              format="hms"
              style={{ fontSize: 11, color: c.muted }}
            />
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
            <View style={{ gap: 3 }}>
              {criteria.map((cr) => {
                const row = (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 6 }}>
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
                );
                return onToggleCriterion ? (
                  <Press key={cr.id} onPress={() => onToggleCriterion(cr.id, !cr.done)}>
                    {row}
                  </Press>
                ) : (
                  <View key={cr.id}>{row}</View>
                );
              })}
            </View>
          </Tile>
        </>
      ) : null}

      {/* transcript / chat */}
      <View style={{ height: 18 }} />
      <SectionHead title="Transcript" />
      <View style={{ height: 4 }} />
      <Transcript messages={run.messages} emptyLabel="No activity yet." />
    </ScrollView>
  );
}

