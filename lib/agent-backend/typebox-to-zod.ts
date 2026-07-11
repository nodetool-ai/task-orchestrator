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

// Build a union of literals, guarding against Zod's requirement of >= 2 options:
// z.union throws on a single-element array, which would make a tool with a
// one-value non-string enum/const un-registerable — the exact "never
// un-registerable" guarantee this module promises. Collapse to the lone literal
// (or z.any() for the empty case) instead.
function literalUnion(vals: any[]): z.ZodTypeAny {
  if (vals.length === 0) return z.any();
  if (vals.length === 1) return z.literal(vals[0]);
  return z.union(vals.map((v) => z.literal(v)) as any);
}

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
      return literalUnion(vals);
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
    return literalUnion(vals);
  }

  switch (schema.type) {
    case "string":
      return applyStringConstraints(z.string(), schema);
    case "integer":
      return applyNumberConstraints(z.number().int(), schema);
    case "number":
      return applyNumberConstraints(z.number(), schema);
    case "boolean":
      return z.boolean();
    case "array":
      return applyArrayConstraints(z.array(toZodType(schema.items ?? {})), schema);
    case "object":
      return z.object(toZodRawShape(schema));
    default:
      return z.any();
  }
}

// Carry across the JSON-Schema validation keywords our tools actually use, so
// the Claude backend enforces the same input contracts as pi/MCP instead of
// passing unvalidated params through to tool implementations.
function applyStringConstraints(z0: z.ZodString, schema: any): z.ZodString {
  let zt = z0;
  if (typeof schema.minLength === "number") zt = zt.min(schema.minLength);
  if (typeof schema.maxLength === "number") zt = zt.max(schema.maxLength);
  if (typeof schema.pattern === "string") {
    try {
      zt = zt.regex(new RegExp(schema.pattern));
    } catch {
      /* an un-compilable pattern shouldn't make the tool un-registerable */
    }
  }
  return zt;
}

function applyNumberConstraints(z0: z.ZodNumber, schema: any): z.ZodNumber {
  let zt = z0;
  if (typeof schema.minimum === "number") zt = zt.min(schema.minimum);
  if (typeof schema.maximum === "number") zt = zt.max(schema.maximum);
  // draft-07 numeric form of the exclusive bounds (TypeBox emits these).
  if (typeof schema.exclusiveMinimum === "number") zt = zt.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === "number") zt = zt.lt(schema.exclusiveMaximum);
  return zt;
}

function applyArrayConstraints(z0: z.ZodArray<any>, schema: any): z.ZodArray<any> {
  let zt = z0;
  if (typeof schema.minItems === "number") zt = zt.min(schema.minItems);
  if (typeof schema.maxItems === "number") zt = zt.max(schema.maxItems);
  return zt;
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
    // Honor JSON-Schema `default`s so the Claude/MCP paths fill omitted params
    // the same way the pi backend does (Zod's .default() also implies optional
    // input, applied last so it wraps the optional above).
    if (value && typeof value === "object" && (value as any).default !== undefined) {
      zt = zt.default((value as any).default);
    }
    shape[key] = zt;
  }
  return shape;
}
