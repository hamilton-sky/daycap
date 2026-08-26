import { describe, expect, it } from "vitest";
import { parseDaily } from "../../src/adapters/source/ccusage.shellout.ts";
import { SourceIncompatibleError } from "../../src/domain/errors.ts";

const ID = "ccusage";
const row = (over: Record<string, unknown> = {}) => ({
  period: "2026-08-21",
  totalCost: 1,
  modelBreakdowns: [{ modelName: "claude-opus-5", cost: 1 }],
  ...over,
});

describe("parseDaily — shape", () => {
  it("reads daily[] and splits per tool from modelBreakdowns", () => {
    const out = parseDaily(
      {
        daily: [
          row({
            modelBreakdowns: [
              { modelName: "claude-opus-5", cost: 4 },
              { modelName: "gpt-5.6-terra", cost: 2.5 },
            ],
          }),
        ],
      },
      ID,
    );
    expect(out.map((r) => [r.tool, r.usd]).sort()).toEqual([
      ["claude-code", 4],
      ["codex", 2.5],
    ]);
  });

  it("sums the same tool across days in integer cents, avoiding float drift", () => {
    const out = parseDaily({ daily: [row({}), row({}), row({})] }, ID);
    expect(out).toEqual([{ tool: "claude-code", usd: 3, imputed: true }]);
  });

  it("accepts a bare array as the container", () => {
    expect(parseDaily([row()], ID)).toHaveLength(1);
  });

  it("tolerates the cost-key aliases that differ between subcommands", () => {
    const a = parseDaily(
      { daily: [row({ modelBreakdowns: [{ modelName: "claude-opus-5", costUSD: 2 }] })] },
      ID,
    );
    expect(a[0]?.usd).toBe(2);
  });

  it("ignores unknown extra keys rather than treating them as fatal", () => {
    const out = parseDaily({ daily: [row({ someFutureKey: { a: 1 } })], totals: {} }, ID);
    expect(out[0]?.tool).toBe("claude-code");
  });

  it("skips malformed rows and breakdowns instead of throwing", () => {
    const out = parseDaily(
      {
        daily: [
          null,
          "nonsense",
          row({ modelBreakdowns: [null, { cost: 5 }, { modelName: "claude-opus-5", cost: 1 }] }),
        ],
      },
      ID,
    );
    expect(out).toEqual([{ tool: "claude-code", usd: 1, imputed: true }]);
  });
});

describe("parseDaily — pricing rules", () => {
  it("surfaces an unpriceable model as null, never 0 (C9c / DoD #3)", () => {
    const out = parseDaily(
      { daily: [row({ modelBreakdowns: [{ modelName: "mystery-1", cost: null }] })] },
      ID,
    );
    expect(out).toEqual([{ tool: "mystery-1", usd: null, imputed: true }]);
  });

  it("a priced row plus an unpriced row of the same tool keeps the priced amount", () => {
    const out = parseDaily(
      {
        daily: [
          row({ modelBreakdowns: [{ modelName: "claude-opus-5", cost: 1.5 }] }),
          row({ modelBreakdowns: [{ modelName: "claude-opus-5", cost: null }] }),
        ],
      },
      ID,
    );
    expect(out[0]?.usd).toBe(1.5);
  });

  it("never derives USD from tokens — a token-only breakdown is null, not a computed price", () => {
    const out = parseDaily(
      {
        daily: [row({ modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 5_000_000 }] })],
      },
      ID,
    );
    expect(out[0]?.usd).toBeNull();
  });

  it("falls back to the row total when there is no per-model detail", () => {
    const out = parseDaily(
      { daily: [{ period: "2026-08-21", totalCost: 9, metadata: { agents: ["claude"] } }] },
      ID,
    );
    expect(out).toEqual([{ tool: "claude-code", usd: 9, imputed: true }]);
  });

  it("labels an unattributable total rather than guessing a tool", () => {
    const out = parseDaily(
      {
        daily: [{ period: "2026-08-21", totalCost: 9, metadata: { agents: ["claude", "codex"] } }],
      },
      ID,
    );
    expect(out).toEqual([{ tool: "unattributed", usd: 9, imputed: true }]);
  });
});

describe("parseDaily — incompatible payloads", () => {
  // A plain loop, not it.each: the payloads are deliberately heterogeneous (object, number,
  // null) and it.each infers a union tuple that no single callback signature satisfies.
  for (const payload of [{ daily: "not-an-array" }, { notDaily: [] }, 42, null] as unknown[]) {
    it(`throws SourceIncompatibleError for ${JSON.stringify(payload)}`, () => {
      expect(() => parseDaily(payload, ID)).toThrow(SourceIncompatibleError);
    });
  }

  it("names the top-level KEYS but never the VALUES — a payload carries repo names and paths", () => {
    const secret = "CANARY-repo-name";
    let msg = "";
    try {
      parseDaily({ notDaily: [secret], projectPath: secret }, ID);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("notDaily");
    expect(msg).toContain("projectPath");
    // An error message is the easiest place in a codebase to leak user data by accident.
    expect(msg).not.toContain(secret);
  });
});
