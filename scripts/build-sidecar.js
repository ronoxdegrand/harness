const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const result = spawnSync(
  python,
  [
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name",
    "agent-harness-api",
    "--paths",
    path.join(root, "apps", "api", "src"),
    "--collect-all",
    "uvicorn",
    "--distpath",
    path.join(root, "apps", "desktop", "resources", "backend"),
    "--workpath",
    path.join(root, ".tmp", "pyinstaller"),
    "--specpath",
    path.join(root, ".tmp"),
    path.join(root, "apps", "api", "src", "agent_harness_api", "launcher.py"),
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
