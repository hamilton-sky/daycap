import { describe, expect, it } from "vitest";
import { NullNotifier, OsNotifier, scrub } from "../../src/adapters/notify/notifier.ts";

type Call = { cmd: string; args: readonly string[] };

function recorder(ok = true) {
  const calls: Call[] = [];
  return {
    calls,
    run: (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(ok);
    },
  };
}

describe("scrub — ADR-v2-004: no paths, names, or prompt content", () => {
  it("removes path separators, which is the likeliest leak", () => {
    expect(scrub("spend in /Users/alice/secret-project")).not.toContain("/");
    expect(scrub("C:\\Users\\alice")).not.toContain(String.fromCharCode(92));
  });

  it("removes quotes so text cannot terminate an AppleScript or PowerShell literal", () => {
    const out = scrub(`a "b" 'c' TICKdTICK`.replace(/TICK/g, String.fromCharCode(96)));
    expect(out).not.toMatch(/["'`]/);
  });

  it("removes control characters", () => {
    const nasty = `a${String.fromCharCode(0)}b${String.fromCharCode(27)}[31mc${String.fromCharCode(7)}`;
    const out = scrub(nasty);
    expect([...out].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)).toBe(true);
  });

  it("collapses whitespace and caps length", () => {
    expect(scrub("  a\n\n   b  ")).toBe("a b");
    expect(scrub("x".repeat(500)).length).toBe(120);
  });
});

describe("OsNotifier — argv, never a shell string", () => {
  it.each([
    ["darwin", "osascript"],
    ["linux", "notify-send"],
    ["win32", "powershell"],
  ])("%s uses %s with an argv array", async (platform, cmd) => {
    const r = recorder();
    await new OsNotifier({ platform: platform as NodeJS.Platform, run: r.run }).notify({
      title: "AI spend at 80%",
      body: "$8.00 of $10.00 daily budget.",
    });
    expect(r.calls[0]?.cmd).toBe(cmd);
    expect(Array.isArray(r.calls[0]?.args)).toBe(true);
    // No argument may be a compound shell line with an operator in it.
    for (const a of r.calls[0]?.args ?? []) expect(a).not.toMatch(/;\s*rm |&&|\|\|/);
  });

  it("scrubs before the text ever reaches argv", async () => {
    const r = recorder();
    await new OsNotifier({ platform: "linux", run: r.run }).notify({
      title: "spend in /Users/alice/repo",
      body: "x",
    });
    expect(r.calls[0]?.args.join(" ")).not.toContain("/Users/alice");
  });

  it("an unknown platform goes straight to the bell", async () => {
    const bells: string[] = [];
    const r = recorder();
    await new OsNotifier({
      platform: "aix",
      run: r.run,
      bell: (s) => bells.push(s),
    }).notify({ title: "T", body: "B" });
    expect(r.calls).toEqual([]);
    expect(bells.join()).toContain("T");
  });

  it("a missing binary is a no-op that falls back, not an error", async () => {
    const bells: string[] = [];
    const r = recorder(false); // command could not be launched
    await new OsNotifier({ platform: "linux", run: r.run, bell: (s) => bells.push(s) }).notify({
      title: "T",
      body: "B",
    });
    expect(r.calls).toHaveLength(1);
    expect(bells.join()).toContain("T");
  });

  it("honours a user command and substitutes {title} / {body}", async () => {
    const r = recorder();
    await new OsNotifier({
      command: ["my-notifier", "--title", "{title}", "--body", "{body}"],
      run: r.run,
    }).notify({ title: "AI spend at 80%", body: "eight of ten" });
    expect(r.calls[0]).toEqual({
      cmd: "my-notifier",
      args: ["--title", "AI spend at 80%", "--body", "eight of ten"],
    });
  });

  it("NEVER throws into the caller, whatever the runner does", async () => {
    await expect(
      new OsNotifier({
        run: () => {
          throw new Error("spawn exploded");
        },
        bell: () => {
          throw new Error("bell exploded too");
        },
      }).notify({ title: "T", body: "B" }),
    ).resolves.toBeUndefined();
  });
});

describe("NullNotifier", () => {
  it("discards silently when notifications are disabled", async () => {
    await expect(new NullNotifier().notify()).resolves.toBeUndefined();
  });
});
