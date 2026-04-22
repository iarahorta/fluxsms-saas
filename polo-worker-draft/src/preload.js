const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poloWorker', {
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  serialList: () => ipcRenderer.invoke('serial:list'),
  registerChip: (body) => ipcRenderer.invoke('partner:registerChip', body),
  heartbeat: () => ipcRenderer.invoke('partner:heartbeat'),
  pendingActivations: () => ipcRenderer.invoke('partner:pendingActivations'),
  deliverSms: (body) => ipcRenderer.invoke('hardware:deliverSms', body)
});
