const { execFileSync, spawn } = require("node:child_process");
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
      ? ["-n", desktop, "--args", "--harness-smoke-test", `--harness-user-data=${desktopData}`]
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
  const successPath = path.join(desktopData, "smoke-success.txt");
  const pidPath = path.join(desktopData, "smoke-pid.txt");
  const stagePath = path.join(desktopData, "smoke-stage.txt");
  await new Promise((resolve, reject) => {
    let timer;
    let interval;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      error ? reject(error) : resolve();
    };
    interval = setInterval(() => {
      if (fs.existsSync(errorPath)) finish(new Error(fs.readFileSync(errorPath, "utf8")));
      else if (process.platform === "darwin" && fs.existsSync(successPath)) finish();
    }, 100);
    timer = setTimeout(() => {
      const stage = fs.existsSync(stagePath) ? fs.readFileSync(stagePath, "utf8") : "not started";
      let processInfo = "PID not reported";
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, "utf8"));
        try {
          processInfo = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,state=,command="], {
            encoding: "utf8",
          }).trim();
        } catch {
          processInfo = `PID ${pid} is not running`;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The app may have exited between the PID check and the signal.
        }
      }
      electron.kill("SIGKILL");
      const files = fs.readdirSync(desktopData).join(", ") || "none";
      finish(
        new Error(
          `Packaged Electron smoke timed out. Stage: ${stage}. Process: ${processInfo}. Files: ${files}.`,
        ),
      );
    }, 60000);
    electron.once("exit", (code) => {
      if (fs.existsSync(errorPath)) finish(new Error(fs.readFileSync(errorPath, "utf8")));
      else if (code !== 0) finish(new Error(`Packaged Electron launcher exited with ${code}.`));
      else if (process.platform !== "darwin") {
        finish(
          fs.existsSync(successPath)
            ? undefined
            : new Error("Packaged Electron app exited without completing its smoke check."),
        );
      }
    });
  });
  if (!fs.existsSync(path.join(desktopData, "harness.db"))) {
    throw new Error("Packaged Electron app did not keep its database under userData.");
  }
  fs.rmSync(desktopData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log("Packaged app smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
