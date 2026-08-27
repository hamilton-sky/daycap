/**
 * OS notifications. Fire-and-forget, and it must NEVER throw into the caller.
 *
 * A notifier that throws takes down the run that was trying to warn you — converting a cosmetic
 * failure (no toast) into a total one (no number either). Every path here swallows.
 *
 * Two hard rules:
 *
 *  - **argv arrays, never a shell string.** `shell: false` everywhere. Notification text derives
 *    from config and collector output; the moment it reaches a shell, a tool id becomes an
 *    injection vector.
 *  - **No paths, project names, or prompt content** (ADR-v2-004). `scrub()` enforces that rather
 *    than trusting callers, because the caller is the easy place to regress.
 */

import { execFile } from "node:child_process";
import { CLI_NAME } from "../../domain/brand.ts";
import type { Notification, NotifierPort } from "../../domain/ports.ts";

export type NotifierOptions = {
  /** `notifications.command` — a user argv array. `{title}` / `{body}` are substituted. */
  command?: readonly string[];
  platform?: NodeJS.Platform;
  /** Injected in tests. Resolves true when the command actually launched. */
  run?: (cmd: string, args: readonly string[]) => Promise<boolean>;
  /** Where the bell fallback goes. */
  bell?: (s: string) => void;
};

/**
 * Strip anything that could carry user data or break out of an argument.
 *
 * Path separators go first: a repository path is the likeliest thing to leak into a title, and it
 * is the one ADR-v2-004 names explicitly. Quotes follow, so the text cannot terminate an
 * AppleScript or PowerShell string literal early. Then control characters, then a length cap — a
 * toast that spans the screen is its own kind of leak.
 */
export function scrub(text: string): string {
  return (
    text
      .replace(/[/\\]/g, " ")
      .replace(/["'`]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the entire point.
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
  );
}

function defaultRun(cmd: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, [...args], { shell: false, timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/** Per-platform argv. `null` where the platform has no native notifier we can rely on. */
function argvFor(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case "darwin":
      return {
        cmd: "osascript",
        args: [
          "-e",
          `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
        ],
      };
    case "linux":
      return { cmd: "notify-send", args: [`--app-name=${CLI_NAME}`, title, body] };
    case "win32":
      return {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');" +
            "$n=New-Object System.Windows.Forms.NotifyIcon;" +
            "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
            `$n.ShowBalloonTip(5000,${JSON.stringify(title)},${JSON.stringify(body)},'Info')`,
        ],
      };
    default:
      return null;
  }
}

export class OsNotifier implements NotifierPort {
  #options: NotifierOptions;

  constructor(options: NotifierOptions = {}) {
    this.#options = options;
  }

  async notify(n: Notification): Promise<void> {
    try {
      const title = scrub(n.title);
      const body = scrub(n.body);
      const run = this.#options.run ?? defaultRun;
      const platform = this.#options.platform ?? process.platform;
      const custom = this.#options.command;

      if (custom !== undefined && custom.length > 0) {
        const [cmd, ...rest] = custom.map((a) =>
          a.replaceAll("{title}", title).replaceAll("{body}", body),
        );
        if (cmd !== undefined && (await run(cmd, rest))) return;
      } else {
        const native = argvFor(platform, title, body);
        // A missing binary is a no-op, not an error: notify-send is not installed everywhere.
        if (native !== null && (await run(native.cmd, native.args))) return;
      }

      // Last resort. A terminal bell is not nothing, and it costs no dependency.
      (this.#options.bell ?? ((s: string) => process.stderr.write(s)))(`${title}\n`);
    } catch {
      // Invariant: never throw into the caller.
    }
  }
}

/** Discards everything. Used when `notifications.enabled` is false. */
export class NullNotifier implements NotifierPort {
  notify(): Promise<void> {
    return Promise.resolve();
  }
}
