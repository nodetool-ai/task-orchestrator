import React, { useMemo } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";

import { AppHeader, BrandMark, FloorSubtitle, RoundButton, StatusStrip } from "@/components/shell";
import { SectionHead, EmptyNote, LiveDot, Mono } from "@/components/primitives";
import { StateIcon } from "@/components/StateIcon";
import { RunCard, ReviewCard, BlockedCard, ShippedItem } from "@/components/cards";
import { RefreshScroll } from "@/components/RefreshScroll";
import { Loading } from "@/components/Loading";
import { useData } from "@/data/DataProvider";
import { useSheets } from "@/data/SheetsProvider";
import { useToast } from "@/components/Toast";
import { buildFloor } from "@/lib/model";
import { fmtTok, money } from "@/lib/format";
import { api } from "@/lib/api";
import { useTheme } from "@/theme";

export default function FloorScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { openResume, openSearch, openSettings } = useSheets();
  const { sessions, tasks, plans, personas, loading, error, refresh } = useData();

  const floor = useMemo(() => buildFloor(sessions, tasks, plans), [sessions, tasks, plans]);
  const repoCount = useMemo(
    () => new Set(plans.flatMap((p) => p.repos.map((r) => r.id))).size,
    [plans]
  );

  const cells = [
    { state: "in_progress" as const, label: "Running", n: floor.running.length, live: floor.running.length > 0 },
    { state: "review" as const, label: "Review", n: floor.review.length },
    { state: "blocked" as const, label: "Stuck", n: floor.blocked.length },
    { state: "todo" as const, label: "Queue", n: floor.queue.length },
    { state: "done" as const, label: "Shipped", n: floor.shipped.length },
  ];

  const stop = async (runId: number, shortId: string) => {
    try {
      await api.cancelRun(runId);
      toast(`Stopped ${shortId}`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Stop failed");
    }
  };
  const approve = async (taskId: string, prNum: number | null) => {
    try {
      await api.transitionTask(taskId, "done");
      toast(prNum ? `Approved #${prNum}` : "Marked done");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not approve");
    }
  };
  const changes = async (taskId: string) => {
    try {
      await api.transitionTask(taskId, "in_progress", { assignee: "claude-agent" });
      toast("Requested changes");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
  };

  const header = (
    <AppHeader
      title="Pi Factory"
      left={<BrandMark onPress={openSettings} />}
      subtitle={<FloorSubtitle personas={personas.length} repos={repoCount} />}
      right={<RoundButton icon="search" onPress={openSearch} />}
    />
  );

  if (loading && sessions.length === 0 && !error) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        {header}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Loading label="Loading the floor…" />
        </View>
      </View>
    );
  }

  return (
    <RefreshScroll header={header}>
      {error && sessions.length === 0 ? (
        <EmptyNote>{error}</EmptyNote>
      ) : null}

      <View style={{ paddingHorizontal: 16 }}>
        <StatusStrip cells={cells} />
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10, paddingHorizontal: 4 }}>
          {[
            ["Cost today", money(floor.costTotal)],
            ["Tokens in", fmtTok(floor.tokensIn)],
            ["Tokens out", fmtTok(floor.tokensOut)],
          ].map(([label, value], i) => (
            <View key={label} style={{ flexDirection: "row", alignItems: "center" }}>
              {i > 0 ? <View style={{ width: 1, height: 22, backgroundColor: c.hairline, marginHorizontal: 14 }} /> : null}
              <View style={{ gap: 1 }}>
                <Mono style={{ fontSize: 13, color: c.fg, fontWeight: "500" }}>{value}</Mono>
                <Text style={{ fontSize: 9.5, color: c.muted2, fontWeight: "600", letterSpacing: 0.5 }}>
                  {label.toUpperCase()}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={{ height: 22 }} />

      <View style={{ paddingHorizontal: 16 }}>
        <SectionHead glyph={<LiveDot size={11} />} title="On the floor" count={floor.running.length} />
      </View>
      {floor.running.length ? (
        floor.running.map((r) => (
          <RunCard
            key={r.runId}
            run={r}
            onOpen={() => router.push(`/run/${r.runId}`)}
            onPause={() => toast(`Pause isn't available from mobile yet`)}
            onStop={() => stop(r.runId, r.shortId)}
          />
        ))
      ) : (
        <EmptyNote>Nothing running right now.</EmptyNote>
      )}

      <View style={{ height: 18 }} />
      <View style={{ paddingHorizontal: 16 }}>
        <SectionHead glyph={<StateIcon state="review" size={13} />} title="Needs your review" count={floor.review.length} />
      </View>
      {floor.review.length ? (
        floor.review.map((r) => (
          <ReviewCard
            key={r.taskId}
            item={r}
            onOpen={() => (r.runId ? router.push(`/run/${r.runId}`) : toast(r.taskId))}
            onApprove={() => approve(r.taskId, r.prNum)}
            onChanges={() => changes(r.taskId)}
          />
        ))
      ) : (
        <EmptyNote>No PRs waiting.</EmptyNote>
      )}

      <View style={{ height: 18 }} />
      <View style={{ paddingHorizontal: 16 }}>
        <SectionHead glyph={<StateIcon state="blocked" size={13} />} title="Stuck" count={floor.blocked.length} />
      </View>
      {floor.blocked.length ? (
        floor.blocked.map((r) => (
          <BlockedCard key={r.runId} run={r} onOpen={() => router.push(`/run/${r.runId}`)} onResume={() => openResume(r)} />
        ))
      ) : (
        <EmptyNote>Nothing stuck.</EmptyNote>
      )}

      <View style={{ height: 18 }} />
      <View style={{ paddingHorizontal: 16 }}>
        <SectionHead glyph={<StateIcon state="done" size={13} />} title="Shipped today" count={floor.shipped.length} />
        <View style={{ gap: 8 }}>
          {floor.shipped.length ? (
            floor.shipped.map((s) => <ShippedItem key={s.runId} item={s} />)
          ) : (
            <Text style={{ color: c.muted2, fontSize: 12, paddingVertical: 8, textAlign: "center" }}>
              Nothing shipped yet today.
            </Text>
          )}
        </View>
      </View>
    </RefreshScroll>
  );
}
