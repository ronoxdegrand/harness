const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const release = path.join(root, "apps", "desktop", "release");

function find(directory, name) {
  if (!fs.existsSync(directory)) return undefined;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return target;
    if (entry.isDirectory()) {
      const match = find(target, name);
      if (match) return match;
    }
  }
}

async function main() {
  const desktopName =
    process.platform === "win32"
      ? "AI Agent Harness.exe"
      : process.platform === "darwin"
        ? "AI Agent Harness"
        : "ai-agent-harness";
  const desktop = find(release, desktopName);
  if (!desktop) throw new Error(`Packaged Electron executable ${desktopName} was not found.`);
  const desktopData = fs.mkdtempSync(path.join(os.tmpdir(), "harness-desktop-smoke-"));
  const desktopEnvironment = {
    ...process.env,
    HARNESS_DESKTOP_SMOKE_TEST: "1",
    HARNESS_DESKTOP_USER_DATA: desktopData,
  };
  delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
  const electron = spawn(desktop, process.platform === "linux" ? ["--no-sandbox"] : [], {
    env: desktopEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      electron.kill("SIGKILL");
      reject(new Error("Packaged Electron app did not exit after its smoke check."));
    }, 30000);
    electron.once("exit", (code) => {
      clearTimeout(timer);
      const errorPath = path.join(desktopData, "smoke-error.txt");
      code === 0
        ? resolve()
        : reject(
            new Error(
              fs.existsSync(errorPath)
                ? fs.readFileSync(errorPath, "utf8")
                : `Packaged Electron app exited with ${code}.`,
            ),
          );
    });
  });
  if (!fs.existsSync(path.join(desktopData, "harness.db"))) {
    throw new Error("Packaged Electron app did not keep its database under userData.");
  }
  fs.rmSync(desktopData, { recursive: true, force: true });
  console.log("Packaged app smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
