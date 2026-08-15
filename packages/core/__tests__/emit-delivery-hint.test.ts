/**
 * Emit delivery-hint classification.
 *
 * The event definition's result schema is only in scope at the emitter; the
 * provider receives `(name, payload, meta, options)` and never sees a schema.
 * The emitter therefore classifies the definition and passes the verdict down
 * as `EmitOptions.expectsResult`, keeping TypeBox inspection out of every
 * transport package.
 *
 * Regression: without the hint, a transport cannot distinguish fire-and-forget
 * from request-response and couples every emission to consumer availability.
 */

import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";

import { expectsResultFromSchema } from "../src/events/delivery-hint.ts";

describe("expectsResultFromSchema", () => {
  it("should report no result expected for a void result schema", () => {
    expect(expectsResultFromSchema(Type.Void())).toBe(false);
  });

  it("should report a result expected for an object result schema", () => {
    expect(
      expectsResultFromSchema(Type.Object({ processed: Type.Boolean() })),
    ).toBe(true);
  });

  it("should report a result expected for a primitive result schema", () => {
    expect(expectsResultFromSchema(Type.Boolean())).toBe(true);
  });

  it("should report a result expected when the schema is absent", () => {
    // Callers that emit without a definition keep request-response semantics.
    expect(expectsResultFromSchema(undefined)).toBe(true);
  });

  it("should not treat undefined-typed schemas as void", () => {
    // `Type.Undefined()` is a value-carrying schema; only `Type.Void()` marks
    // fire-and-forget per the EventConfig contract.
    expect(expectsResultFromSchema(Type.Undefined())).toBe(true);
  });
});
