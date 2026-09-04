const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session } = require("electron");
const { autoUpdater } = require("electron-updater");

const { startBackend, stopBackend } = require("./backend");
const { getDatabasePath, readSettings, writeSettings } = require("./settings");

let backend;
let mainWindow;
let workspaceRoot;
let quitting = false;
let updateVersion;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

function normalizeScale(scale) {
  return Math.min(Math.max(Math.round((Number(scale) || 1) * 10) / 10, MIN_SCALE), MAX_SCALE);
}

function normalizeAppearance(appearance) {
  return appearance === "dark" || appearance === "system" ? appearance : "light";
}

function titleBarOverlayHeight(scale) {
  return Math.max(Math.round(56 * scale) - 1, 28);
}

function updateWindowChrome(scale) {
  const headerHeight = titleBarOverlayHeight(scale);
  if (process.platform === "darwin") {
    mainWindow.setWindowButtonPosition({
      x: 16,
      y: Math.max(Math.round(28 * scale - 7), 4),
    });
  } else {
    const dark = nativeTheme.shouldUseDarkColors;
    mainWindow.setTitleBarOverlay({
      color: dark ? "#1b1c1a" : "#fafaf7",
      symbolColor: dark ? "#ecece7" : "#1b1b1a",
      height: headerHeight,
    });
  }
}

function setAppearance(appearance) {
  nativeTheme.themeSource = normalizeAppearance(appearance);
  updateWindowChrome(mainWindow.webContents.getZoomFactor());
  return nativeTheme.themeSource;
}

function setScale(scale) {
  const normalized = normalizeScale(scale);
  mainWindow.webContents.setZoomFactor(normalized);
  updateWindowChrome(normalized);
  mainWindow.webContents.send("desktop:scale-changed", normalized);
  return normalized;
}

const smokeTest =
  process.env.HARNESS_DESKTOP_SMOKE_TEST === "1" || process.argv.includes("--harness-smoke-test");
const userDataArgument = process.argv.find((argument) => argument.startsWith("--harness-user-data="));
const desktopUserData =
  process.env.HARNESS_DESKTOP_USER_DATA || userDataArgument?.slice("--harness-user-data=".length);
if (desktopUserData) app.setPath("userData", desktopUserData);
else if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "AI Agent Harness Dev"));

const settingsPath = path.join(app.getPath("userData"), "settings.json");
fs.mkdirSync(app.getPath("userData"), { recursive: true });

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
  const settings = readSettings(settingsPath, safeStorage);
  const scale = normalizeScale(settings.scale);
  nativeTheme.themeSource = normalizeAppearance(settings.appearance);
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: app.isPackaged ? undefined : path.join(__dirname, "../assets/icon.png"),
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 20 } }
      : {
          titleBarOverlay: {
            color: dark ? "#1b1c1a" : "#fafaf7",
            symbolColor: dark ? "#ecece7" : "#1b1b1a",
            height: titleBarOverlayHeight(scale),
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: scale,
    },
  });
  mainWindow.webContents.setZoomFactor(scale);
  updateWindowChrome(scale);
  mainWindow.webContents.once("did-finish-load", () => updateWindowChrome(scale));
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) updateWindowChrome(mainWindow.webContents.getZoomFactor());
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
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock.setIcon(path.join(__dirname, "../assets/icon.png"));
  }
  const root = app.isPackaged ? undefined : path.resolve(__dirname, "../../..");
  const executable = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "backend",
        process.platform === "win32" ? "agent-harness-api.exe" : "agent-harness-api",
      )
    : path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const token = randomBytes(32).toString("hex");
  workspaceRoot = process.env.HARNESS_WORKSPACE_ROOT || root || process.cwd();
  const webPath = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(root, "apps", "web", "dist");
  const environment = {
    ...process.env,
    HARNESS_APP_ENV: app.isPackaged ? "production" : "development",
    HARNESS_APP_VERSION: app.getVersion(),
    HARNESS_AUTH_TOKEN: token,
    HARNESS_ALLOW_ABSOLUTE_WORKSPACES: "true",
    HARNESS_HOST: "127.0.0.1",
    HARNESS_PORT: "0",
    HARNESS_SQLITE_PATH: getDatabasePath(app.getPath("userData"), app.isPackaged),
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
ipcMain.handle("desktop:get-version", () => app.getVersion());
ipcMain.handle("desktop:get-settings", () => readSettings(settingsPath, safeStorage));
ipcMain.handle("desktop:set-settings", (_event, settings) => {
  writeSettings(settingsPath, settings, safeStorage);
});
ipcMain.handle("desktop:set-scale", (_event, scale) => setScale(scale));
ipcMain.handle("desktop:set-appearance", (_event, appearance) => setAppearance(appearance));
ipcMain.handle("desktop:select-repository", async (_event, currentPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select repository",
    buttonLabel: "Select repository",
    defaultPath: typeof currentPath === "string" && path.isAbsolute(currentPath)
      ? currentPath
      : workspaceRoot,
    properties: ["openDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});
