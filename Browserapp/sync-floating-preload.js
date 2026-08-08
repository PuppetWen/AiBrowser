const { contextBridge, ipcRenderer } = require(Buffer.from('ZWxlY3Ryb24=', 'base64').toString('utf8'));

contextBridge.exposeInMainWorld('syncFloat', Object.freeze({
  snapshot: () => ipcRenderer.invoke('sync-floating:snapshot'),
  select: (payload) => ipcRenderer.invoke('sync-floating:selection', payload || {}),
  apply: (payload) => ipcRenderer.invoke('sync-floating:apply', payload || {}),
  stop: () => ipcRenderer.invoke('sync-floating:stop'),
  restart: () => ipcRenderer.invoke('sync-floating:restart'),
  windowAction: (ids, action, layout = null) => ipcRenderer.invoke('sync-floating:window', { ids, action, layout }),
  textAction: (ids, action, text, delayMin = 0, delayMax = 0) => ipcRenderer.invoke('sync-floating:text', { ids, action, text, delayMin, delayMax }),
  batchTextAction: (ids, texts, delayMin = 0, delayMax = 0) => ipcRenderer.invoke('sync-floating:text-batch', { ids, texts, delayMin, delayMax }),
  setSettings: (settings) => ipcRenderer.invoke('sync-floating:settings', settings || {}),
  tabAction: (ids, action, payload) => ipcRenderer.invoke('sync-floating:tabs', { ids, action, payload: payload || {} }),
  openManager: (openSettings = false) => ipcRenderer.invoke('sync-floating:open-manager', { openSettings: Boolean(openSettings) }),
  hide: () => ipcRenderer.invoke('sync-floating:hide'),
  setExpanded: (expanded) => ipcRenderer.invoke('sync-floating:set-expanded', Boolean(expanded)),
  onEvent: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('sync-floating:event', handler);
    return () => ipcRenderer.removeListener('sync-floating:event', handler);
  },
  onTheme: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('sync-floating:theme', handler);
    return () => ipcRenderer.removeListener('sync-floating:theme', handler);
  },
}));
