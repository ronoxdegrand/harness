const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harnessDesktop", {
  platform: process.platform,
  onUpdateReady(callback) {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on("desktop:update-ready", listener);
    return () => ipcRenderer.removeListener("desktop:update-ready", listener);
  },
  getUpdateReady: () => ipcRenderer.invoke("desktop:get-update"),
  restartToUpdate: () => ipcRenderer.invoke("desktop:restart-to-update"),
});
