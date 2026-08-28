// `/new` persona completion. The server owns the persona registry (GET
// /api/personas); this module only matches the first argument and replaces it
// with the canonical id. The goal that follows stays free-form.

import type { PersonaRef } from "../cli/commands.js";

export interface PersonaOption {
  value: string;
  label: string;
}

const CMD = "/new";

/** Keep completion from consuming more vertical space than the model picker. */
export const PERSONA_SUGGESTIONS = 8;

/**
 * Suggest personas only while `/new`'s first argument is being written.
 * Matching accepts the canonical id and the display name, but completion
 * always inserts the id accepted by the run API.
 */
export function matchPersonas(
  input: string,
  personas: readonly PersonaRef[],
  limit = PERSONA_SUGGESTIONS,
): PersonaOption[] {
  if (!input.startsWith(CMD)) return [];
  const rest = input.slice(CMD.length);
  if (!/^\s/.test(rest)) return [];
  const words = rest.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return []; // the goal has begun
  const q = words[0]?.toLowerCase() ?? "";
  if (personas.some((p) => samePersona(p, q))) return [];
  return personas
    .map((p, i) => ({ option: { value: p.id, label: p.name }, rank: rank(p, q) * 1000 + i }))
    .filter((p) => p.rank < 4000)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((p) => p.option);
}

/** Complete an already exact display name or id with the space for the goal. */
export function completePersona(input: string, personas: readonly PersonaRef[]): string | null {
  if (!input.startsWith(CMD)) return null;
  const rest = input.slice(CMD.length);
  if (!/^\s+\S+$/.test(rest)) return null;
  const q = rest.trim().toLowerCase();
  const persona = personas.find((p) => samePersona(p, q));
  return persona ? `${CMD} ${persona.id} ` : null;
}

/** Replace the first argument and leave a space ready for the free-form goal. */
export function applyPersonaCompletion(_input: string, value: string): string {
  return `${CMD} ${value} `;
}

function samePersona(persona: PersonaRef, q: string): boolean {
  return persona.id.toLowerCase() === q || persona.name.toLowerCase() === q;
}

function rank(persona: PersonaRef, q: string): number {
  if (q === "") return 0;
  const id = persona.id.toLowerCase();
  const name = persona.name.toLowerCase();
  if (id.startsWith(q)) return 0;
  if (name.startsWith(q)) return 1;
  if (id.includes(q)) return 2;
  if (name.includes(q)) return 3;
  return 4;
}
