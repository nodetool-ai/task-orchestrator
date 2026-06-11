import React from "react";
import { Text, View } from "react-native";

import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { Field, Mono, Press } from "../primitives";
import { useAuth } from "@/data/AuthProvider";
import { useTheme, type ThemeName } from "@/theme";

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c, name, setTheme } = useTheme();
  const { user, baseUrl, signOut } = useAuth();

  const themes: { value: ThemeName; label: string }[] = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];

  return (
    <BottomSheet open={open} onClose={onClose} title="Settings" subtitle={user?.email || undefined} maxHeightPct={0.7}>
      <View style={{ gap: 18 }}>
        <Field label="Server">
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              padding: 13,
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 11,
            }}
          >
            <Icon name="server" size={15} color={c.muted} />
            <Mono style={{ flex: 1, fontSize: 12.5, color: c.muted }} numberOfLines={1}>
              {baseUrl || "Not configured"}
            </Mono>
          </View>
        </Field>

        <Field label="Appearance">
          <View style={{ flexDirection: "row", gap: 8 }}>
            {themes.map((t) => {
              const active = t.value === name;
              return (
                <Press
                  key={t.value}
                  onPress={() => setTheme(t.value)}
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    paddingVertical: 13,
                    borderRadius: 11,
                    backgroundColor: active ? c.raised : c.surface,
                    borderWidth: 1,
                    borderColor: active ? c.hairlineStrong : c.hairline,
                  }}
                >
                  <Icon name="moon" size={14} color={active ? c.fg : c.muted} />
                  <Text style={{ fontSize: 14, fontWeight: "600", color: active ? c.fg : c.muted }}>{t.label}</Text>
                </Press>
              );
            })}
          </View>
        </Field>

        <Press
          onPress={() => {
            onClose();
            signOut();
          }}
          style={{
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderRadius: 12,
            backgroundColor: c.raised,
            marginTop: 4,
          }}
        >
          <Icon name="logout" size={15} color={c.sBlocked} />
          <Text style={{ color: c.sBlocked, fontSize: 14.5, fontWeight: "600" }}>Sign out</Text>
        </Press>
      </View>
    </BottomSheet>
  );
}
