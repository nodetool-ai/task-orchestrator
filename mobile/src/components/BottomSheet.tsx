import React, { useEffect, useRef } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import { Press } from "./primitives";
import { useTheme } from "@/theme";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  maxHeightPct?: number;
}

export function BottomSheet({ open, onClose, title, subtitle, children, maxHeightPct = 0.9 }: Props) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const slide = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(slide, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(slide, { toValue: 0, duration: 240, useNativeDriver: true }).start(() => setMounted(false));
    }
  }, [open, mounted, slide]);

  if (!mounted) return null;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [700, 0] });
  const backdrop = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] });

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#05050a", opacity: backdrop }}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Animated.View
            style={{
              transform: [{ translateY }],
              maxHeight: Math.round(winH * maxHeightPct),
              backgroundColor: c.surface,
              borderTopLeftRadius: 22,
              borderTopRightRadius: 22,
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: c.hairline,
            }}
          >
            <View style={{ paddingTop: 10, paddingBottom: 4, alignItems: "center" }}>
              <View style={{ width: 38, height: 5, borderRadius: 99, backgroundColor: c.hairlineStrong }} />
            </View>
            {title ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 18,
                  paddingTop: 6,
                  paddingBottom: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: c.hairline,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, fontWeight: "600", color: c.fg }}>{title}</Text>
                  {subtitle ? <Text style={{ fontSize: 12, color: c.muted2, marginTop: 2 }}>{subtitle}</Text> : null}
                </View>
                <Press
                  onPress={onClose}
                  style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }}
                >
                  <Icon name="x" size={15} color={c.muted} />
                </Press>
              </View>
            ) : null}
            <ScrollView
              style={{ flexShrink: 1 }}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }}
            >
              {children}
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
