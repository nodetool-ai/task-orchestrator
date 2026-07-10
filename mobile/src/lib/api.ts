import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  AgentSession,
  BackendId,
  PlanDetail,
  PlanFull,
  Persona,
  ProvidersResponse,
  RunDetail,
  TaskFull,
} from "./types";

// ---------------------------------------------------------------------------
// Config — the orchestrator base URL is operator-supplied (e.g.
// https://tasks.nodetool.ai or http://192.168.x.x:3000) and persisted.
// ---------------------------------------------------------------------------

const BASE_KEY = "pi.baseUrl";
let baseUrl = "";

// The provider/backend catalog is stable for a given server, so cache it once
// per session — the spawn and resume sheets both read it.
let providersCache: ProvidersResponse | null = null;

export async function loadBaseUrl(): Promise<string> {
  baseUrl = (await AsyncStorage.getItem(BASE_KEY)) || "";
  return baseUrl;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export async function setBaseUrl(url: string): Promise<void> {
  baseUrl = normalizeBase(url);
  providersCache = null; // catalog is per-server
  await AsyncStorage.setItem(BASE_KEY, baseUrl);
}

function normalizeBase(url: string): string {
  let u = url.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// React Native's native networking keeps its own cookie jar and resends
// cookies automatically for the same host, so the next-auth session cookie
// established at login is attached to every later request transparently.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new ApiError("No server configured", 0);
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : typeof data === "string" && data
          ? data
          : `Request failed (${res.status})`) || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Auth (next-auth v5, Credentials provider, JWT session cookie)
// ---------------------------------------------------------------------------

export interface SessionUser {
  id?: string;
  email?: string;
  name?: string;
}

export async function getSession(): Promise<SessionUser | null> {
  try {
    const data = await request<{ user?: SessionUser }>("/api/auth/session");
    return data?.user?.email ? data.user : null;
  } catch {
    return null;
  }
}

async function csrfToken(): Promise<string> {
  const data = await request<{ csrfToken: string }>("/api/auth/csrf");
  return data.csrfToken;
}

function form(body: Record<string, string>): string {
  return Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Sign in with email + password. Returns the signed-in user or throws. */
export async function login(email: string, password: string): Promise<SessionUser> {
  return credentialsSignIn({ email, password });
}

/** Sign in with a magic-link token (from /api/auth/magic-link). */
export async function loginWithToken(email: string, token: string): Promise<SessionUser> {
  return credentialsSignIn({ email, token });
}

async function credentialsSignIn(creds: Record<string, string>): Promise<SessionUser> {
  const csrf = await csrfToken();
  // json=true makes next-auth return JSON instead of a 302 redirect.
  await request<{ url?: string }>("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      ...creds,
      csrfToken: csrf,
      callbackUrl: baseUrl,
      json: "true",
    }),
  }).catch(() => ({}));
  // The callback returns the login page URL (not an error) on bad creds, so we
  // confirm by reading the freshly minted session.
  const user = await getSession();
  if (!user) throw new ApiError("Invalid email or password", 401);
  return user;
}

export async function requestMagicLink(email: string): Promise<{ url?: string }> {
  return request<{ url?: string }>("/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function logout(): Promise<void> {
  try {
    const csrf = await csrfToken();
    await request("/api/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrfToken: csrf, callbackUrl: baseUrl, json: "true" }),
    });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Resources (all existing REST endpoints)
// ---------------------------------------------------------------------------

export const api = {
  sessions: () => request<AgentSession[]>("/api/sessions"),
  activeSessions: () => request<AgentSession[]>("/api/sessions?active=true"),
  tasks: (q?: { state?: string; plan?: string }) => {
    const sp = new URLSearchParams();
    if (q?.state) sp.set("state", q.state);
    if (q?.plan) sp.set("plan", q.plan);
    const qs = sp.toString();
    return request<TaskFull[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },
  task: (id: string) => request<TaskFull>(`/api/tasks/${id}`),
  plans: () => request<PlanFull[]>("/api/plans"),
  plan: (id: string) => request<PlanDetail>(`/api/plans/${id}`),
  personas: () => request<{ personas: Persona[] }>("/api/personas").then((d) => d.personas),
  run: (id: number) => request<RunDetail>(`/api/runs/${id}`),
  providers: async (): Promise<ProvidersResponse> => {
    if (providersCache) return providersCache;
    const data = await request<ProvidersResponse>("/api/providers");
    providersCache = data;
    return data;
  },

  // mutations -------------------------------------------------------------
  cancelRun: (id: number) =>
    request<unknown>(`/api/runs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    }),
  closeRun: (id: number) =>
    request<unknown>(`/api/runs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    }),
  resumeSession: (id: number, opts?: { backend?: BackendId | null; model?: string | null }) => {
    const body: Record<string, unknown> = {};
    if (opts?.backend) body.backend = opts.backend;
    if (opts?.model) body.model = opts.model;
    const hasBody = Object.keys(body).length > 0;
    return request<unknown>(`/api/sessions/${id}/resume`, {
      method: "POST",
      ...(hasBody
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  },
  // Toggle (or edit) a task's acceptance criterion. Returns the updated task.
  updateCriterion: (taskId: string, cid: number, patch: { done?: boolean; text?: string }) =>
    request<TaskFull>(`/api/tasks/${taskId}/criteria/${cid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  addCriterion: (taskId: string, text: string) =>
    request<TaskFull>(`/api/tasks/${taskId}/criteria`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  addNote: (taskId: string, body: string, author: string) =>
    request<TaskFull>(`/api/tasks/${taskId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, author }),
    }),
  patchTask: (taskId: string, patch: { repoId?: string | null }) =>
    request<TaskFull>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  // Open-or-create the task's single canonical agent run. `seed:true` kicks off
  // the implement turn; `seed:false` defers (the first chat message is turn 1).
  // The chosen persona/model/backend/thinking are honored only on creation.
  attachedRun: (
    taskId: string,
    body: {
      seed?: boolean;
      personaId?: string;
      model?: string | null;
      backend?: BackendId | null;
      thinkingLevel?: string | null;
    }
  ) =>
    request<{ runId: number; created: boolean }>(`/api/tasks/${taskId}/attached-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  // Advance a planning run past a review gate (spec_review → building_plan,
  // plan_review → committing). The server injects the "approved" turn.
  planningAction: (id: number, action: "approve_spec" | "approve_plan") =>
    request<unknown>(`/api/runs/${id}/planning`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  // Send a message / instructions to a run and let it take a turn. The endpoint
  // streams the reply back as SSE and only closes when the turn finishes; we
  // await the POST (surfacing an immediate error) but drain the stream in the
  // background so the connection stays open — dropping it aborts the turn. The
  // reply itself surfaces through the run-detail poll, not this call.
  sendRunMessage: async (id: number, text: string): Promise<void> => {
    if (!baseUrl) throw new ApiError("No server configured", 0);
    const res = await fetch(`${baseUrl}/api/runs/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new ApiError(t || `Request failed (${res.status})`, res.status);
    }
    void res.text().catch(() => {});
  },
  transitionTask: (id: string, state: string, extra?: { assignee?: string; note?: string }) =>
    request<unknown>(`/api/tasks/${id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, ...extra }),
    }),
  spawnRun: (input: {
    taskId: string;
    planId?: string | null;
    personaId?: string;
    model?: string | null;
    backend?: BackendId | null;
    thinkingLevel?: string | null;
    initialPrompt?: string;
    title?: string | null;
    budgetUsd?: number;
  }) =>
    request<{ id: number }>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: input.taskId,
        planId: input.planId ?? undefined,
        personaId: input.personaId,
        model: input.model ?? undefined,
        backend: input.backend ?? undefined,
        thinkingLevel: input.thinkingLevel ?? undefined,
        initialPrompt: input.initialPrompt,
        title: input.title ?? undefined,
        goal: "<implement>",
        budget: input.budgetUsd ? { maxUsd: input.budgetUsd } : undefined,
      }),
    }),
};
