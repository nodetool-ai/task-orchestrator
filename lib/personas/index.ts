import type { Persona } from "./types";
import { reviewer } from "./reviewer";
import { implementor } from "./implementor";
import { planner } from "./planner";
import { designer } from "./designer";
import { qa } from "./qa";

export type { Persona };
export const PERSONAS: ReadonlyArray<Persona> = [
  reviewer,
  implementor,
  planner,
  designer,
  qa,
];
