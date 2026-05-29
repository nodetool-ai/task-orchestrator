import React, { useMemo } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";

import { AppHeader } from "@/components/shell";
import { EmptyNote, Mono, Tile } from "@/components/primitives";
import { ReviewCard } from "@/components/cards";
import { RefreshScroll } from "@/components/RefreshScroll";
import { useData } from "@/data/DataProvider";
import { useToast } from "@/components/Toast";
import { buildFloor } from "@/lib/model";
import { money } from "@/lib/format";
import { api } from "@/lib/api";
import { useTheme } from "@/theme";

export default function ReviewScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { sessions, tasks, plans, refresh } = useData();

  const floor = useMemo(() => buildFloor(sessions, tasks, plans), [sessions, tasks, plans]);
  const review = floor.review;
  const totalSpend = review.reduce((a, r) => a + r.cost, 0);

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

  return (
    <RefreshScroll
      header={
        <AppHeader
          title="Review"
          subtitle={<Text style={{ color: c.muted, fontSize: 11.5 }}>{review.length} PRs waiting on you</Text>}
        />
      }
    >
      <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Tile label="Open PRs" style={{ flex: 1 }}>
            <Mono style={{ fontSize: 22, fontWeight: "500", color: c.sReview }}>
              {String(review.length).padStart(2, "0")}
            </Mono>
          </Tile>
          <Tile label="Total spend" style={{ flex: 2 }}>
            <Mono style={{ fontSize: 22, fontWeight: "500", color: c.sDone }}>{money(totalSpend)}</Mono>
          </Tile>
        </View>
      </View>

      {review.length ? (
        review.map((r) => (
          <ReviewCard
            key={r.taskId}
            item={r}
            onOpen={() => (r.runId ? router.push(`/run/${r.runId}`) : toast(r.taskId))}
            onApprove={() => approve(r.taskId, r.prNum)}
            onChanges={() => changes(r.taskId)}
          />
        ))
      ) : (
        <EmptyNote>No PRs waiting. The floor is clear.</EmptyNote>
      )}

      <View style={{ height: 8 }} />
      <Text style={{ paddingHorizontal: 24, paddingVertical: 10, color: c.muted2, fontSize: 11.5, textAlign: "center" }}>
        Swipe a card left to approve or request changes.
      </Text>
    </RefreshScroll>
  );
}
