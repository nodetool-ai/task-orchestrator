import type { Persona } from "./types";
import { reviewer } from "./reviewer";
import { implementor } from "./implementor";
import { planner } from "./planner";
import { designer } from "./designer";
import { qa } from "./qa";
import { planningAgent } from "./planning-agent";
import { executor } from "./executor";

export type { Persona };
export const PERSONAS: ReadonlyArray<Persona> = [
  reviewer,
  implementor,
  planner,
  designer,
  qa,
  planningAgent,
  executor,
];
