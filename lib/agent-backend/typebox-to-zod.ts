// lib/agent-backend/typebox-to-zod.ts
//
// The Claude Agent SDK's tool() helper takes a Zod raw shape (it accepts a
// zod-v3 shape, which is what this project ships). Our tools carry TypeBox
// schemas (= JSON Schema). This converts a TypeBox object schema into a Zod raw
// shape, covering exactly the JSON-Schema constructs our tools use: object,
// string, number, integer, boolean, array, const (literal), enum, and
// anyOf/union (incl. unions of string literals → enum). Unknown shapes fall
// back to z.any() so a tool is never un-registerable.

import { z } from "zod";
import type { TSchema } from "typebox";

export function toZodType(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();

  if (schema.const !== undefined) return z.literal(schema.const);

  if (Array.isArray(schema.anyOf)) {
    const all = schema.anyOf;
    if (all.length > 0 && all.every((s: any) => s && s.const !== undefined)) {
      const vals = all.map((s: any) => s.const);
      if (vals.every((v: any) => typeof v === "string")) {
        return z.enum(vals as [string, ...string[]]);
      }
      return z.union(vals.map((v: any) => z.literal(v)) as any);
    }
    const opts = all.map(toZodType);
    if (opts.length >= 2) return z.union(opts as any);
    return opts[0] ?? z.any();
  }

  if (Array.isArray(schema.enum)) {
    const vals = schema.enum;
    if (vals.length > 0 && vals.every((v: any) => typeof v === "string")) {
      return z.enum(vals as [string, ...string[]]);
    }
    return z.union(vals.map((v: any) => z.literal(v)) as any);
  }

  switch (schema.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(toZodType(schema.items ?? {}));
    case "object":
      return z.object(toZodRawShape(schema));
    default:
      return z.any();
  }
}

/** Convert a TypeBox object schema to a Zod raw shape (`{ key: ZodType }`),
 *  marking non-required keys optional. */
export function toZodRawShape(objectSchema: TSchema | any): z.ZodRawShape {
  const props = (objectSchema as any)?.properties ?? {};
  const required: string[] = (objectSchema as any)?.required ?? [];
  const shape: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(props)) {
    let zt = toZodType(value);
    if (!required.includes(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}
