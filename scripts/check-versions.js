const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const rootVersion = require(path.join(root, "package.json")).version;
const desktopVersion = require(path.join(root, "apps", "desktop", "package.json")).version;
const apiProject = fs.readFileSync(path.join(root, "apps", "api", "pyproject.toml"), "utf8");
const apiVersion = apiProject.match(/^version = "([^"]+)"/m)?.[1];
const pythonVersion = fs
  .readFileSync(path.join(root, "apps", "api", "src", "agent_harness_api", "__init__.py"), "utf8")
  .match(/^__version__ = "([^"]+)"/m)?.[1];

if (new Set([rootVersion, desktopVersion, apiVersion, pythonVersion]).size !== 1) {
  throw new Error(
    `Version mismatch: root=${rootVersion}, desktop=${desktopVersion}, api=${apiVersion}, python=${pythonVersion}`,
  );
}
if (process.env.VERSION_TAG && process.env.VERSION_TAG.replace(/^v/, "") !== rootVersion) {
  throw new Error(`Tag ${process.env.VERSION_TAG} does not match app version ${rootVersion}.`);
}
console.log(`Atomic app version: ${rootVersion}`);
