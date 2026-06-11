import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { AgentSession, PlanFull, Persona, TaskFull } from "@/lib/types";
import { useAuth } from "./AuthProvider";

interface DataState {
  sessions: AgentSession[];
  tasks: TaskFull[];
  plans: PlanFull[];
  personas: Persona[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<DataState>(null as unknown as DataState);

const POLL_MS = 8000;

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [tasks, setTasks] = useState<TaskFull[]>([]);
  const [plans, setPlans] = useState<PlanFull[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);
  const { status } = useAuth();

  const load = useCallback(async (mode: "initial" | "refresh" | "poll") => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (mode === "refresh") setRefreshing(true);
    try {
      const [s, t, p, pr] = await Promise.all([
        api.sessions(),
        api.tasks(),
        api.plans(),
        api.personas().catch(() => [] as Persona[]),
      ]);
      setSessions(s);
      setTasks(t);
      setPlans(p);
      if (pr.length) setPersonas(pr);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (status !== "signedIn") {
      setLoading(false);
      setSessions([]);
      setTasks([]);
      setPlans([]);
      setError(null);
      setLastUpdated(null);
      return;
    }
    setLoading(true);
    load("initial");
    const id = setInterval(() => load("poll"), POLL_MS);
    return () => clearInterval(id);
  }, [load, status]);

  const refresh = useCallback(() => load("refresh"), [load]);

  const value = useMemo<DataState>(
    () => ({ sessions, tasks, plans, personas, loading, refreshing, error, lastUpdated, refresh }),
    [sessions, tasks, plans, personas, loading, refreshing, error, lastUpdated, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData() {
  return useContext(Ctx);
}
