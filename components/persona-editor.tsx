"use client";

import { useState } from "react";
import { Check, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToolsPicker } from "@/components/pickers/tools-picker";
import { ErrorText } from "@/components/ui/error-text";
import {
  ThinkingLevelPicker,
  type ThinkingLevel,
} from "@/components/pickers/thinking-level-picker";

export interface PersonaDto {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
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

      <div className="flex items-center gap-3 pt-2">
        <Button
          onClick={save}
          disabled={saveState === "saving"}
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
        <ErrorText>{errorMsg}</ErrorText>
      </div>
    </li>
  );
}

const fieldClass = "rounded-md px-2.5 text-sm";

