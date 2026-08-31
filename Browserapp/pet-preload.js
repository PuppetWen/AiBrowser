'use strict';

const { contextBridge, ipcRenderer } = require(Buffer.from('ZWxlY3Ryb24=', 'base64').toString('utf8'));

contextBridge.exposeInMainWorld('desktopPet', Object.freeze({
  snapshot: () => ipcRenderer.invoke('pet:snapshot'),
  beginDrag: (point) => ipcRenderer.invoke('pet:drag-start', point || {}),
  drag: (point) => ipcRenderer.send('pet:drag', point || {}),
  endDrag: () => ipcRenderer.invoke('pet:drag-end'),
  scale: (deltaY) => ipcRenderer.invoke('pet:scale', Number(deltaY) || 0),
  rendererState: (state) => ipcRenderer.send('pet:renderer-state', state || {}),
  onEvent: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('pet:event', handler);
    return () => ipcRenderer.removeListener('pet:event', handler);
  },
}));
