const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const { autoUpdater } = require("electron-updater");

const { startBackend, stopBackend } = require("./backend");

let backend;
let mainWindow;
let quitting = false;
let updateVersion;

const smokeTest =
  process.env.HARNESS_DESKTOP_SMOKE_TEST === "1" || process.argv.includes("--harness-smoke-test");
const userDataArgument = process.argv.find((argument) => argument.startsWith("--harness-user-data="));
const desktopUserData =
  process.env.HARNESS_DESKTOP_USER_DATA || userDataArgument?.slice("--harness-user-data=".length);
if (desktopUserData) app.setPath("userData", desktopUserData);

function reportSmoke(stage) {
  if (!smokeTest) return;
  console.log(`Packaged smoke: ${stage}.`);
  fs.writeFileSync(path.join(app.getPath("userData"), "smoke-stage.txt"), stage);
}

if (smokeTest) {
  fs.writeFileSync(path.join(app.getPath("userData"), "smoke-pid.txt"), String(process.pid));
  reportSmoke("main loaded");
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  let timeout;
  try {
    await Promise.race([
      mainWindow.loadURL(backend.baseUrl),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Renderer did not load in time.")), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function start() {
  const root = app.isPackaged ? undefined : path.resolve(__dirname, "../../..");
  const executable = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "backend",
        process.platform === "win32" ? "agent-harness-api.exe" : "agent-harness-api",
      )
    : path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const token = randomBytes(32).toString("hex");
  const workspaceRoot = process.env.HARNESS_WORKSPACE_ROOT || root || process.cwd();
  const webPath = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(root, "apps", "web", "dist");
  const environment = {
    ...process.env,
    HARNESS_APP_ENV: "production",
    HARNESS_APP_VERSION: app.getVersion(),
    HARNESS_AUTH_TOKEN: token,
    HARNESS_HOST: "127.0.0.1",
    HARNESS_PORT: "0",
    HARNESS_SQLITE_PATH: path.join(app.getPath("userData"), "harness.db"),
    HARNESS_WEB_DIST_PATH: webPath,
    HARNESS_WORKSPACE_ROOT: workspaceRoot,
  };
  if (root) environment.PYTHONPATH = path.join(root, "apps", "api", "src");
  backend = await startBackend({
    executable,
    args: root ? ["-m", "agent_harness_api.launcher"] : undefined,
    token,
    version: app.getVersion(),
    cwd: root,
    env: environment,
  });
  reportSmoke("backend ready");
  backend.child.once("exit", (code) => {
    if (!quitting) {
      dialog.showErrorBox("Backend stopped unexpectedly", `The backend exited with code ${code}.`);
      app.quit();
    }
  });

  const backendOrigin = new URL(backend.baseUrl);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestUrl = new URL(details.url);
    if (requestUrl.hostname === backendOrigin.hostname && requestUrl.port === backendOrigin.port) {
      details.requestHeaders.Authorization = `Bearer ${token}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  await createWindow();

  if (smokeTest) {
    reportSmoke("renderer ready");
    const loaded = await mainWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts.load('16px "Inter Variable"'),
        document.fonts.load('16px "JetBrains Mono Variable"'),
      ]).then(([sans, mono]) =>
        Boolean(document.getElementById("root")) && sans.length > 0 && mono.length > 0
      )
    `);
    if (!loaded) throw new Error("Desktop renderer did not load.");
    const reportedWorkspace = await mainWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const socket = new WebSocket("ws://" + window.location.host + "/ws/run");
        const timer = setTimeout(() => reject(new Error("WebSocket readiness timed out.")), 5000);
        socket.onerror = () => reject(new Error("WebSocket connection failed."));
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.kind === "session.ready") {
            clearTimeout(timer);
            socket.close();
            resolve(message.payload.workspace_root);
          }
        };
      })
    `);
    if (path.resolve(reportedWorkspace) !== path.resolve(workspaceRoot)) {
      throw new Error("Desktop backend used the wrong workspace root.");
    }
    reportSmoke("workspace verified");
    await shutdownBackend();
    reportSmoke("backend stopped");
    fs.writeFileSync(path.join(app.getPath("userData"), "smoke-success.txt"), "ok");
    process.exit(0);
    return;
  }

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => {
      updateVersion = info.version;
      mainWindow?.webContents.send("desktop:update-ready", info.version);
    });
    autoUpdater.checkForUpdates().catch((error) => console.error("Update check failed:", error));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start).catch(async (error) => {
    if (smokeTest) {
      reportSmoke("failed");
      fs.writeFileSync(path.join(app.getPath("userData"), "smoke-error.txt"), error.stack || String(error));
      await shutdownBackend().catch(() => {});
      process.exit(1);
      return;
    }
    dialog.showErrorBox("AI Agent Harness could not start", error.stack || String(error));
    app.quit();
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backend) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function shutdownBackend() {
  quitting = true;
  await stopBackend(backend);
  backend = undefined;
}

app.on("before-quit", (event) => {
  if (!backend || quitting) return;
  event.preventDefault();
  shutdownBackend().finally(() => app.quit());
});

ipcMain.handle("desktop:restart-to-update", async () => {
  if (!app.isPackaged) return;
  await shutdownBackend();
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("desktop:get-update", () => updateVersion);
