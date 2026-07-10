import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRouter } from "expo-router";

import { SpawnSheet } from "@/components/sheets/SpawnSheet";
import { ResumeSheet } from "@/components/sheets/ResumeSheet";
import { SearchSheet } from "@/components/sheets/SearchSheet";
import { SettingsSheet } from "@/components/sheets/SettingsSheet";
import { useToast } from "@/components/Toast";
import { useData } from "./DataProvider";
import { buildFloor, buildPlanCards, type FloorRunVM, type QueueVM } from "@/lib/model";

interface SheetsCtx {
  openSpawn: (task?: QueueVM | null) => void;
  openResume: (run: FloorRunVM) => void;
  openSearch: () => void;
  openSettings: () => void;
  openTask: (id: string) => void;
}

const Ctx = createContext<SheetsCtx>({
  openSpawn: () => {},
  openResume: () => {},
  openSearch: () => {},
  openSettings: () => {},
  openTask: () => {},
});

export function SheetsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { sessions, tasks, plans, personas, refresh } = useData();

  const [spawn, setSpawn] = useState<{ open: boolean; task: QueueVM | null }>({ open: false, task: null });
  const [resume, setResume] = useState<FloorRunVM | null>(null);
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);

  const floor = useMemo(() => buildFloor(sessions, tasks, plans), [sessions, tasks, plans]);
  const planCards = useMemo(() => buildPlanCards(plans, tasks), [plans, tasks]);

  const value = useMemo<SheetsCtx>(
    () => ({
      openSpawn: (task = null) => setSpawn({ open: true, task }),
      openResume: (run) => setResume(run),
      openSearch: () => setSearch(true),
      openSettings: () => setSettings(true),
      openTask: (id) => router.push(`/task/${id}`),
    }),
    [router]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <SpawnSheet
        open={spawn.open}
        task={spawn.task}
        queue={floor.queue}
        personas={personas}
        onClose={() => setSpawn({ open: false, task: null })}
        onToast={toast}
        onRefresh={refresh}
      />
      <ResumeSheet run={resume} onClose={() => setResume(null)} onToast={toast} onRefresh={refresh} />
      <SearchSheet
        open={search}
        onClose={() => setSearch(false)}
        floor={floor}
        plans={planCards}
        onOpenRun={(id) => router.push(`/run/${id}`)}
        onOpenPlan={(id) => router.push(`/plan/${id}`)}
        onOpenTask={(id) => router.push(`/task/${id}`)}
      />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </Ctx.Provider>
  );
}

export function useSheets() {
  return useContext(Ctx);
}
