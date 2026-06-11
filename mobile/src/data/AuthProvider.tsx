import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  getSession,
  getBaseUrl,
  loadBaseUrl,
  login as apiLogin,
  loginWithToken as apiLoginToken,
  logout as apiLogout,
  setBaseUrl,
  type SessionUser,
} from "@/lib/api";

type Status = "loading" | "signedOut" | "signedIn";

interface AuthCtx {
  status: Status;
  user: SessionUser | null;
  baseUrl: string;
  setServer: (url: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithToken: (email: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
  recheck: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [baseUrl, setBase] = useState("");

  const recheck = useCallback(async () => {
    if (!getBaseUrl()) {
      setStatus("signedOut");
      setUser(null);
      return;
    }
    const u = await getSession();
    setUser(u);
    setStatus(u ? "signedIn" : "signedOut");
  }, []);

  useEffect(() => {
    (async () => {
      const b = await loadBaseUrl();
      setBase(b);
      await recheck();
    })();
  }, [recheck]);

  const setServer = useCallback(
    async (url: string) => {
      await setBaseUrl(url);
      setBase(getBaseUrl());
      await recheck();
    },
    [recheck]
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setUser(u);
    setStatus("signedIn");
  }, []);

  const signInWithToken = useCallback(async (email: string, token: string) => {
    const u = await apiLoginToken(email, token);
    setUser(u);
    setStatus("signedIn");
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus("signedOut");
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({ status, user, baseUrl, setServer, signIn, signInWithToken, signOut, recheck }),
    [status, user, baseUrl, setServer, signIn, signInWithToken, signOut, recheck]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
