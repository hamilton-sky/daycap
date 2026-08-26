import { describe, expect, it } from "vitest";
import { SourceIncompatibleError } from "../../src/domain/ports.ts";

/**
 * `ports.ts` is interfaces plus one error class. The error is the C12 contract case's failure
 * channel — "HTTP 200 with garbage JSON must surface as a typed error, never an unhandled
 * TypeError" — so it is worth pinning that it is catchable as an Error and carries the source id.
 */
describe("SourceIncompatibleError", () => {
  it("is an Error subclass with a stable name", () => {
    const err = new SourceIncompatibleError("budi", "providers[] was a string");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SourceIncompatibleError");
  });

  it("carries the source id and the detail in the message", () => {
    const err = new SourceIncompatibleError("ccusage", "missing daily[]");
    expect(err.sourceId).toBe("ccusage");
    expect(err.message).toContain("ccusage");
    expect(err.message).toContain("missing daily[]");
  });

  it("is catchable by type, so an adapter can distinguish it from a bug", () => {
    let caught: unknown;
    try {
      throw new SourceIncompatibleError("budi", "unknown schema");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceIncompatibleError);
  });
});
