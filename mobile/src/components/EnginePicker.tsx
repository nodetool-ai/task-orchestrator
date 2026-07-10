import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { Field, Press } from "./primitives";
import { useTheme, mono } from "@/theme";
import { api } from "@/lib/api";
import type { BackendId } from "@/lib/types";

/**
 * Agent-engine (backend) selector for the run-starting sheets — mirrors the
 * web `BackendPicker`. Loads the server's backend catalog and renders a
 * segmented control. It renders nothing while the catalog is loading or when
 * the deployment offers fewer than two backends: with no real choice the
 * control is just noise (same rule the web picker uses).
 *
 * The parent owns the selected value; the picker calls `onChange` with the
 * deployment default once the catalog resolves so the parent starts from a
 * concrete backend.
 */
export function EnginePicker({
  value,
  onChange,
  active = true,
  label = "Engine",
}: {
  value: BackendId | null;
  onChange: (b: BackendId) => void;
  /** Only fetch/show while the hosting sheet is open. */
  active?: boolean;
  label?: string;
}) {
  const { c } = useTheme();
  const [backends, setBackends] = useState<BackendId[]>([]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .providers()
      .then((p) => {
        if (!alive) return;
        setBackends(p.backends.map((b) => b.id));
        if (value == null) onChange(p.defaultBackend);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // Intentionally only re-run when the sheet opens; `value`/`onChange` are
    // read fresh but must not retrigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (backends.length < 2) return null;

  return (
    <Field label={label}>
      <View style={{ flexDirection: "row", gap: 7 }}>
        {backends.map((b) => {
          const on = b === value;
          return (
            <Press
              key={b}
              onPress={() => onChange(b)}
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
              <Text
                style={{
                  fontFamily: mono,
                  fontSize: 13,
                  fontWeight: on ? "700" : "500",
                  color: on ? c.fg : c.muted,
                }}
              >
                {b}
              </Text>
            </Press>
          );
        })}
      </View>
    </Field>
  );
}
