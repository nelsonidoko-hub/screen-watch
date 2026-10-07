const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenwatch', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  setControlEnabled: (enabled) => ipcRenderer.invoke('set-control-enabled', enabled),
  injectInput: (input) => ipcRenderer.invoke('inject-input', input),
  takePendingInvite: () => ipcRenderer.invoke('take-pending-invite'),
  onInvite: (callback) => ipcRenderer.on('invite', (event, invite) => callback(invite)),
});
