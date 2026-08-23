const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getDatabasePath, readSettings, writeSettings } = require("../src/settings");

test("development and installed apps use different databases", () => {
  const directory = path.join(os.tmpdir(), "harness-data");
  assert.equal(getDatabasePath(directory, false), path.join(directory, "harness-dev.db"));
  assert.equal(getDatabasePath(directory, true), path.join(directory, "harness.db"));
});

test("desktop settings persist with an encrypted API key", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-settings-"));
  const file = path.join(directory, "settings.json");
  const encryption = {
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice("encrypted:".length),
  };
  const settings = {
    apiKey: "secret",
    maxIterations: 12,
    sendOnEnter: false,
    sidebarWidth: 300,
    activityWidth: 400,
    contextWidth: 350,
    scale: 0.9,
    appearance: "dark",
  };
  try {
    writeSettings(file, settings, encryption);
    assert.equal(fs.readFileSync(file, "utf8").includes("secret"), false);
    assert.deepEqual(readSettings(file, encryption), settings);
    writeSettings(file, { ...settings, maxIterations: 20 }, encryption);
    assert.equal(readSettings(file, encryption).maxIterations, 20);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable API key does not discard other settings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-settings-"));
  const file = path.join(directory, "settings.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ apiKey: "invalid", maxIterations: 12 }));
    assert.deepEqual(
      readSettings(file, { decryptString: () => { throw new Error("unavailable"); } }),
      { apiKey: "", maxIterations: 12 },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
