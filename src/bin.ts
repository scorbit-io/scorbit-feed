import { main } from "./cli.js";

void main(process.argv.slice(2), {
  env: process.env,
  log: (line) => process.stderr.write(`[scorbit-feed] ${new Date().toISOString()} ${line}\n`),
  exit: (code) => process.exit(code),
  signals: process,
});
