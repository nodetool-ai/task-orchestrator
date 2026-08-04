"use client";

import { useState } from "react";
import { Check, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToolsPicker } from "@/components/pickers/tools-picker";
import { PersonaLaurels } from "@/components/persona-laurels";
import { ErrorText } from "@/components/ui/error-text";
import {
  ThinkingLevelPicker,
  type ThinkingLevel,
} from "@/components/pickers/thinking-level-picker";
import { ProviderModelPicker, useProviderCatalog, firstModelForBackend } from "@/components/pickers/provider-model-picker";

export interface PersonaDto {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: string | null;
  toolsProfile: string;
  backend: string | null;
  budgetMaxTurns: number | null;
  budgetMaxSeconds: number | null;
}

interface Props {
  persona: PersonaDto;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function PersonaEditor({ persona }: Props) {
  const catalog = useProviderCatalog();
  const [draft, setDraft] = useState<PersonaDto>(persona);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [resetState, setResetState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function update<K extends keyof PersonaDto>(key: K, value: PersonaDto[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaveState("idle");
    setResetState("idle");
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
          backend: draft.backend || null,
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

  async function resetToDefault() {
    setResetState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/personas/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        persona?: PersonaDto;
        error?: string;
      };
      if (!res.ok || !body.persona) {
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
        setResetState("error");
        return;
      }
      setDraft(body.persona);
      setSaveState("idle");
      setResetState("saved");
      setTimeout(() => setResetState("idle"), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setResetState("error");
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-card/40 p-5 space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-medium">{draft.name}</h2>
        <code className="text-xs text-muted-foreground">{draft.id}</code>
      </div>

      <Field label="Name">
        <Input
          type="text"
          uiSize="sm"
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          className={fieldClass}
        />
      </Field>

      <Field label="Description">
        <Input
          type="text"
          uiSize="sm"
          value={draft.description ?? ""}
          onChange={(e) => update("description", e.target.value)}
          className={fieldClass}
        />
      </Field>

      <Field label="System prompt">
        <Textarea
          uiSize="sm"
          mono
          value={draft.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={8}
          className={`${fieldClass} text-xs leading-5 resize-y`}
        />
      </Field>

      <Field label="Engine">
        <EnginePicker
          value={draft.backend}
          onChange={(next) => {
            update("backend", next);
            if (!next) return; // "Deployment default" — leave provider/model as-is.
            // Snap provider/model to the new engine's first offering when the
            // current pair isn't available there — e.g. switching to the
            // claude backend, which only offers Anthropic models.
            const snap = firstModelForBackend(catalog, next);
            if (snap && (snap.provider !== draft.modelProvider || snap.model !== draft.modelId)) {
              const providers = catalog?.byBackend.get(next) ?? [];
              const stillOffered = providers
                .find((p) => p.id === draft.modelProvider)
                ?.models.some((m) => m.id === draft.modelId);
              if (!stillOffered) {
                update("modelProvider", snap.provider);
                update("modelId", snap.model);
              }
            }
          }}
        />
      </Field>

      <ProviderModelPicker
        provider={draft.modelProvider}
        model={draft.modelId}
        backend={draft.backend ?? undefined}
        onChange={(next) => {
          update("modelProvider", next.provider);
          update("modelId", next.model);
        }}
      />

      <Field label="Reasoning">
        <ThinkingLevelPicker
          value={draft.thinkingLevel as ThinkingLevel | null}
          onChange={(v) => update("thinkingLevel", v)}
        />
      </Field>

      <Field label="Tools">
        <ToolsPicker
          value={draft.toolsProfile}
          onChange={(next) => update("toolsProfile", next)}
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Budget — max turns">
          <Input
            type="number"
            min={1}
            uiSize="sm"
            value={draft.budgetMaxTurns ?? ""}
            onChange={(e) =>
              update(
                "budgetMaxTurns",
                e.target.value ? Number(e.target.value) : null
              )
            }
            className={fieldClass}
            placeholder="—"
          />
        </Field>
        <Field label="Budget — max seconds">
          <Input
            type="number"
            min={1}
            uiSize="sm"
            value={draft.budgetMaxSeconds ?? ""}
            onChange={(e) =>
              update(
                "budgetMaxSeconds",
                e.target.value ? Number(e.target.value) : null
              )
            }
            className={fieldClass}
            placeholder="—"
          />
        </Field>
      </div>

      <PersonaLaurels personaId={draft.id} />

      <div className="flex items-center gap-3 pt-2">
        <Button
          onClick={save}
          disabled={saveState === "saving" || resetState === "saving"}
          className="gap-2"
        >
          {saveState === "saving" ? (
            <Spinner />
          ) : saveState === "saved" ? (
            <Check className="size-3.5" />
          ) : (
            <Save className="size-3.5" />
          )}
          {saveState === "saved" ? "Saved" : "Save"}
        </Button>
        <Button
          variant="outline"
          onClick={resetToDefault}
          disabled={saveState === "saving" || resetState === "saving"}
          className="gap-2"
        >
          {resetState === "saving" ? (
            <Spinner />
          ) : resetState === "saved" ? (
            <Check className="size-3.5" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {resetState === "saved" ? "Reset" : "Reset to default"}
        </Button>
        <ErrorText>{errorMsg}</ErrorText>
      </div>
    </li>
  );
}

const fieldClass = "rounded-md px-2.5 text-sm";

const ENGINE_OPTIONS = [
  { value: "", label: "Deployment default" },
  { value: "pi", label: "pi" },
  { value: "claude", label: "claude" },
] as const;

/** Agent-backend ("engine") selector for persona defaults. An empty value
 *  means "inherit the deployment default (TASK_ORCH_AGENT_BACKEND)". */
function EnginePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <Select
      mono
      uiSize="sm"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={fieldClass}
    >
      {ENGINE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
