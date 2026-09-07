"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RepositoryPicker, type RepositoryOption } from "@/components/pickers/repository-picker";
import { PersonaPicker, type PersonaOption } from "@/components/pickers/persona-picker";
import { ProviderModelPicker } from "@/components/pickers/provider-model-picker";
import { ToolsPicker } from "@/components/pickers/tools-picker";
import { parseProviderQualifiedModel } from "@/lib/model-id";
import { StateIcon } from "@/components/pi/primitives";
import { instantToWallClock, isValidTimeZone, schedulePreview, wallClockToInstant } from "@/lib/schedule-time";

type Kind = "once" | "interval" | "cron";
type Schedule = {
  id: number; name: string; prompt: string; repoId: string; kind: Kind; runAt: string | null;
  startAt?: string | null; intervalSeconds: number | null; cronExpression: string | null;
  timezone: string; enabled: boolean; nextRunAt: string | null; lastScheduledAt: string | null;
  baseBranch: string | null; personaId: string | null; model: string | null; toolsProfile: string | null;
  autoMerge: boolean; budgetMaxTurns: number | null; budgetMaxUsd: number | null; budgetMaxSeconds: number | null;
  repository?: { name: string } | null; recentOccurrence?: { status: string; scheduledFor: string } | null;
  recentRun?: { status: string; prUrl: string | null } | null; prUrl: string | null;
};

type Form = {
  name: string; prompt: string; repoId: string; kind: Kind; runAt: string; startAt: string;
  intervalSeconds: string; cronExpression: string; timezone: string; baseBranch: string;
  personaId: string; model: string; toolsProfile: string; autoMerge: boolean; maxTurns: string; maxUsd: string; maxSeconds: string;
};
const emptyForm: Form = { name: "", prompt: "", repoId: "", kind: "once", runAt: "", startAt: "", intervalSeconds: "3600", cronExpression: "0 9 * * 1-5", timezone: "UTC", baseBranch: "", personaId: "", model: "", toolsProfile: "", autoMerge: false, maxTurns: "", maxUsd: "", maxSeconds: "" };
const fmt = (value: string | null | undefined) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "-";
const trigger = (s: Schedule) => s.kind === "once" ? `Once, ${fmt(s.runAt)}` : s.kind === "interval" ? `Every ${s.intervalSeconds}s` : s.cronExpression ?? "Cron";
const formatPreviewInstant = (value: Date, timezone: string) => value.toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: timezone });
function preview(form: Form): string {
  const result = schedulePreview({
    kind: form.kind,
    timezone: form.timezone || "UTC",
    now: new Date(),
    runAt: form.kind === "once" ? form.runAt || null : null,
    startAt: form.kind === "interval" ? form.startAt || null : null,
    intervalSeconds: Number(form.intervalSeconds),
    cronExpression: form.kind === "cron" ? form.cronExpression : null,
  });
  if (result.error) return result.error;
  if (!result.nextAt) return "Choose a valid schedule";
  const when = formatPreviewInstant(result.nextAt, form.timezone || "UTC");
  return result.immediate ? `Immediately (${when})` : when;
}

export default function SchedulesPage() {
  const [rows, setRows] = React.useState<Schedule[]>([]);
  const [repositories, setRepositories] = React.useState<RepositoryOption[]>([]);
  const [personas, setPersonas] = React.useState<PersonaOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [editing, setEditing] = React.useState<number | "new" | null>(null);
  const [form, setForm] = React.useState<Form>(emptyForm);
  const [details, setDetails] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirming, setConfirming] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [scheduleResponse, repoResponse, personaResponse] = await Promise.all([fetch("/api/schedules"), fetch("/api/repositories"), fetch("/api/personas")]);
      if (!scheduleResponse.ok) throw new Error((await scheduleResponse.json()).error ?? "Could not load schedules");
      const schedules = await scheduleResponse.json() as Schedule[];
      const repos = repoResponse.ok ? await repoResponse.json() : [];
      const personaPayload = personaResponse.ok ? await personaResponse.json() : [];
      const people = Array.isArray(personaPayload) ? personaPayload : (personaPayload.personas ?? []);
      setRows(schedules); setRepositories(Array.isArray(repos) ? repos : []); setPersonas(people);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load schedules"); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const beginCreate = () => { setForm({ ...emptyForm, repoId: repositories[0]?.id ?? "" }); setEditing("new"); setDetails(false); setError(""); };
  const beginEdit = (row: Schedule) => {
    const wall = (value: string | null, timezone: string) => {
      if (!value) return "";
      try { return instantToWallClock(value, timezone); } catch { return ""; }
    };
    setEditing(row.id); setForm({ name: row.name, prompt: row.prompt, repoId: row.repoId, kind: row.kind, runAt: wall(row.runAt, row.timezone), startAt: wall(row.nextRunAt, row.timezone), intervalSeconds: row.intervalSeconds?.toString() ?? "3600", cronExpression: row.cronExpression ?? emptyForm.cronExpression, timezone: row.timezone, baseBranch: row.baseBranch ?? "", personaId: row.personaId ?? "", model: row.model ?? "", toolsProfile: row.toolsProfile ?? "", autoMerge: row.autoMerge, maxTurns: row.budgetMaxTurns?.toString() ?? "", maxUsd: row.budgetMaxUsd?.toString() ?? "", maxSeconds: row.budgetMaxSeconds?.toString() ?? "" });
  };
  const set = (key: keyof Form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!form.name.trim() || !form.prompt.trim() || !form.repoId) { setError("Name, prompt, and repository are required."); return; }
    const timezone = form.timezone.trim() || "UTC";
    if (!isValidTimeZone(timezone)) { setError(`Invalid IANA timezone: ${timezone}`); return; }
    const body: Record<string, unknown> = { name: form.name.trim(), prompt: form.prompt, repoId: form.repoId, kind: form.kind, timezone, baseBranch: form.baseBranch || null, personaId: form.personaId || null, model: form.model || null, toolsProfile: form.toolsProfile || null, autoMerge: form.autoMerge };
    try {
      if (form.kind === "once") body.runAt = form.runAt ? wallClockToInstant(form.runAt, timezone).toISOString() : "";
      if (form.kind === "interval") { body.intervalSeconds = Number(form.intervalSeconds); if (form.startAt) body.startAt = wallClockToInstant(form.startAt, timezone).toISOString(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid local schedule time"); return; }
    if (form.kind === "cron") body.cronExpression = form.cronExpression;
    // PATCH needs explicit nulls to clear an existing schedule override.
    body.budgetMaxTurns = form.maxTurns ? Number(form.maxTurns) : null;
    body.budgetMaxUsd = form.maxUsd ? Number(form.maxUsd) : null;
    body.budgetMaxSeconds = form.maxSeconds ? Number(form.maxSeconds) : null;
    setSaving(true);
    try { const response = await fetch(editing === "new" ? "/api/schedules" : `/api/schedules/${editing}`, { method: editing === "new" ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Could not save schedule"); setEditing(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save schedule"); } finally { setSaving(false); }
  }
  async function action(id: number, method: string, path = "") { setError(""); try { const response = await fetch(`/api/schedules/${id}${path}`, { method, headers: { "content-type": "application/json" } }); const payload = response.status === 204 ? null : await response.json(); if (!response.ok) throw new Error(payload?.error ?? "Request failed"); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } }
  async function runNow(id: number) { await action(id, "POST", "/run"); }
  const timezoneError = form.timezone.trim() && !isValidTimeZone(form.timezone.trim()) ? `Invalid IANA timezone: ${form.timezone.trim()}` : "";
  const previewResult = schedulePreview({ kind: form.kind, timezone: form.timezone || "UTC", now: new Date(), runAt: form.runAt || null, startAt: form.startAt || null, intervalSeconds: Number(form.intervalSeconds), cronExpression: form.cronExpression });
  const localTimeError = !timezoneError && (form.kind === "once" ? Boolean(form.runAt) : Boolean(form.startAt)) && previewResult.error ? previewResult.error : "";
  const cronError = !timezoneError && form.kind === "cron" && form.cronExpression.trim() && previewResult.error ? previewResult.error : "";
  const modelSelection = form.model ? parseProviderQualifiedModel(form.model) : { provider: "", id: "" };

  return <section style={{ maxWidth: 1280, margin: "0 auto", padding: "32px 24px 64px" }}>
    <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
      <div><div className="pi-kicker">AUTOMATION</div><h1 style={{ fontSize: 20, margin: "4px 0 0", letterSpacing: "-0.02em" }}>Schedules</h1></div>
      <Button onClick={beginCreate} aria-label="Create schedule">Create schedule</Button>
    </header>
    {error && <p role="alert" style={{ color: "var(--s-blocked)", fontSize: 12, margin: "0 0 16px" }}>{error}</p>}
    {editing !== null && <form onSubmit={save} style={{ border: "1px solid var(--pi-hairline)", background: "var(--pi-surface)", padding: 20, borderRadius: 8, marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><h2 style={{ fontSize: 14, margin: 0 }}>{editing === "new" ? "New schedule" : "Edit schedule"}</h2><Button variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel schedule editor">Cancel</Button></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
        <Field label="Name"><Input value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus required /></Field>
        <Field label="Repository"><RepositoryPicker repositories={repositories} value={form.repoId} onChange={(v) => set("repoId", v)} emptyLabel="Select repository" /></Field>
        <Field label="Trigger"><Select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}><option value="once">Once</option><option value="interval">Interval</option><option value="cron">Cron</option></Select></Field>
        <Field label="Timezone"><Input value={form.timezone} onChange={(e) => set("timezone", e.target.value)} placeholder="UTC or America/New_York" aria-invalid={Boolean(timezoneError)} aria-describedby={timezoneError ? "schedule-timezone-error" : undefined} />{timezoneError && <span id="schedule-timezone-error" role="alert" className="pi-help" style={{ color: "var(--s-blocked)" }}>{timezoneError}</span>}</Field>
      </div>
      <Field label="Prompt"><Textarea value={form.prompt} onChange={(e) => set("prompt", e.target.value)} required rows={4} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
        {form.kind === "once" && <Field label="Run at"><Input type="datetime-local" value={form.runAt} onChange={(e) => set("runAt", e.target.value)} required aria-invalid={Boolean(localTimeError)} aria-describedby={localTimeError ? "schedule-time-error" : undefined} />{localTimeError && <span id="schedule-time-error" role="alert" className="pi-help" style={{ color: "var(--s-blocked)" }}>{localTimeError}</span>}</Field>}
        {form.kind === "interval" && <><Field label="Interval (seconds)"><Input type="number" min={1} value={form.intervalSeconds} onChange={(e) => set("intervalSeconds", e.target.value)} required /></Field><Field label="Start at (optional)"><Input type="datetime-local" value={form.startAt} onChange={(e) => set("startAt", e.target.value)} aria-invalid={Boolean(localTimeError)} aria-describedby={localTimeError ? "schedule-time-error" : undefined} />{localTimeError && <span id="schedule-time-error" role="alert" className="pi-help" style={{ color: "var(--s-blocked)" }}>{localTimeError}</span>}</Field></>}
        {form.kind === "cron" && <Field label="Cron, five fields"><Input className="font-mono" value={form.cronExpression} onChange={(e) => set("cronExpression", e.target.value)} required aria-invalid={Boolean(cronError)} aria-describedby={cronError ? "schedule-cron-error" : undefined} />{cronError ? <span id="schedule-cron-error" role="alert" className="pi-help" style={{ color: "var(--s-blocked)" }}>{cronError}</span> : <span className="pi-help">Next occurrence uses {form.timezone || "UTC"}.</span>}</Field>}
        <div aria-live="polite" style={{ alignSelf: "end", padding: "8px 0", fontSize: 12, color: "var(--pi-muted)" }}>Next-run preview: <span className="pi-mono">{preview(form)}</span></div>
        <Field label="Base branch"><Input className="font-mono" value={form.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} placeholder="Repository default" /></Field>
      </div>
      <details open={details} onToggle={(e) => setDetails(e.currentTarget.open)} style={{ marginTop: 16 }}><summary style={{ cursor: "pointer", fontSize: 12, color: "var(--pi-muted)" }}>Run configuration</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginTop: 12 }}>
          <Field label="Persona"><PersonaPicker personas={personas} value={form.personaId} onChange={(v) => set("personaId", v)} emptyLabel="Inherit implementor" /></Field><ProviderModelPicker provider={modelSelection.provider} model={modelSelection.id} allowEmpty emptyLabel="Inherit deployment default" layout="column" onChange={({ provider, model }) => set("model", provider && model ? `${provider}/${model}` : "")} /><Field label="Tools profile"><ToolsPicker value={form.toolsProfile} onChange={(v) => set("toolsProfile", v)} /></Field>
          <Field label="Max turns"><Input type="number" min={1} value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} placeholder="Inherited" /></Field><Field label="Max USD"><Input type="number" min={0.01} step="0.01" value={form.maxUsd} onChange={(e) => set("maxUsd", e.target.value)} placeholder="Inherited" /></Field><Field label="Max seconds"><Input type="number" min={1} value={form.maxSeconds} onChange={(e) => set("maxSeconds", e.target.value)} placeholder="Inherited" /></Field>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, paddingTop: 25 }}><input type="checkbox" checked={form.autoMerge} onChange={(e) => set("autoMerge", e.target.checked)} /> Auto-merge after required checks</label>
        </div>
      </details>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save schedule"}</Button></div>
    </form>}
    {loading ? <p className="pi-help">Loading schedules...</p> : rows.length === 0 ? <p className="pi-help" style={{ borderTop: "1px solid var(--pi-hairline)", paddingTop: 20 }}>No schedules. Create one to run an agent on a cadence.</p> : <div style={{ overflowX: "auto", borderTop: "1px solid var(--pi-hairline)" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 880, fontSize: 12 }}><thead><tr>{["Status", "Name", "Cadence", "Repository", "Next occurrence", "Last run", "PR", "Actions"].map((h) => <th key={h} scope="col" style={{ textAlign: "left", padding: "10px 8px", color: "var(--pi-muted)", fontWeight: 500 }}>{h}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id} style={{ borderTop: "1px solid var(--pi-hairline)" }}><td style={{ padding: "12px 8px", whiteSpace: "nowrap" }}><StateIcon state={row.enabled ? "in_progress" : "cancelled"} size={13} /> <span style={{ marginLeft: 5 }}>{row.enabled ? "Enabled" : "Paused"}</span></td><th scope="row" style={{ textAlign: "left", padding: "12px 8px", fontWeight: 600 }}>{row.name}<div className="pi-help">#{row.id}</div></th><td style={{ padding: "12px 8px" }}>{trigger(row)}</td><td style={{ padding: "12px 8px" }}>{row.repository?.name ?? row.repoId}</td><td className="pi-mono" style={{ padding: "12px 8px" }}>{fmt(row.nextRunAt)}</td><td style={{ padding: "12px 8px" }}>{row.recentRun ? <><StateIcon state={row.recentRun.status} size={12} /> {row.recentRun.status}</> : row.recentOccurrence?.status ?? "Never"}</td><td style={{ padding: "12px 8px" }}>{row.prUrl ? <a href={row.prUrl} target="_blank" rel="noreferrer">Open PR</a> : "-"}</td><td style={{ padding: "8px", whiteSpace: "nowrap" }}><Button size="xs" variant="outline" onClick={() => void runNow(row.id)} aria-label={`Run ${row.name} now`}>Run now</Button> <Button size="xs" variant="ghost" onClick={() => void action(row.id, "POST", row.enabled ? "/pause" : "/resume")} aria-label={`${row.enabled ? "Pause" : "Resume"} ${row.name}`}>{row.enabled ? "Pause" : "Resume"}</Button> <Button size="xs" variant="ghost" onClick={() => beginEdit(row)} aria-label={`Edit ${row.name}`}>Edit</Button> {confirming === row.id ? <><Button size="xs" variant="danger" onClick={() => { setConfirming(null); void action(row.id, "DELETE"); }} aria-label={`Confirm delete ${row.name}`}>Confirm delete</Button><Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button></> : <Button size="xs" variant="ghost" onClick={() => setConfirming(row.id)} aria-label={`Delete ${row.name}`}>Delete</Button>}</td></tr>)}</tbody></table></div>}
  </section>;
}
