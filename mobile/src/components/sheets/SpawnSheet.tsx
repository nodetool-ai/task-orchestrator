import React, { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { BottomSheet } from "../BottomSheet";
import { AgentPicker, type AgentConfig } from "../AgentPicker";
import { Icon } from "../Icon";
import { StateIcon } from "../StateIcon";
import { Field, Mono, Press } from "../primitives";
import { useTheme, mono } from "@/theme";
import { api } from "@/lib/api";
import type { Persona } from "@/lib/types";
import type { QueueVM } from "@/lib/model";

const DEFAULT_AGENT: AgentConfig = {
  personaId: "",
  backend: null,
  model: null,
  thinkingLevel: null,
};

export function SpawnSheet({
  open,
  task,
  queue,
  personas,
  onClose,
  onToast,
  onRefresh,
}: {
  open: boolean;
  task: QueueVM | null;
  queue: QueueVM[];
  personas: Persona[];
  onClose: () => void;
  onToast: (m: string) => void;
  onRefresh: () => void;
}) {
  const { c } = useTheme();
  const [picked, setPicked] = useState<QueueVM | null>(task);
  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [budget, setBudget] = useState("25");
  const [taskPick, setTaskPick] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = task || queue[0] || null;
    setPicked(t);
    setTaskPick(false);
  }, [open, task, queue]);

  useEffect(() => {
    if (picked) {
      setPrompt(
        `Pick up ${picked.id} from the queue.\n\nFollow the acceptance criteria literally. Open a PR when all criteria pass.`
      );
    }
  }, [picked]);

  useEffect(() => {
    if (!agent.personaId && personas.length) {
      const impl = personas.find((p) => p.id === "implementor") || personas[0];
      setAgent((a) => ({ ...a, personaId: impl.id }));
    }
  }, [personas, agent.personaId]);

  const persona = useMemo(() => personas.find((p) => p.id === agent.personaId), [personas, agent.personaId]);

  const spawn = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await api.spawnRun({
        taskId: picked.id,
        planId: picked.planId,
        personaId: agent.personaId || undefined,
        backend: agent.backend,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        initialPrompt: prompt,
        budgetUsd: Number(budget) || undefined,
      });
      onClose();
      onToast(`Spawned ${persona?.name || agent.personaId} on ${picked.id}`);
      onRefresh();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Spawn failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Spawn agent" subtitle="launches in a fresh worktree">
      <View style={{ gap: 18 }}>
        <Field label="Task">
          <Press
            onPress={() => setTaskPick((v) => !v)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              padding: 13,
              borderRadius: 12,
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
            }}
          >
            <StateIcon state="todo" size={13} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Mono style={{ fontSize: 10.5, color: c.muted2 }}>{picked?.id || "—"}</Mono>
              <Text numberOfLines={2} style={{ fontSize: 13.5, color: c.fg, marginTop: 2, lineHeight: 18 }}>
                {picked?.title || "Select a task"}
              </Text>
            </View>
            <Icon name="chev-d" size={14} color={c.muted} />
          </Press>
          {taskPick ? (
            <View style={{ marginTop: 8, gap: 6, maxHeight: 200 }}>
              {queue.map((t) => {
                const active = t.id === picked?.id;
                return (
                  <Press
                    key={t.id}
                    onPress={() => {
                      setPicked(t);
                      setTaskPick(false);
                    }}
                    style={{
                      flexDirection: "row",
                      gap: 9,
                      padding: 10,
                      borderRadius: 10,
                      backgroundColor: active ? c.raised : "transparent",
                      borderWidth: 1,
                      borderColor: active ? c.hairlineStrong : c.hairline,
                    }}
                  >
                    <StateIcon state="todo" size={12} />
                    <Text numberOfLines={2} style={{ flex: 1, fontSize: 12.5, color: c.fg, lineHeight: 17 }}>
                      {t.title}
                    </Text>
                  </Press>
                );
              })}
            </View>
          ) : null}
          {picked ? (
            <Text style={{ color: c.muted2, fontSize: 12, marginTop: 7 }}>
              {picked.planTitle} · {picked.criteria} acceptance criteria
            </Text>
          ) : null}
        </Field>

        <AgentPicker personas={personas} value={agent} onChange={setAgent} active={open} />

        <Field label="Initial prompt">
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            style={{
              minHeight: 96,
              textAlignVertical: "top",
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 11,
              padding: 12,
              color: c.fg,
              fontFamily: mono,
              fontSize: 11.5,
              lineHeight: 18,
            }}
          />
        </Field>

        <Field label="Budget cap">
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              padding: 12,
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 11,
            }}
          >
            <Mono style={{ fontSize: 14, color: c.muted2 }}>$</Mono>
            <TextInput
              value={budget}
              onChangeText={setBudget}
              keyboardType="number-pad"
              style={{ flex: 1, color: c.fg, fontFamily: mono, fontSize: 14, padding: 0 }}
            />
          </View>
        </Field>

        <Press
          onPress={spawn}
          disabled={busy || !picked}
          style={{
            minHeight: 50,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            borderRadius: 13,
            backgroundColor: c.fg,
          }}
        >
          <Icon name="spark" size={15} color={c.bg} />
          <Text style={{ color: c.bg, fontSize: 15, fontWeight: "600" }}>{busy ? "Spawning…" : "Spawn run"}</Text>
        </Press>
      </View>
    </BottomSheet>
  );
}
