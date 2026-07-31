import type { Persona } from "./types";
import { implementor } from "./implementor";
import { planner } from "./planner";
import { designer } from "./designer";
import { qa } from "./qa";
import { planningAgent } from "./planning-agent";
import { executor } from "./executor";
import { concierge } from "./concierge";

export type { Persona };
export const PERSONAS: ReadonlyArray<Persona> = [
  implementor,
  planner,
  designer,
  qa,
  planningAgent,
  executor,
  concierge,
];
