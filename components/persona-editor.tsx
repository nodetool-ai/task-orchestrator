"use client";

import { useState } from "react";
import { Loader2, Check, Save } from "lucide-react";
import { ProviderModelPicker } from "@/components/pickers/provider-model-picker";
import { ToolsPicker } from "@/components/pickers/tools-picker";
import {
  ThinkingLevelPicker,
  type ThinkingLevel,
} from "@/components/pickers/thinking-level-picker";

export interface PersonaDto {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: string | null;
  toolsProfile: string;
  budgetMaxTurns: number | null;
  budgetMaxSeconds: number | null;
}

interface Props {
  persona: PersonaDto;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function PersonaEditor({ persona }: Props) {
  const [draft, setDraft] = useState<PersonaDto>(persona);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function update<K extends keyof PersonaDto>(key: K, value: PersonaDto[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaveState("idle");
  }

  async function save() {
    setSaveState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/personas/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description ?? "",
          systemPrompt: draft.systemPrompt,
          modelProvider: draft.modelProvider,
          modelId: draft.modelId,
          thinkingLevel: draft.thinkingLevel || null,
          toolsProfile: draft.toolsProfile,
          budgetMaxTurns: draft.budgetMaxTurns ?? null,
          budgetMaxSeconds: draft.budgetMaxSeconds ?? null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
        setSaveState("error");
        return;
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSaveState("error");
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-card/40 p-5 space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-medium">{draft.name}</h2>
        <code className="text-xs text-muted-foreground">{draft.id}</code>
      </div>

      <Field label="Name">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="Description">
        <input
          type="text"
          value={draft.description ?? ""}
          onChange={(e) => update("description", e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="System prompt">
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={8}
          className={`${inputClass} font-mono text-xs leading-5 resize-y`}
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <ProviderModelPicker
            provider={draft.modelProvider}
            model={draft.modelId}
            onChange={({ provider, model }) => {
              setDraft((d) => ({
                ...d,
                modelProvider: provider,
                modelId: model,
              }));
              setSaveState("idle");
            }}
          />
        </div>
        <Field label="Thinking">
          <ThinkingLevelPicker
            value={draft.thinkingLevel as ThinkingLevel | null}
            onChange={(v) => update("thinkingLevel", v)}
          />
        </Field>
      </div>

      <Field label="Tools">
        <ToolsPicker
          value={draft.toolsProfile}
          onChange={(next) => update("toolsProfile", next)}
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Budget — max turns">
          <input
            type="number"
            min={1}
            value={draft.budgetMaxTurns ?? ""}
            onChange={(e) =>
              update(
                "budgetMaxTurns",
                e.target.value ? Number(e.target.value) : null
              )
            }
            className={inputClass}
            placeholder="—"
          />
        </Field>
        <Field label="Budget — max seconds">
          <input
            type="number"
            min={1}
            value={draft.budgetMaxSeconds ?? ""}
            onChange={(e) =>
              update(
                "budgetMaxSeconds",
                e.target.value ? Number(e.target.value) : null
              )
            }
            className={inputClass}
            placeholder="—"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={save}
          disabled={saveState === "saving"}
          className="inline-flex items-center gap-2 rounded-md bg-foreground text-background px-3 py-1.5 text-sm font-medium hover:bg-foreground/90 disabled:opacity-50"
        >
          {saveState === "saving" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : saveState === "saved" ? (
            <Check className="size-3.5" />
          ) : (
            <Save className="size-3.5" />
          )}
          {saveState === "saved" ? "Saved" : "Save"}
        </button>
        {errorMsg && (
          <span className="text-xs text-state-blocked">{errorMsg}</span>
        )}
      </div>
    </li>
  );
}

const inputClass =
  "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
