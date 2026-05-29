import React, { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ThemeProvider, useTheme } from "@/theme";
import { AuthProvider, useAuth } from "@/data/AuthProvider";
import { DataProvider } from "@/data/DataProvider";
import { SheetsProvider } from "@/data/SheetsProvider";
import { ToastProvider } from "@/components/Toast";
import { Loading } from "@/components/Loading";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <DataProvider>
              <ToastProvider>
                <Root />
              </ToastProvider>
            </DataProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  const { c, name } = useTheme();
  const { status } = useAuth();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <SheetsProvider>
        <AuthGate />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: c.bg },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="login" options={{ animation: "fade" }} />
          <Stack.Screen name="run/[id]" />
          <Stack.Screen name="plan/[id]" />
        </Stack>
      </SheetsProvider>
      {status === "loading" ? (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
          <Loading />
        </View>
      ) : null}
    </View>
  );
}

// Redirects between the login screen and the app based on auth status.
function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    const onLogin = segments[0] === "login";
    if (status === "signedOut" && !onLogin) router.replace("/login");
    else if (status === "signedIn" && onLogin) router.replace("/");
  }, [status, segments, router]);

  return null;
}
