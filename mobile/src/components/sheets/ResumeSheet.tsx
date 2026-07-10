import React, { useState } from "react";
import { Text, View } from "react-native";

import { BottomSheet } from "../BottomSheet";
import { EnginePicker } from "../EnginePicker";
import { Icon } from "../Icon";
import { StateIcon } from "../StateIcon";
import { Press } from "../primitives";
import { useTheme, toAlpha } from "@/theme";
import { api } from "@/lib/api";
import type { BackendId } from "@/lib/types";
import type { FloorRunVM } from "@/lib/model";

export function ResumeSheet({
  run,
  onClose,
  onToast,
  onRefresh,
}: {
  run: FloorRunVM | null;
  onClose: () => void;
  onToast: (m: string) => void;
  onRefresh: () => void;
}) {
  const { c } = useTheme();
  const [backend, setBackend] = useState<BackendId | null>(null);
  const [busy, setBusy] = useState(false);
  const budget = !!run?.reason?.toLowerCase().includes("budget");

  const resume = async () => {
    if (!run || busy) return;
    setBusy(true);
    try {
      await api.resumeSession(run.runId, { backend });
      onClose();
      onToast(`Resumed ${run.shortId}`);
      onRefresh();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={!!run} onClose={onClose} title="Resume stuck run" subtitle={run?.shortId} maxHeightPct={0.7}>
      {run ? (
        <View style={{ gap: 16 }}>
          <View
            style={{
              padding: 13,
              backgroundColor: toAlpha(c.sBlocked, 0.1),
              borderWidth: 1,
              borderColor: toAlpha(c.sBlocked, 0.35),
              borderRadius: 12,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 6 }}>
              <StateIcon state="blocked" size={13} />
              <Text style={{ fontSize: 12, fontWeight: "600", color: c.sBlocked }}>
                {budget ? "Budget exhausted" : "Criteria not met"}
              </Text>
            </View>
            <Text style={{ fontSize: 12.5, color: c.muted, lineHeight: 18 }}>{run.reason}</Text>
          </View>

          <EnginePicker value={backend} onChange={setBackend} active={!!run} />

          <Press
            onPress={resume}
            disabled={busy}
            style={{
              minHeight: 48,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              borderRadius: 12,
              backgroundColor: c.fg,
            }}
          >
            <Icon name="play" size={14} color={c.bg} />
            <Text style={{ color: c.bg, fontSize: 14.5, fontWeight: "600" }}>
              {busy ? "Resuming…" : "Resume run"}
            </Text>
          </Press>
        </View>
      ) : null}
    </BottomSheet>
  );
}
