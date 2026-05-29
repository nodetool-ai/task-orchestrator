import React, { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { AppHeader } from "@/components/shell";
import { EmptyNote, Press } from "@/components/primitives";
import { QueueCard } from "@/components/cards";
import { RefreshScroll } from "@/components/RefreshScroll";
import { useData } from "@/data/DataProvider";
import { useSheets } from "@/data/SheetsProvider";
import { buildFloor } from "@/lib/model";
import { useTheme } from "@/theme";

export default function QueueScreen() {
  const { c } = useTheme();
  const { sessions, tasks, plans } = useData();
  const { openSpawn } = useSheets();
  const [filter, setFilter] = useState<string>("all");

  const floor = useMemo(() => buildFloor(sessions, tasks, plans), [sessions, tasks, plans]);
  const queue = floor.queue;
  const planNames = useMemo(() => Array.from(new Set(queue.map((t) => t.planTitle).filter(Boolean))), [queue]);
  const rows = filter === "all" ? queue : queue.filter((t) => t.planTitle === filter);

  return (
    <RefreshScroll
      header={
        <AppHeader
          title="Queue"
          subtitle={<Text style={{ color: c.muted, fontSize: 11.5 }}>{queue.length} tasks ready to spawn</Text>}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 7 }}
          >
            {["all", ...planNames].map((p) => {
              const active = filter === p;
              const label = p === "all" ? "All plans" : p.replace(/ — .*/, "").replace(/:.*/, "");
              return (
                <Press
                  key={p}
                  onPress={() => setFilter(p)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 99,
                    borderWidth: 1,
                    borderColor: active ? "transparent" : c.hairline,
                    backgroundColor: active ? c.fg : c.surface,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "500", color: active ? c.bg : c.muted }}>{label}</Text>
                </Press>
              );
            })}
          </ScrollView>
        </AppHeader>
      }
    >
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {rows.length ? (
          rows.map((t) => <QueueCard key={t.id} item={t} onSpawn={() => openSpawn(t)} />)
        ) : (
          <EmptyNote>Queue is empty. Nothing to spawn.</EmptyNote>
        )}
      </View>
    </RefreshScroll>
  );
}
