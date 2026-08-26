/**
 * `lum` CLI entrypoint.
 *
 * P1-0 scaffold: argument routing and exit-code discipline only. The commands themselves land in
 * P1-8 (`today`), P4-5 (`doctor`) and P2 (`refresh`), each behind `UsageSourcePort` — never
 * reaching for a collector directly from here.
 */

import { pathToFileURL } from "node:url";

const VERSION = "0.0.0";

const USAGE = `lum — local budget guardrail for AI coding tools

Usage:
  lum today            today's spend across every configured tool, vs your allowance
  lum doctor           which collector was found, how fresh it is, what is missing
  lum refresh          re-read the collector and update the cached snapshot
  lum --version        print the version
  lum --help           print this message
`;

type Command = "today" | "doctor" | "refresh" | "version" | "help";

/** Pure: maps argv to a command so it can be tested without spawning a process. */
export function parseArgs(argv: readonly string[]): { command: Command; unknown?: string } {
  const first = argv[0];
  if (first === undefined) return { command: "today" };
  switch (first) {
    case "today":
    case "doctor":
    case "refresh":
      return { command: first };
    case "-v":
    case "--version":
      return { command: "version" };
    case "-h":
    case "--help":
      return { command: "help" };
    default:
      return { command: "help", unknown: first };
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, unknown } = parseArgs(argv);

  if (unknown !== undefined) {
    process.stderr.write(`lum: unknown command ${JSON.stringify(unknown)}\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "today":
    case "doctor":
    case "refresh":
      // Deliberately not stubbed with a fake number: "unknown must never render as $0.00" is a
      // correctness rule (DoD #3), and that includes during construction.
      process.stderr.write(`lum ${command}: not implemented yet (P1-7 / P1-8)\n`);
      return 69; // EX_UNAVAILABLE
  }
}

/**
 * Only run when executed directly. Without this guard, importing the module to test `parseArgs`
 * runs the CLI as a side effect — writing to stderr and setting `process.exitCode` mid-suite.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`lum: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 70; // EX_SOFTWARE
    },
  );
}
