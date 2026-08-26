#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const python = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);

if (!fs.existsSync(python)) {
  console.error(`Python venv not found at: ${python}\nRun "npm run setup" first.`);
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), {
  cwd: root,
  stdio: "inherit",
});
if (result.error) console.error(`Could not run the repository Python: ${result.error.message}`);
process.exit(result.status ?? 1);
