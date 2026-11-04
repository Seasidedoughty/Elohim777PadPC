const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pad", {
  sendFrame: (frame) => ipcRenderer.send("pad-frame", frame),
  getProfile: () => ipcRenderer.invoke("profile-get"),
  saveProfile: (profile) => ipcRenderer.invoke("profile-set", profile),
  bluetooth: () => ipcRenderer.invoke("bluetooth-info"),
  openBluetooth: () => ipcRenderer.invoke("open-bluetooth"),
  elevate: () => ipcRenderer.invoke("elevate"),
  isAdmin: () => ipcRenderer.invoke("is-admin"),
});
