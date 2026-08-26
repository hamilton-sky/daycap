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

  it("does not spawn a child process either", () => {
    expect(text).not.toContain("child_process");
    expect(text).not.toContain("spawn");
  });
});
