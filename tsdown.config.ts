import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin/daycap.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  dts: false,
  clean: true,
  // src/bin/statusline.js ships as-is: node:fs only, no bundling, always exit 0.
});
