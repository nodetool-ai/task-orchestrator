import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { toZodRawShape } from "../../lib/agent-backend/typebox-to-zod";

describe("toZodRawShape", () => {
  it("converts a representative TypeBox object schema to a validating Zod shape", () => {
    const schema = Type.Object({
      url: Type.String({ minLength: 1 }),
      verdict: Type.Union([
        Type.Literal("approve"),
        Type.Literal("comment"),
        Type.Literal("request_changes"),
      ]),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
      flag: Type.Optional(Type.Boolean()),
    });
    const shape = toZodRawShape(schema);
    expect(Object.keys(shape).sort()).toEqual(["flag", "limit", "url", "verdict"]);

    // Required fields validate; optional fields may be omitted.
    expect(shape.url.safeParse("x").success).toBe(true);
    expect(shape.url.safeParse(123).success).toBe(false);
    expect(shape.verdict.safeParse("approve").success).toBe(true);
    expect(shape.verdict.safeParse("nope").success).toBe(false);
    expect(shape.limit.safeParse(undefined).success).toBe(true);
    expect(shape.limit.safeParse(2.5).success).toBe(false); // integer
    expect(shape.flag.safeParse(true).success).toBe(true);
  });

  it("handles arrays and nested objects", () => {
    const schema = Type.Object({
      tags: Type.Array(Type.String()),
      meta: Type.Object({ n: Type.Number() }),
    });
    const shape = toZodRawShape(schema);
    expect(shape.tags.safeParse(["a", "b"]).success).toBe(true);
    expect(shape.tags.safeParse([1]).success).toBe(false);
    expect(shape.meta.safeParse({ n: 1 }).success).toBe(true);
  });
});
