import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { DetailHeader, RoundButton } from "@/components/shell";
import { BottomSheet } from "@/components/BottomSheet";
import { Icon } from "@/components/Icon";
import { StateIcon } from "@/components/StateIcon";
import { Badge, Field, Mono, MonoTag, Press, SectionHead, StatePill, Tile } from "@/components/primitives";
import { MiniMarkdown } from "@/components/MiniMarkdown";
import { AgentPicker, type AgentConfig } from "@/components/AgentPicker";
import { Loading } from "@/components/Loading";
import { useData } from "@/data/DataProvider";
import { useAuth } from "@/data/AuthProvider";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import type { AgentSession, TaskFull, TaskState } from "@/lib/types";
import { STATE_LABEL, TASK_TRANSITIONS, isTerminalState, taskGlyph } from "@/lib/task-state";
import { money, prNumber } from "@/lib/format";
import { useTheme } from "@/theme";

const ACTIVE = new Set(["pending", "preparing", "running", "pushing"]);
const DEFAULT_AGENT: AgentConfig = { personaId: "", backend: null, model: null, thinkingLevel: null };

export default function TaskDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = String(id);
  const { sessions, plans, personas, refresh } = useData();
  const { user } = useAuth();

  const [task, setTask] = useState<TaskFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stateOpen, setStateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [newCrit, setNewCrit] = useState("");
  const [newNote, setNewNote] = useState("");

  const load = useCallback(async () => {
    try {
      setTask(await api.task(taskId));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load task");
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const runs = useMemo(
    () =>
      sessions
        .filter((s) => s.taskId === taskId)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [sessions, taskId]
  );
  const planTitle = useMemo(
    () => (task ? plans.find((p) => p.id === task.planId)?.title || task.planId : ""),
    [task, plans]
  );
  const prNum = prNumber(runs.find((r) => r.prUrl)?.prUrl ?? null);

  const transition = async (next: TaskState) => {
    setStateOpen(false);
    try {
      await api.transitionTask(taskId, next);
      toast(`→ ${STATE_LABEL[next]}`);
      await load();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Transition failed");
    }
  };
  const toggleCriterion = async (cid: number, done: boolean) => {
    try {
      setTask(await api.updateCriterion(taskId, cid, { done }));
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed");
    }
  };
  const addCriterion = async () => {
    const text = newCrit.trim();
    if (!text) return;
    try {
      setTask(await api.addCriterion(taskId, text));
      setNewCrit("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Add failed");
    }
  };
  const addNote = async () => {
    const body = newNote.trim();
    if (!body) return;
    try {
      setTask(await api.addNote(taskId, body, user?.email || task?.assignee || "operator"));
      setNewNote("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Add note failed");
    }
  };

  if (!task) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <DetailHeader onBack={() => router.back()} backLabel="Back" />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {err ? <Text style={{ color: c.muted }}>{err}</Text> : <Loading />}
        </View>
      </View>
    );
  }

  const glyph = taskGlyph(task.state);
  const done = task.criteria.filter((x) => x.done).length;
  const terminal = isTerminalState(task.state);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <DetailHeader
        onBack={() => router.back()}
        backLabel="Back"
        right={<RoundButton icon="spark" onPress={() => setRunOpen(true)} />}
      >
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatePill state={glyph} label={STATE_LABEL[task.state]} size="xs" />
            <MonoTag>{task.id}</MonoTag>
            {prNum != null ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Icon name="pr" size={12} color={c.sReview} />
                <Text style={{ color: c.sReview, fontSize: 11.5, fontWeight: "500" }}>#{prNum}</Text>
              </View>
            ) : null}
          </View>
          <Text style={{ marginTop: 9, fontSize: 18, fontWeight: "600", color: c.fg, lineHeight: 23 }}>{task.title}</Text>
        </View>
      </DetailHeader>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 28 }}>
        {/* meta */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <MetaChip label="State" onPress={terminal ? undefined : () => setStateOpen(true)}>
            <StatePill state={glyph} label={STATE_LABEL[task.state]} size="xs" />
          </MetaChip>
          {task.assignee ? <MetaChip label="Assignee">{<Mono style={{ fontSize: 12, color: c.fg }}>{task.assignee}</Mono>}</MetaChip> : null}
          {planTitle ? (
            <MetaChip label="Plan" onPress={() => router.push(`/plan/${task.planId}`)}>
              <Text numberOfLines={1} style={{ fontSize: 12.5, color: c.sReview }}>
                {planTitle}
              </Text>
            </MetaChip>
          ) : null}
          {task.repoId ? <MetaChip label="Repo">{<Mono style={{ fontSize: 11.5, color: c.fg }}>{task.repoId}</Mono>}</MetaChip> : null}
        </View>

        {task.tags.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {task.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </View>
        ) : null}

        {task.dependencies.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 10 }}>
            <Mono style={{ fontSize: 10.5, color: c.muted2 }}>depends on</Mono>
            {task.dependencies.map((d) => (
              <Press key={d} onPress={() => router.push(`/task/${d}`)}>
                <MonoTag dim>{d}</MonoTag>
              </Press>
            ))}
          </View>
        ) : null}

        {/* description */}
        <View style={{ height: 16 }} />
        <Tile label="Description">
          <MiniMarkdown body={task.body} />
        </Tile>

        {/* criteria */}
        <View style={{ height: 14 }} />
        <Tile label={`Acceptance criteria · ${done}/${task.criteria.length}`}>
          <View style={{ gap: 3 }}>
            {task.criteria.map((cr) => (
              <Press
                key={cr.id}
                onPress={() => toggleCriterion(cr.id, !cr.done)}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 6 }}
              >
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
              </Press>
            ))}
            {task.criteria.length === 0 ? <Text style={{ color: c.muted2, fontSize: 12 }}>No criteria yet.</Text> : null}
          </View>
          <InlineAdd
            value={newCrit}
            onChange={setNewCrit}
            onSubmitEditing={addCriterion}
            placeholder="Add a criterion…"
          />
        </Tile>

        {/* notes */}
        <View style={{ height: 14 }} />
        <Tile label={`Notes · ${task.notes.length}`}>
          <View style={{ gap: 10 }}>
            {task.notes.map((n) => (
              <View key={n.id} style={{ gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Mono style={{ fontSize: 10.5, color: c.muted }}>{n.author}</Mono>
                  <Mono style={{ fontSize: 10, color: c.muted2 }}>{new Date(n.createdAt).toLocaleDateString()}</Mono>
                </View>
                <Text style={{ fontSize: 12.5, color: c.fg, lineHeight: 18 }}>{n.body}</Text>
              </View>
            ))}
            {task.notes.length === 0 ? <Text style={{ color: c.muted2, fontSize: 12 }}>No notes yet.</Text> : null}
          </View>
          <InlineAdd value={newNote} onChange={setNewNote} onSubmitEditing={addNote} placeholder="Add a note…" />
        </Tile>

        {/* runs / inbox */}
        <View style={{ height: 18 }} />
        <SectionHead title="Agent runs" count={runs.length} />
        <View style={{ gap: 8 }}>
          {runs.length === 0 ? (
            <Text style={{ color: c.muted2, fontSize: 12 }}>No runs yet — start an agent.</Text>
          ) : (
            runs.map((r) => <RunRow key={r.id} run={r} onPress={() => router.push(`/run/${r.id}`)} />)
          )}
        </View>
      </ScrollView>

      {/* sticky action */}
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
        {!terminal ? (
          <Press
            onPress={() => setStateOpen(true)}
            style={{
              minHeight: 46,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              borderRadius: 12,
              backgroundColor: c.surface,
              borderWidth: 1,
              borderColor: c.hairline,
            }}
          >
            <Icon name="edit" size={14} color={c.fg} />
            <Text style={{ fontSize: 13.5, fontWeight: "500", color: c.fg }}>State</Text>
          </Press>
        ) : null}
        <Press
          onPress={() => setRunOpen(true)}
          style={{
            flex: 1,
            minHeight: 46,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            borderRadius: 12,
            backgroundColor: c.fg,
          }}
        >
          <Icon name="spark" size={14} color={c.bg} />
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: c.bg }}>{runs.length ? "Message agent" : "Run agent"}</Text>
        </Press>
      </View>

      <StateSheet open={stateOpen} onClose={() => setStateOpen(false)} state={task.state} onPick={transition} />
      <RunAgentSheet
        open={runOpen}
        onClose={() => setRunOpen(false)}
        task={task}
        personas={personas}
        hasRun={runs.length > 0}
        onToast={toast}
        onGo={(runId) => {
          setRunOpen(false);
          refresh();
          router.push(`/run/${runId}`);
        }}
      />
    </View>
  );
}

function MetaChip({ label, children, onPress }: { label: string; children: React.ReactNode; onPress?: () => void }) {
  const { c } = useTheme();
  const inner = (
    <View
      style={{
        paddingVertical: 8,
        paddingHorizontal: 11,
        borderRadius: 10,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        gap: 3,
        minWidth: 92,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Mono style={{ fontSize: 9, color: c.muted2, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</Mono>
        {onPress ? <Icon name="chev-r" size={10} color={c.muted2} /> : null}
      </View>
      {children}
    </View>
  );
  return onPress ? <Press onPress={onPress}>{inner}</Press> : inner;
}

function InlineAdd({
  value,
  onChange,
  onSubmitEditing,
  placeholder,
}: {
  value: string;
  onChange: (s: string) => void;
  onSubmitEditing: () => void;
  placeholder: string;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 }}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted2}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
        style={{
          flex: 1,
          backgroundColor: c.raised,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 10,
          paddingHorizontal: 11,
          paddingVertical: 9,
          color: c.fg,
          fontSize: 12.5,
        }}
      />
      <Press
        onPress={onSubmitEditing}
        disabled={!value.trim()}
        style={{
          width: 38,
          height: 38,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 10,
          backgroundColor: value.trim() ? c.fg : c.raised,
        }}
      >
        <Icon name="plus" size={16} color={value.trim() ? c.bg : c.muted2} />
      </Press>
    </View>
  );
}

function RunRow({ run, onPress }: { run: AgentSession; onPress: () => void }) {
  const { c } = useTheme();
  const live = ACTIVE.has(run.status);
  const pr = prNumber(run.prUrl);
  return (
    <Press
      onPress={onPress}
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
      <StateIcon state={live ? "in_progress" : run.status === "completed" ? "done" : "blocked"} size={14} spin={live} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono style={{ fontSize: 11, color: c.fg }}>run #{run.id}</Mono>
        <Mono style={{ fontSize: 10, color: c.muted2, marginTop: 2 }}>
          {run.status}
          {run.model ? ` · ${run.model}` : ""}
        </Mono>
      </View>
      {pr != null ? <Mono style={{ fontSize: 11, color: c.sReview }}>#{pr}</Mono> : null}
      <Mono style={{ fontSize: 11, color: c.muted }}>{money(run.totalCostUsd ?? 0)}</Mono>
      <Icon name="chev-r" size={14} color={c.muted} />
    </Press>
  );
}

function StateSheet({
  open,
  onClose,
  state,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  state: TaskState;
  onPick: (s: TaskState) => void;
}) {
  const { c } = useTheme();
  const next = TASK_TRANSITIONS[state];
  return (
    <BottomSheet open={open} onClose={onClose} title="Change state" subtitle={STATE_LABEL[state]} maxHeightPct={0.6}>
      <View style={{ gap: 8 }}>
        {next.length === 0 ? (
          <Text style={{ color: c.muted2, fontSize: 13 }}>This state is terminal — no transitions.</Text>
        ) : (
          next.map((s) => (
            <Press
              key={s}
              onPress={() => onPick(s)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 11,
                padding: 14,
                borderRadius: 12,
                backgroundColor: c.raised,
              }}
            >
              <StateIcon state={taskGlyph(s)} size={14} />
              <Text style={{ fontSize: 14, fontWeight: "500", color: c.fg }}>{STATE_LABEL[s]}</Text>
            </Press>
          ))
        )}
      </View>
    </BottomSheet>
  );
}

function RunAgentSheet({
  open,
  onClose,
  task,
  personas,
  hasRun,
  onToast,
  onGo,
}: {
  open: boolean;
  onClose: () => void;
  task: TaskFull;
  personas: import("@/lib/types").Persona[];
  hasRun: boolean;
  onToast: (m: string) => void;
  onGo: (runId: number) => void;
}) {
  const { c } = useTheme();
  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agent.personaId && personas.length) {
      const impl = personas.find((p) => p.id === "implementor") || personas[0];
      setAgent((a) => ({ ...a, personaId: impl.id }));
    }
  }, [personas, agent.personaId]);

  const launch = async () => {
    if (busy) return;
    setBusy(true);
    const text = message.trim();
    const seed = !text;
    try {
      const { runId, created } = await api.attachedRun(task.id, {
        seed,
        personaId: seed ? undefined : agent.personaId || undefined,
        model: agent.model,
        backend: agent.backend,
        thinkingLevel: seed ? undefined : agent.thinkingLevel,
      });
      if (!seed) {
        const body = created ? `${taskPrefix(task)}\n\n---\n\n${text}` : text;
        await api.sendRunMessage(runId, body, (m) => onToast(`Not delivered: ${m}`));
      }
      setMessage("");
      onGo(runId);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Could not start agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={hasRun ? "Message agent" : "Run agent"}
      subtitle={task.id}
      maxHeightPct={0.9}
    >
      <View style={{ gap: 18 }}>
        <AgentPicker personas={personas} value={agent} onChange={setAgent} active={open} />

        <Field label="Message (optional)">
          <TextInput
            value={message}
            onChangeText={setMessage}
            multiline
            placeholder="Leave empty to run the implement task; type to chat with the agent."
            placeholderTextColor={c.muted2}
            style={{
              minHeight: 84,
              textAlignVertical: "top",
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 11,
              padding: 12,
              color: c.fg,
              fontSize: 13,
              lineHeight: 19,
            }}
          />
        </Field>

        <Press
          onPress={launch}
          disabled={busy}
          style={{
            minHeight: 50,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            borderRadius: 13,
            backgroundColor: c.fg,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Icon name={message.trim() ? "spark" : "play"} size={15} color={c.bg} />
          <Text style={{ color: c.bg, fontSize: 15, fontWeight: "600" }}>
            {busy ? "Starting…" : message.trim() ? "Send & open" : hasRun ? "Open agent" : "Start agent"}
          </Text>
        </Press>
      </View>
    </BottomSheet>
  );
}

function taskPrefix(task: TaskFull): string {
  const crit = task.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
  return [
    `Task ${task.id}: ${task.title}`,
    task.body ? `\n${task.body}` : "",
    crit ? `\nAcceptance criteria:\n${crit}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
