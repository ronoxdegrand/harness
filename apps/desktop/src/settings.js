const fs = require("node:fs");
const path = require("node:path");

function readSettings(file, encryption) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  try {
    return {
      ...settings,
      apiKey: settings.apiKey
        ? encryption.decryptString(Buffer.from(settings.apiKey, "base64"))
        : "",
    };
  } catch {
    return { ...settings, apiKey: "" };
  }
}

function writeSettings(file, settings, encryption) {
  const saved = {
    apiKey: settings.apiKey
      ? encryption.encryptString(settings.apiKey).toString("base64")
      : "",
    maxIterations: settings.maxIterations,
    sendOnEnter: settings.sendOnEnter,
    sidebarWidth: settings.sidebarWidth,
    activityWidth: settings.activityWidth,
    contextWidth: settings.contextWidth,
    scale: settings.scale,
    appearance: settings.appearance,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved));
  fs.renameSync(`${file}.tmp`, file);
}

function getDatabasePath(directory, isPackaged) {
  return path.join(directory, isPackaged ? "harness.db" : "harness-dev.db");
}

module.exports = { getDatabasePath, readSettings, writeSettings };
