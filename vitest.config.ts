import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // P1-9 gates hook global state (net.Socket); keep files isolated.
    isolate: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // types.ts is type-only: it emits no runtime code, so a coverage figure for it is noise.
      exclude: ["src/domain/types.ts"],
      thresholds: {
        // P1-2 acceptance: 100% branch coverage on the day-boundary logic.
        "src/domain/window.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/domain/ports.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
