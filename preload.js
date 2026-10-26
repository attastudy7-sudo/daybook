'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* the only door between the page and the computer: a handful of narrow calls */
contextBridge.exposeInMainWorld('daybookNative', {
  platform: process.platform,
  loadAll: () => ipcRenderer.sendSync('db:loadAll'),
  save: (out) => ipcRenderer.send('db:save', out),
  saveSync: (out) => ipcRenderer.sendSync('db:saveSync', out),
  putBuf: (id, mime, buf) => ipcRenderer.invoke('media:putBuf', id, mime, buf),
  putPath: (id, mime, p) => ipcRenderer.invoke('media:putPath', id, mime, p),
  delMedia: (id) => ipcRenderer.send('media:del', id),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
