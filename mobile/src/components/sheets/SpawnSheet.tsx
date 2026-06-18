import React, { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { BottomSheet } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { StateIcon } from "../StateIcon";
import { Field, Mono, Press } from "../primitives";
import { useTheme, mono } from "@/theme";
import { api } from "@/lib/api";
import type { Persona } from "@/lib/types";
import type { QueueVM } from "@/lib/model";

const ROLE_ICON: Record<string, IconName> = {
  planner: "plans",
  designer: "edit",
  implementor: "code",
  reviewer: "check",
  qa: "check",
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
  const [personaId, setPersonaId] = useState<string>("");
  const [budget, setBudget] = useState("25");
  const [autoPR, setAutoPR] = useState(true);
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
    if (!personaId && personas.length) {
      const impl = personas.find((p) => p.id === "implementor") || personas[0];
      setPersonaId(impl.id);
    }
  }, [personas, personaId]);

  const persona = useMemo(() => personas.find((p) => p.id === personaId), [personas, personaId]);

  const spawn = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await api.spawnRun({
        taskId: picked.id,
        planId: picked.planId,
        personaId: personaId || undefined,
        initialPrompt: prompt,
        budgetUsd: Number(budget) || undefined,
      });
      onClose();
      onToast(`Spawned ${persona?.name || personaId} on ${picked.id}`);
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

        <Field label="Persona">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {personas.map((p) => {
              const active = p.id === personaId;
              return (
                <Press
                  key={p.id}
                  onPress={() => setPersonaId(p.id)}
                  style={{
                    width: "48%",
                    gap: 6,
                    padding: 11,
                    borderRadius: 11,
                    backgroundColor: active ? c.raised : c.surface,
                    borderWidth: 1,
                    borderColor: active ? c.hairlineStrong : c.hairline,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        backgroundColor: active ? c.raised2 : c.raised,
                        borderWidth: 1,
                        borderColor: c.hairline,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name={ROLE_ICON[p.id] || "user"} size={11} color={active ? c.fg : c.muted} />
                    </View>
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: active ? c.fg : c.muted }}>
                      {p.name}
                    </Text>
                  </View>
                </Press>
              );
            })}
          </View>
        </Field>

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

        <View style={{ flexDirection: "row", gap: 14 }}>
          <Field label="Budget cap" style={{ flex: 1 }}>
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
          <Field label="On completion" style={{ flex: 1 }}>
            <Press
              onPress={() => setAutoPR((v) => !v)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                padding: 12,
                backgroundColor: c.raised,
                borderWidth: 1,
                borderColor: c.hairline,
                borderRadius: 11,
                minHeight: 44,
              }}
            >
              <View
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: c.hairlineStrong,
                  backgroundColor: autoPR ? c.fg : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {autoPR ? <Icon name="check" size={12} stroke={3} color={c.bg} /> : null}
              </View>
              <Text style={{ fontSize: 12.5, color: c.fg }}>Open PR</Text>
            </Press>
          </Field>
        </View>

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
