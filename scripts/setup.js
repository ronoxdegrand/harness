#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const root = path.resolve(__dirname, "..");
const uvVersion = "0.12.5";

function commandSucceeds(command, args, spawnImpl) {
  const result = spawnImpl(command, args, { cwd: root, stdio: "ignore" });
  return !result.error && result.status === 0;
}

function run(command, args, spawnImpl, options = {}) {
  const result = spawnImpl(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status ?? 1}.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function installUv(platform, installDirectory, spawnImpl) {
  const environment = {
    ...process.env,
    UV_UNMANAGED_INSTALL: installDirectory,
  };
  if (platform === "win32") {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `irm https://astral.sh/uv/${uvVersion}/install.ps1 | iex`,
      ],
      spawnImpl,
      { env: environment },
    );
    return;
  }
  run(
    "sh",
    ["-c", `curl -LsSf https://astral.sh/uv/${uvVersion}/install.sh | sh`],
    spawnImpl,
    { env: environment },
  );
}

function setup(options = {}) {
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnSync || childProcess.spawnSync;
  const existsSync = options.existsSync || fs.existsSync;
  const installDirectory = path.join(root, ".tools", "uv");
  const localUv = path.join(installDirectory, platform === "win32" ? "uv.exe" : "uv");
  const uvEnvironment = {
    ...process.env,
    UV_CACHE_DIR: path.join(root, ".tools", "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(root, ".tools", "python"),
  };

  let uv = existsSync(localUv) && commandSucceeds(localUv, ["--version"], spawnImpl)
    ? localUv
    : undefined;
  if (!uv && commandSucceeds("uv", ["--version"], spawnImpl)) uv = "uv";

  if (!uv) {
    console.log(`Installing uv ${uvVersion} locally...`);
    installUv(platform, installDirectory, spawnImpl);
    if (!commandSucceeds(localUv, ["--version"], spawnImpl)) {
      throw new Error(`uv was not installed successfully at ${localUv}.`);
    }
    uv = localUv;
  }

  console.log("Installing Python dependencies from uv.lock...");
  run(
    uv,
    ["sync", "--all-packages", "--all-groups", "--frozen"],
    spawnImpl,
    { env: uvEnvironment },
  );
  return uv;
}

if (require.main === module) {
  try {
    setup();
    console.log("Setup complete. Start the desktop app with: npm start");
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || 1);
  }
}

module.exports = { setup, uvVersion };
