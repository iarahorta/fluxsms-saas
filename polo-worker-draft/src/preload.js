const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poloWorker', {
  appMeta: () => ipcRenderer.invoke('app:meta'),
  authGetSaved: () => ipcRenderer.invoke('auth:getSaved'),
  authLogin: (payload) => ipcRenderer.invoke('auth:login', payload),
  appStatus: () => ipcRenderer.invoke('app:status'),
  appLogout: () => ipcRenderer.invoke('app:logout'),
  serialList: () => ipcRenderer.invoke('serial:list'),
  modemRows: () => ipcRenderer.invoke('partner:modems'),
  forceRescan: () => ipcRenderer.invoke('partner:rescan'),
  chipHistory: (porta) => ipcRenderer.invoke('partner:chipHistory', { porta }),
  ccidImportTxt: (rawText) => ipcRenderer.invoke('ccid:importTxt', { rawText }),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesOpenDownload: (url) => ipcRenderer.invoke('updates:openDownload', url),
  onRuntimeRowsUpdated: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('partner:runtime-rows-updated', () => {
      try {
        cb();
      } catch {
        /* */
      }
    });
  }
});
