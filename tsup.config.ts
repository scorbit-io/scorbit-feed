import { defineConfig } from "tsup";

export default defineConfig([
  // The library: ESM for bundlers and Node, with declarations.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "neutral",
    target: "es2022",
    dts: true,
    sourcemap: true,
  },
  // The browser subset (attach only) as one self-contained script for a <script> tag or CDN.
  {
    entry: { "scorbit-feed": "src/browser.ts" },
    format: ["iife"],
    globalName: "ScorbitFeed",
    platform: "browser",
    target: "es2020",
    noExternal: [/.*/],
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: ".iife.js" }),
  },
  // The agent CLI: Node only, dependencies stay external.
  {
    entry: { cli: "src/bin.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
  },
]);
