import React from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import { useData } from "@/data/DataProvider";
import { useTheme } from "@/theme";

// Themed scroll surface with pull-to-refresh + bottom inset for the tab bar.
export function RefreshScroll({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  const { c } = useTheme();
  const { refreshing, refresh } = useData();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {header}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 14, paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.muted} colors={[c.sProgress]} />
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}
