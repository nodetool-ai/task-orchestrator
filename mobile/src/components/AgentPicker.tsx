import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { Field, Mono, Press } from "./primitives";
import { Icon, type IconName } from "./Icon";
import { useTheme, mono } from "@/theme";
import { loadModelCatalog, qualify, type ModelCatalog, type ModelOption } from "@/lib/model-options";
import type { BackendId, Persona } from "@/lib/types";

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface AgentConfig {
  personaId: string;
  backend: BackendId | null;
  /** Qualified `provider/modelId`; null → the deployment default. */
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
}

const ROLE_ICON: Record<string, IconName> = {
  planner: "plans",
  designer: "edit",
  implementor: "code",
  reviewer: "check",
  qa: "check",
};

const THINKING: (ThinkingLevel | null)[] = [null, "low", "medium", "high", "xhigh"];

/**
 * The full agent picker — persona, engine (backend), model, and reasoning
 * level — mirroring the web run-start composers. Controlled: the parent owns an
 * `AgentConfig` and gets a fresh one on every change. `lockBackend` pins one
 * engine (chat runs use "pi") and hides the engine control. Set `showPersona`
 * false for the implement flow, which always runs as `implementor`.
 */
export function AgentPicker({
  personas,
  value,
  onChange,
  active = true,
  lockBackend,
  showPersona = true,
  showThinking = true,
}: {
  personas: Persona[];
  value: AgentConfig;
  onChange: (next: AgentConfig) => void;
  active?: boolean;
  lockBackend?: BackendId;
  showPersona?: boolean;
  showThinking?: boolean;
}) {
  const { c } = useTheme();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelOpen, setModelOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    loadModelCatalog()
      .then((cat) => alive && setCatalog(cat))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);

  const effectiveBackend = lockBackend ?? value.backend ?? catalog?.defaultBackend ?? null;
  const backendOptions = lockBackend ? [] : catalog?.backendOptions ?? [];
  const modelOptions = useMemo(
    () => (effectiveBackend && catalog?.modelsByBackend[effectiveBackend]) || [],
    [effectiveBackend, catalog]
  );

  const grouped = useMemo(() => {
    const by = new Map<string, ModelOption[]>();
    for (const m of modelOptions) {
      const arr = by.get(m.provider) ?? [];
      arr.push(m);
      by.set(m.provider, arr);
    }
    return [...by.entries()];
  }, [modelOptions]);

  const currentModel = modelOptions.find((m) => qualify(m) === value.model) ?? null;

  const set = (patch: Partial<AgentConfig>) => onChange({ ...value, ...patch });

  return (
    <View style={{ gap: 18 }}>
      {showPersona ? (
        <Field label="Persona">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {personas.map((p) => {
              const on = p.id === value.personaId;
              return (
                <Press
                  key={p.id}
                  onPress={() => set({ personaId: p.id })}
                  style={{
                    width: "48%",
                    padding: 11,
                    borderRadius: 11,
                    backgroundColor: on ? c.raised : c.surface,
                    borderWidth: 1,
                    borderColor: on ? c.hairlineStrong : c.hairline,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        backgroundColor: on ? c.raised2 : c.raised,
                        borderWidth: 1,
                        borderColor: c.hairline,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name={ROLE_ICON[p.id] || "user"} size={11} color={on ? c.fg : c.muted} />
                    </View>
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: on ? c.fg : c.muted }}>
                      {p.name}
                    </Text>
                  </View>
                </Press>
              );
            })}
          </View>
        </Field>
      ) : null}

      {backendOptions.length >= 2 ? (
        <Field label="Engine">
          <View style={{ flexDirection: "row", gap: 7 }}>
            {backendOptions.map((b) => {
              const on = b === effectiveBackend;
              return (
                <Press
                  key={b}
                  onPress={() => set({ backend: b, model: null })}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 11,
                    borderRadius: 11,
                    backgroundColor: on ? c.raised : c.surface,
                    borderWidth: 1,
                    borderColor: on ? c.hairlineStrong : c.hairline,
                  }}
                >
                  <Text style={{ fontFamily: mono, fontSize: 13, fontWeight: on ? "700" : "500", color: on ? c.fg : c.muted }}>
                    {b}
                  </Text>
                </Press>
              );
            })}
          </View>
        </Field>
      ) : null}

      {modelOptions.length ? (
        <Field label="Model">
          <Press
            onPress={() => setModelOpen((v) => !v)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              padding: 12,
              borderRadius: 11,
              backgroundColor: c.raised,
              borderWidth: 1,
              borderColor: c.hairline,
            }}
          >
            <Icon name="spark" size={13} color={c.muted} />
            <Text style={{ flex: 1, fontSize: 13, color: c.fg }} numberOfLines={1}>
              {currentModel ? currentModel.name : "Default"}
            </Text>
            <Icon name="chev-d" size={14} color={c.muted} />
          </Press>
          {modelOpen ? (
            <View style={{ marginTop: 8 }}>
              <ModelRow
                label="Default"
                sub="deployment default"
                on={value.model == null}
                onPress={() => {
                  set({ model: null });
                  setModelOpen(false);
                }}
              />
              {grouped.map(([provider, models]) => (
                <View key={provider} style={{ marginTop: 8 }}>
                  <Mono style={{ fontSize: 9.5, color: c.muted2, textTransform: "uppercase", marginBottom: 4, marginLeft: 4 }}>
                    {provider}
                  </Mono>
                  {models.map((m) => (
                    <ModelRow
                      key={qualify(m)}
                      label={m.name}
                      sub={m.id}
                      on={qualify(m) === value.model}
                      onPress={() => {
                        set({ model: qualify(m) });
                        setModelOpen(false);
                      }}
                    />
                  ))}
                </View>
              ))}
            </View>
          ) : null}
        </Field>
      ) : null}

      {showThinking ? (
        <Field label="Reasoning">
          <View style={{ flexDirection: "row", gap: 6 }}>
            {THINKING.map((t) => {
              const on = t === value.thinkingLevel;
              return (
                <Press
                  key={t ?? "off"}
                  onPress={() => set({ thinkingLevel: t })}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 9,
                    borderRadius: 10,
                    backgroundColor: on ? c.raised : c.surface,
                    borderWidth: 1,
                    borderColor: on ? c.hairlineStrong : c.hairline,
                  }}
                >
                  <Text style={{ fontSize: 11.5, fontWeight: on ? "700" : "500", color: on ? c.fg : c.muted }}>
                    {t ?? "—"}
                  </Text>
                </Press>
              );
            })}
          </View>
        </Field>
      ) : null}
    </View>
  );
}

function ModelRow({ label, sub, on, onPress }: { label: string; sub: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Press
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingVertical: 9,
        paddingHorizontal: 10,
        borderRadius: 9,
        backgroundColor: on ? c.raised : "transparent",
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 12.5, color: c.fg }}>
          {label}
        </Text>
        <Mono style={{ fontSize: 10, color: c.muted2, marginTop: 1 }} numberOfLines={1}>
          {sub}
        </Mono>
      </View>
      {on ? <Icon name="check" size={13} color={c.fg} /> : null}
    </Press>
  );
}
