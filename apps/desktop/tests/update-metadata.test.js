const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("update metadata references the uploaded artifact name", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-update-"));
  const artifact = "AI Agent Harness-1.2.3-win-x64.exe";
  try {
    fs.writeFileSync(path.join(directory, artifact), "installer");
    execFileSync(process.execPath, [
      path.resolve(__dirname, "../../../scripts/generate-update-metadata.js"),
      directory,
      "1.2.3",
    ]);
    assert.match(fs.readFileSync(path.join(directory, "latest.yml"), "utf8"), new RegExp(artifact));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged artifact names are safe for GitHub release uploads", () => {
  const config = fs.readFileSync(path.resolve(__dirname, "../electron-builder.yml"), "utf8");
  assert.match(config, /^artifactName: [a-z0-9${}._-]+$/m);
});
