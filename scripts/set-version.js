const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const version = process.argv[2];

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version || "")) {
  throw new Error("Usage: npm run version:set -- <semver>");
}
if (!process.env.npm_execpath) throw new Error("Run this script through npm.");

for (const file of ["package.json", "apps/desktop/package.json", "apps/web/package.json"]) {
  const target = path.join(root, file);
  const contents = JSON.parse(fs.readFileSync(target, "utf8"));
  contents.version = version;
  fs.writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`);
}

for (const [file, pattern] of [
  ["pyproject.toml", /^(version = ")[^"]+("$)/m],
  ["apps/api/pyproject.toml", /^(version = ")[^"]+("$)/m],
  ["apps/api/src/agent_harness_api/__init__.py", /^(__version__ = ")[^"]+("$)/m],
  ["apps/api/src/agent_harness_api/config.py", /^(    app_version: str = ")[^"]+("$)/m],
]) {
  const target = path.join(root, file);
  const contents = fs.readFileSync(target, "utf8");
  if (!pattern.test(contents)) throw new Error(`Version declaration not found in ${file}.`);
  fs.writeFileSync(target, contents.replace(pattern, (_, start, end) => `${start}${version}${end}`));
}

execFileSync(process.execPath, [process.env.npm_execpath, "install", "--package-lock-only", "--ignore-scripts"], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("uv", ["lock"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(__dirname, "check-versions.js")], {
  cwd: root,
  stdio: "inherit",
});
