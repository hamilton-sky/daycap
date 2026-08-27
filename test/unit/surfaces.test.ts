import { describe, expect, it } from "vitest";
import { markerDirFor, UNPRICEABLE_TOOLS } from "../../src/domain/surfaces.ts";

/**
 * P5-3. Small surface, but two of these assertions are load-bearing for a GATE rather than for
 * behaviour, which is why they are spelled out instead of trusted to be obvious.
 */
describe("domain/surfaces — tools that cannot be priced", () => {
  it("derives a tool's home marker from its own name", () => {
    expect(markerDirFor("cursor")).toBe(".cursor");
    expect(markerDirFor("someeditor")).toBe(".someeditor");
  });

  it("names Cursor, whose spend is unknowable from disk", () => {
    expect([...UNPRICEABLE_TOOLS]).toContain("cursor");
  });

  it("never names a tool we DO price, which would make the list a contradiction", () => {
    // claude-code and codex are both priced through ccusage. If either appeared here, `doctor`
    // would print "cannot be counted" about a tool visible in its own spend table one line below.
    expect([...UNPRICEABLE_TOOLS]).not.toContain("claude-code");
    expect([...UNPRICEABLE_TOOLS]).not.toContain("codex");
  });

  it("holds no dotted entries — the dot is the rule's job, not the data's", () => {
    // A ".cursor" entry here would still work, and would also silently reintroduce the literal the
    // import gate forbids. Keeping the data undotted is what makes that impossible by construction.
    for (const tool of UNPRICEABLE_TOOLS) expect(tool.startsWith(".")).toBe(false);
  });
});
