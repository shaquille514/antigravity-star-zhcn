const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widgetApi", {
  get: () => ipcRenderer.invoke("widget:get"),
  save: v => ipcRenderer.invoke("widget:settings", v),
  command: v => ipcRenderer.send("widget:command", v),
  pointer: v => ipcRenderer.invoke("widget:pointer", v),
  hit: v => ipcRenderer.send("widget:hit", v),
  audio: v => ipcRenderer.invoke("widget:audio", v),
  chatSend: prompt => ipcRenderer.invoke("widget:chat-send", prompt),
  chatStop: () => ipcRenderer.invoke("widget:chat-stop"),
  chatReset: () => ipcRenderer.invoke("widget:chat-reset"),
  subscribe: callback => {
    const h = (_e, data) => callback(data);
    ipcRenderer.on("widget:snapshot", h);
    return () => ipcRenderer.removeListener("widget:snapshot", h);
  },
  onStep: callback => {
    const h = (_e, data) => callback(data);
    ipcRenderer.on("widget:step", h);
    return () => ipcRenderer.removeListener("widget:step", h);
  },
  onReaction: callback => {
    const h = () => callback();
    ipcRenderer.on("widget:reaction", h);
    return () => ipcRenderer.removeListener("widget:reaction", h);
  },
  onOpenChat: callback => {
    const h = () => callback();
    ipcRenderer.on("widget:open-chat", h);
    return () => ipcRenderer.removeListener("widget:open-chat", h);
  },
  onChatEvent: callback => {
    const h = (_e, data) => callback(data);
    ipcRenderer.on("widget:chat-event", h);
    return () => ipcRenderer.removeListener("widget:chat-event", h);
  }
});
