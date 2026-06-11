import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { dark, light, type Palette } from "./colors";

export * from "./colors";

export type ThemeName = "dark" | "light";

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
}) as string;

type ThemeCtx = {
  name: ThemeName;
  c: Palette;
  setTheme: (n: ThemeName) => void;
  toggle: () => void;
};

const Ctx = createContext<ThemeCtx>({
  name: "dark",
  c: dark,
  setTheme: () => {},
  toggle: () => {},
});

const KEY = "pi.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState<ThemeName>("dark");

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === "light" || v === "dark") setName(v);
    });
  }, []);

  const setTheme = (n: ThemeName) => {
    setName(n);
    AsyncStorage.setItem(KEY, n).catch(() => {});
  };

  const value = useMemo<ThemeCtx>(
    () => ({
      name,
      c: name === "dark" ? dark : light,
      setTheme,
      toggle: () => setTheme(name === "dark" ? "light" : "dark"),
    }),
    [name]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}
