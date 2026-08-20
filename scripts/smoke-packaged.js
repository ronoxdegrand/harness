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
    if (entry.name === name) return target;
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
        ? "AI Agent Harness.app"
        : "ai-agent-harness";
  const desktop = find(release, desktopName);
  if (!desktop) throw new Error(`Packaged Electron app ${desktopName} was not found.`);
  const desktopData = fs.mkdtempSync(path.join(os.tmpdir(), "harness-desktop-smoke-"));
  const desktopEnvironment = {
    ...process.env,
    HARNESS_DESKTOP_SMOKE_TEST: "1",
    HARNESS_DESKTOP_USER_DATA: desktopData,
  };
  delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
  const electron = spawn(
    process.platform === "darwin" ? "/usr/bin/open" : desktop,
    process.platform === "darwin"
      ? ["-W", "-n", desktop, "--args", "--harness-smoke-test", `--harness-user-data=${desktopData}`]
      : process.platform === "linux"
        ? ["--no-sandbox"]
        : [],
    {
      env: desktopEnvironment,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const errorPath = path.join(desktopData, "smoke-error.txt");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pidPath = path.join(desktopData, "smoke-pid.txt");
      if (process.platform === "darwin" && fs.existsSync(pidPath)) {
        try {
          process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL");
        } catch {
          // The app may have exited between the PID check and the signal.
        }
      }
      electron.kill("SIGKILL");
      reject(new Error("Packaged Electron app did not exit after its smoke check."));
    }, 60000);
    electron.once("exit", (code) => {
      clearTimeout(timer);
      if (fs.existsSync(errorPath)) reject(new Error(fs.readFileSync(errorPath, "utf8")));
      else if (code === 0) resolve();
      else reject(new Error(`Packaged Electron app exited with ${code}.`));
    });
  });
  if (!fs.existsSync(path.join(desktopData, "smoke-success.txt"))) {
    throw new Error("Packaged Electron app exited without completing its smoke check.");
  }
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
