const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__hagemiCall", json => {
  ipcRenderer.send("hagemi:from-pet", json);
});

contextBridge.exposeInMainWorld("__hagemiBridge", {
  onMessage: cb => {
    const handler = (_event, msg) => cb(msg);
    ipcRenderer.on("hagemi:to-pet", handler);
    return () => ipcRenderer.removeListener("hagemi:to-pet", handler);
  }
});
