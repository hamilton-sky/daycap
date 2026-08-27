import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EgressForbiddenError, hostFromConnectArgs, isAllowed } from "../setup/network-guard.ts";

/**
 * Gate 2 of 3 — proof that the suite-wide network guard is real.
 *
 * The guard itself lives in `test/setup/network-guard.ts` and is installed by vitest `setupFiles`
 * for every file in the run. This test exists because an always-passing guard is worse than none:
 * it has to be shown to actually reject egress, and to actually permit loopback.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("gate: network boundary", () => {
  it("rejects a real connect to a non-loopback address", () => {
    const socket = new net.Socket();
    try {
      // If this ever succeeds, the product has grown an egress path and the fence is down.
      expect(() => socket.connect(80, "example.com")).toThrow(EgressForbiddenError);
    } finally {
      socket.destroy();
    }
  });

  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["localhost", true],
    ["::ffff:127.0.0.1", true],
    [null, true],
    ["example.com", false],
    ["registry.npmjs.org", false],
    ["8.8.8.8", false],
    ["127.0.0.1.evil.com", false],
  ])("host %s allowed=%s", (host, allowed) => {
    expect(isAllowed(host)).toBe(allowed);
  });

  it.each([
    [[{ host: "example.com", port: 443 }], "example.com"],
    [[443, "example.com"], "example.com"],
    [[{ port: 7878 }], "localhost"],
    [["/tmp/x.sock"], null],
    [[{ path: "/tmp/x.sock" }], null],
  ])("extracts the host from connect(%j)", (args, expected) => {
    expect(hostFromConnectArgs(args as unknown[])).toBe(expected);
  });

  it("permits loopback, because a local collector daemon is a legitimate design", () => {
    const socket = new net.Socket();
    try {
      // Nothing is listening; the point is only that the GUARD does not object.
      expect(() => socket.connect(1, "127.0.0.1")).not.toThrow(EgressForbiddenError);
    } finally {
      socket.destroy();
    }
  });
});

describe("gate: statusline.js opens no socket at all", () => {
  const text = readFileSync(join(root, "src", "bin", "statusline.js"), "utf8");

  it.each(["node:net", "node:http", "node:https", "node:dgram", "node:tls", "fetch(", "XMLHttp"])(
    "does not reference %s",
    (needle) => {
      // It runs on every prompt render. A socket here is both a latency cost the user pays
      // constantly and an egress path in the one file least likely to be reviewed again.
      expect(text).not.toContain(needle);
    },
  );

  /**
   * The child-process ban, applied to CODE rather than to prose.
   *
   * WHY COMMENTS ARE STRIPPED HERE, because this is a gate being loosened and the house rule is that
   * a loosening carries its reasoning in the same commit:
   *
   * This fired on a comment. The latency gate's own explanation of what it measures said the file's
   * fs cost "was measured nowhere except through a whole process spawn" — a true sentence about why
   * this file must not do that, and the gate rejected it. `test/gates/imports.test.ts` already
   * strips comments for exactly this case and states the principle: "a gate that forbids explaining
   * itself is a gate people delete." This one simply never got the same treatment.
   *
   * The ban on the BEHAVIOUR is unchanged — `code()` removes comments and nothing else, so any real
   * `spawn(` or `child_process` import still fails, and the mutation check below proves it.
   */
  const code = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("does not spawn a child process either", () => {
    const stripped = code(text);
    expect(stripped).not.toContain("child_process");
    expect(stripped).not.toContain("spawn");
  });

  it("...and the ban still bites on real code, not just on prose", () => {
    // Mutation check, in memory rather than by planting a spawn in src/: a crash mid-test would
    // otherwise strand the repo with a real child_process call committed to the hot path.
    const real = 'import { spawnSync } from "node:child_process";\nspawnSync("ls");';
    expect(code(real)).toContain("child_process");
    expect(code(real)).toContain("spawn");
    // And the case that made this change necessary now passes.
    const prose = "// measured nowhere except through a whole process spawn\nconst x = 1;";
    expect(code(prose)).not.toContain("spawn");
  });
});
