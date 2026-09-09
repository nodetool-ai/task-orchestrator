export interface CodeActHandle { handle: string; kind: "artifact" | "image"; mimeType?: string; size?: number }
export interface CodeActOutput { kind: "text" | "image"; value: unknown }

export function boundedText(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes - 32))) + "… [truncated]";
}

export function normalizeOutput(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") return boundedText(value, maxBytes);
  const json = boundedText(value, maxBytes);
  try { return JSON.parse(json); } catch { return json; }
}
