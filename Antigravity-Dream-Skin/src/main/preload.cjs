const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dreamApi", {
  get: () => ipcRenderer.invoke("dream:get"),
  save: v => ipcRenderer.invoke("dream:save", v),
  refresh: () => ipcRenderer.invoke("dream:refresh"),
  pickWallpaper: () => ipcRenderer.invoke("dream:pick-wallpaper"),
  resetWallpaper: () => ipcRenderer.invoke("dream:reset-wallpaper"),
  getSuiteStatus: () => ipcRenderer.invoke("suite:status"),
  runLocalization: action => ipcRenderer.invoke("suite:localize", action),
  runHagemi: action => ipcRenderer.invoke("suite:hagemi", action),
  launchHagemi: () => ipcRenderer.invoke("suite:launch-hagemi"),
  launchWidget: () => ipcRenderer.invoke("suite:launch-widget"),
  connectHost: () => ipcRenderer.invoke("suite:connect-host"),
  quit: () => ipcRenderer.send("dream:quit"),
  subscribe: cb => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on("dream:state", h);
    return () => ipcRenderer.removeListener("dream:state", h);
  }
});
