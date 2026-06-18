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

  it("propagates JSON-Schema constraints so the Claude backend enforces them", () => {
    const schema = Type.Object({
      name: Type.String({ minLength: 2, maxLength: 4 }),
      slug: Type.String({ pattern: "^[a-z]+$" }),
      count: Type.Integer({ minimum: 1, maximum: 10 }),
      ratio: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
      items: Type.Array(Type.String(), { minItems: 1, maxItems: 2 }),
    });
    const shape = toZodRawShape(schema);

    expect(shape.name.safeParse("ab").success).toBe(true);
    expect(shape.name.safeParse("a").success).toBe(false); // < minLength
    expect(shape.name.safeParse("abcde").success).toBe(false); // > maxLength

    expect(shape.slug.safeParse("abc").success).toBe(true);
    expect(shape.slug.safeParse("Abc1").success).toBe(false); // pattern

    expect(shape.count.safeParse(1).success).toBe(true);
    expect(shape.count.safeParse(0).success).toBe(false); // < minimum
    expect(shape.count.safeParse(11).success).toBe(false); // > maximum

    expect(shape.ratio.safeParse(0.5).success).toBe(true);
    expect(shape.ratio.safeParse(0).success).toBe(false); // exclusiveMinimum
    expect(shape.ratio.safeParse(1).success).toBe(false); // exclusiveMaximum

    expect(shape.items.safeParse(["a"]).success).toBe(true);
    expect(shape.items.safeParse([]).success).toBe(false); // < minItems
    expect(shape.items.safeParse(["a", "b", "c"]).success).toBe(false); // > maxItems
  });

  it("ignores an un-compilable string pattern instead of throwing", () => {
    const shape = toZodRawShape({
      type: "object",
      properties: { s: { type: "string", pattern: "(" } },
      required: ["s"],
    });
    expect(shape.s.safeParse("anything").success).toBe(true);
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
