import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { StateIcon } from "../StateIcon";
import { Mono, Press } from "../primitives";
import { useTheme, type RunState } from "@/theme";
import type { FloorData } from "@/lib/model";
import type { PlanCardVM } from "@/lib/model";

interface Row {
  kind: "Run" | "Task" | "Plan";
  id: string;
  title: string;
  sub: string;
  state: RunState;
  go: () => void;
}

export function SearchSheet({
  open,
  onClose,
  floor,
  plans,
  onOpenRun,
  onOpenPlan,
}: {
  open: boolean;
  onClose: () => void;
  floor: FloorData;
  plans: PlanCardVM[];
  onOpenRun: (id: number) => void;
  onOpenPlan: (id: string) => void;
}) {
  const { c } = useTheme();
  const [q, setQ] = useState("");
  const ref = useRef<TextInput>(null);

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 280);
    else setQ("");
  }, [open]);

  const items = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...floor.running.map((r) => ({
        kind: "Run" as const,
        id: r.shortId,
        title: r.title,
        sub: r.model || "",
        state: "in_progress" as RunState,
        go: () => onOpenRun(r.runId),
      })),
      ...floor.blocked.map((r) => ({
        kind: "Run" as const,
        id: r.shortId,
        title: r.title,
        sub: r.reason || "",
        state: "blocked" as RunState,
        go: () => onOpenRun(r.runId),
      })),
      ...floor.queue.map((t) => ({
        kind: "Task" as const,
        id: t.id,
        title: t.title,
        sub: t.planTitle,
        state: "todo" as RunState,
        go: () => onClose(),
      })),
      ...plans.map((p) => ({
        kind: "Plan" as const,
        id: p.id,
        title: p.title,
        sub: `${p.done}/${p.total}`,
        state: (p.state === "done" ? "done" : "in_progress") as RunState,
        go: () => onOpenPlan(p.id),
      })),
    ];
    if (!q.trim()) return all;
    const ql = q.toLowerCase();
    return all.filter((i) => (i.id + i.title + i.sub + i.kind).toLowerCase().includes(ql));
  }, [q, floor, plans, onOpenRun, onOpenPlan, onClose]);

  return (
    <BottomSheet open={open} onClose={onClose} maxHeightPct={0.92}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          padding: 12,
          backgroundColor: c.raised,
          borderRadius: 11,
          marginBottom: 12,
        }}
      >
        <Icon name="search" size={15} color={c.muted} />
        <TextInput
          ref={ref}
          value={q}
          onChangeText={setQ}
          placeholder="Search runs, tasks, plans…"
          placeholderTextColor={c.muted2}
          style={{ flex: 1, color: c.fg, fontSize: 15, padding: 0 }}
        />
        {q ? (
          <Press onPress={() => setQ("")}>
            <Icon name="x" size={15} color={c.muted} />
          </Press>
        ) : null}
      </View>
      <View style={{ gap: 4 }}>
        {items.length === 0 ? (
          <Text style={{ paddingVertical: 30, textAlign: "center", color: c.muted2, fontSize: 13 }}>No matches.</Text>
        ) : null}
        {items.slice(0, 24).map((it, i) => (
          <Press
            key={`${it.kind}-${it.id}-${i}`}
            onPress={() => {
              onClose();
              it.go();
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 10 }}
          >
            <StateIcon state={it.state} size={14} spin={it.state === "in_progress"} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, color: c.fg }}>
                {it.title}
              </Text>
              {it.sub ? (
                <Text numberOfLines={1} style={{ color: c.muted2, fontSize: 11, marginTop: 1 }}>
                  {it.sub}
                </Text>
              ) : null}
            </View>
            <Mono style={{ fontSize: 10, color: c.muted2 }}>{it.kind}</Mono>
          </Press>
        ))}
      </View>
    </BottomSheet>
  );
}
