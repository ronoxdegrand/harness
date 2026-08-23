const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harnessDesktop", {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
  onUpdateReady(callback) {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on("desktop:update-ready", listener);
    return () => ipcRenderer.removeListener("desktop:update-ready", listener);
  },
  getUpdateReady: () => ipcRenderer.invoke("desktop:get-update"),
  restartToUpdate: () => ipcRenderer.invoke("desktop:restart-to-update"),
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  setSettings: (settings) => ipcRenderer.invoke("desktop:set-settings", settings),
  setScale: (scale) => ipcRenderer.invoke("desktop:set-scale", scale),
  setAppearance: (appearance) => ipcRenderer.invoke("desktop:set-appearance", appearance),
  selectRepository: (currentPath) => ipcRenderer.invoke("desktop:select-repository", currentPath),
  onScaleChanged(callback) {
    const listener = (_event, scale) => callback(scale);
    ipcRenderer.on("desktop:scale-changed", listener);
    return () => ipcRenderer.removeListener("desktop:scale-changed", listener);
  },
});
