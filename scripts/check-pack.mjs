// Fails unless `npm pack` would ship exactly the intended files: nothing from
// src/, test/, or config, and nothing missing. Update EXPECTED deliberately.
import { execFileSync } from "node:child_process";

const EXPECTED = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/cli.js.map",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/scorbit-feed.iife.js",
  "dist/scorbit-feed.iife.js.map",
  "package.json",
  "templates/overlay/index.html",
  "templates/overlay/overlay.css",
  "templates/overlay/overlay.js",
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const actual = pack.files.map((file) => file.path).sort();
const unexpected = actual.filter((path) => !EXPECTED.includes(path));
const missing = EXPECTED.filter((path) => !actual.includes(path));

if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`unexpected in package: ${unexpected.join(", ")}`);
  if (missing.length) console.error(`missing from package: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`package contents OK (${actual.length} files, ${pack.size} bytes packed)`);
