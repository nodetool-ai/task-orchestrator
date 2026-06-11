import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandMark } from "@/components/shell";
import { Icon } from "@/components/Icon";
import { Field, Press } from "@/components/primitives";
import { useAuth } from "@/data/AuthProvider";
import { useTheme } from "@/theme";

export default function LoginScreen() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { baseUrl, setServer, signIn } = useAuth();

  const [server, setServerInput] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerInput(baseUrl);
  }, [baseUrl]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!server.trim()) return setError("Enter your orchestrator URL");
    if (!email.trim() || !password) return setError("Enter your email and password");
    setBusy(true);
    try {
      await setServer(server);
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const input = {
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 11,
    paddingHorizontal: 13,
    paddingVertical: 13,
    color: c.fg,
    fontSize: 15,
  } as const;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", marginBottom: 28 }}>
          <BrandMark />
          <Text style={{ marginTop: 14, fontSize: 24, fontWeight: "700", color: c.fg, letterSpacing: -0.5 }}>Pi Factory</Text>
          <Text style={{ marginTop: 4, fontSize: 13, color: c.muted }}>Sign in to your orchestrator</Text>
        </View>

        <View style={{ gap: 16 }}>
          <Field label="Server URL">
            <TextInput
              value={server}
              onChangeText={setServerInput}
              placeholder="https://tasks.example.com"
              placeholderTextColor={c.muted2}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={input}
            />
          </Field>
          <Field label="Email">
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={c.muted2}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={input}
            />
          </Field>
          <Field label="Password">
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={c.muted2}
              secureTextEntry
              style={input}
              onSubmitEditing={submit}
            />
          </Field>

          {error ? <Text style={{ color: c.sBlocked, fontSize: 13 }}>{error}</Text> : null}

          <Press
            onPress={submit}
            disabled={busy}
            style={{
              minHeight: 50,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 13,
              backgroundColor: c.fg,
              marginTop: 4,
            }}
          >
            <Icon name="spark" size={16} color={c.bg} />
            <Text style={{ color: c.bg, fontSize: 15, fontWeight: "600" }}>{busy ? "Signing in…" : "Sign in"}</Text>
          </Press>

          <Text style={{ color: c.muted2, fontSize: 11.5, textAlign: "center", lineHeight: 17, marginTop: 4 }}>
            Uses your orchestrator email + password. The CLI command{"\n"}
            <Text style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", color: c.muted }}>task user add</Text>
            {"  "}creates accounts.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
