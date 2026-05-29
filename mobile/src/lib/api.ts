import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  AgentSession,
  PlanDetail,
  PlanFull,
  Persona,
  RunDetail,
  TaskFull,
} from "./types";

// ---------------------------------------------------------------------------
// Config — the orchestrator base URL is operator-supplied (e.g.
// https://tasks.nodetool.ai or http://192.168.x.x:3000) and persisted.
// ---------------------------------------------------------------------------

const BASE_KEY = "pi.baseUrl";
let baseUrl = "";

export async function loadBaseUrl(): Promise<string> {
  baseUrl = (await AsyncStorage.getItem(BASE_KEY)) || "";
  return baseUrl;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export async function setBaseUrl(url: string): Promise<void> {
  baseUrl = normalizeBase(url);
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

  // mutations -------------------------------------------------------------
  cancelRun: (id: number) =>
    request<unknown>(`/api/runs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    }),
  resumeSession: (id: number) =>
    request<unknown>(`/api/sessions/${id}/resume`, { method: "POST" }),
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
        initialPrompt: input.initialPrompt,
        title: input.title ?? undefined,
        goal: "<implement>",
        budget: input.budgetUsd ? { maxUsd: input.budgetUsd } : undefined,
      }),
    }),
};
