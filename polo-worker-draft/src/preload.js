const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poloWorker', {
  appMeta: () => ipcRenderer.invoke('app:meta'),
  authGetSaved: () => ipcRenderer.invoke('auth:getSaved'),
  authLogin: (payload) => ipcRenderer.invoke('auth:login', payload),
  appStatus: () => ipcRenderer.invoke('app:status'),
  appLogout: () => ipcRenderer.invoke('app:logout'),
  serialList: () => ipcRenderer.invoke('serial:list'),
  modemRows: () => ipcRenderer.invoke('partner:modems'),
  chipHistory: (porta) => ipcRenderer.invoke('partner:chipHistory', { porta }),
  ccidImportTxt: (rawText) => ipcRenderer.invoke('ccid:importTxt', { rawText }),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesOpenDownload: (url) => ipcRenderer.invoke('updates:openDownload', url)
});
