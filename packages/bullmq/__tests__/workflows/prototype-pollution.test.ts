import { describe, expect, it } from "bun:test";
import { flattenChildResults } from "../../src/workflows/workflow-result-utils.ts";

describe("flattenChildResults prototype pollution prevention", () => {
  it("sanitizes sequential prior and step results and rewrites dangerous step names", () => {
    const output = flattenChildResults({
      "workflow:step": {
        __version: "1",
        __stepName: "__proto__",
        __stepResult: JSON.parse(
          '{"nested":{"constructor":{"polluted":true}},"safe":"step"}',
        ),
        __priorResults: JSON.parse(
          '{"__proto__":{"polluted":true},"prior":"safe"}',
        ),
      },
    });

    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(output, "__proto__")).toBe(
      false,
    );
    expect(output.prior).toBe("safe");
    expect(output._sanitized___proto__).toEqual({ nested: {}, safe: "step" });
  });

  it("sanitizes parallel prior and step results before merging", () => {
    const output = flattenChildResults({
      "workflow:parallel": {
        __version: "1",
        __parallelResults: JSON.parse(
          '{"__proto__":{"polluted":true},"parallel":{"prototype":{"polluted":true},"safe":true}}',
        ),
        __priorResults: JSON.parse(
          '{"constructor":{"prototype":{"polluted":true}},"prior":1}',
        ),
      },
    });

    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(output, "__proto__")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(output, "constructor")).toBe(
      false,
    );
    expect(output).toEqual({ prior: 1, parallel: { safe: true } });
  });
});
