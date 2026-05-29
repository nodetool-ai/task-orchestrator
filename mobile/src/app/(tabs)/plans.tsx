import React, { useMemo } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";

import { AppHeader } from "@/components/shell";
import { SectionHead, EmptyNote, Mono, Press, ProgressBar, StatePill } from "@/components/primitives";
import { StateIcon } from "@/components/StateIcon";
import { Icon } from "@/components/Icon";
import { RefreshScroll } from "@/components/RefreshScroll";
import { useData } from "@/data/DataProvider";
import { buildPlanCards, planGlyphState, type PlanCardVM } from "@/lib/model";
import { useTheme } from "@/theme";

export default function PlansScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { plans, tasks } = useData();

  const cards = useMemo(() => buildPlanCards(plans, tasks), [plans, tasks]);
  const active = cards.filter((p) => p.state !== "done" && p.state !== "cancelled");
  const done = cards.filter((p) => p.state === "done");

  const Card = ({ p }: { p: PlanCardVM }) => {
    const glyph = planGlyphState(p.state);
    return (
      <Press
        onPress={() => router.push(`/plan/${p.id}`)}
        scale={0.99}
        dim={0.85}
        style={{ padding: 15, backgroundColor: c.surface, borderWidth: 1, borderColor: c.hairline, borderRadius: 16 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatePill state={glyph} size="xs" />
          <View style={{ flex: 1 }} />
          {p.owner ? <Mono style={{ fontSize: 10.5, color: c.muted2 }}>{p.owner}</Mono> : null}
        </View>
        <Text style={{ marginTop: 9, fontSize: 15.5, fontWeight: "600", color: c.fg, letterSpacing: -0.2, lineHeight: 20 }}>
          {p.title}
        </Text>
        {p.goal ? (
          <Text numberOfLines={2} style={{ marginTop: 5, fontSize: 12.5, color: c.muted, lineHeight: 18 }}>
            {p.goal}
          </Text>
        ) : null}
        <View style={{ marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <ProgressBar
              value={p.done}
              max={Math.max(1, p.total)}
              color={p.state === "done" ? c.sDone : c.sProgress}
              height={4}
            />
          </View>
          <Mono style={{ fontSize: 11, color: c.muted }}>
            {p.done}/{p.total}
          </Mono>
          <Icon name="chev-r" size={15} stroke={2} color={c.muted} />
        </View>
      </Press>
    );
  };

  return (
    <RefreshScroll
      header={
        <AppHeader
          title="Plans"
          subtitle={
            <Text style={{ color: c.muted, fontSize: 11.5 }}>
              {active.length} active · {done.length} done
            </Text>
          }
        />
      }
    >
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        {active.length ? active.map((p) => <Card key={p.id} p={p} />) : <EmptyNote>No active plans.</EmptyNote>}
      </View>
      {done.length ? (
        <>
          <View style={{ height: 18 }} />
          <View style={{ paddingHorizontal: 16 }}>
            <SectionHead glyph={<StateIcon state="done" size={13} />} title="Shipped" count={done.length} />
            <View style={{ gap: 10 }}>
              {done.map((p) => (
                <Card key={p.id} p={p} />
              ))}
            </View>
          </View>
        </>
      ) : null}
    </RefreshScroll>
  );
}
