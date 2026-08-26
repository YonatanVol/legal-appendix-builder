'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer gets exactly these calls and nothing else: no Node, no fs, no network.
contextBridge.exposeInMainWorld('api', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  pickBody: () => ipcRenderer.invoke('pick:body'),
  pickAppendixFiles: () => ipcRenderer.invoke('pick:appendix'),
  inspectFiles: (paths) => ipcRenderer.invoke('inspect:files', paths),
  previewLayout: (bodyPages, counts) => ipcRenderer.invoke('layout:preview', bodyPages, counts),
  pickOutput: (defaultName) => ipcRenderer.invoke('pick:output', defaultName),
  build: (spec) => ipcRenderer.invoke('bundle:build', spec),
  openFile: (path) => ipcRenderer.invoke('shell:open', path),
  revealFile: (path) => ipcRenderer.invoke('shell:reveal', path),

  onProgress: (callback) => {
    const listener = (_event, stage) => callback(stage);
    ipcRenderer.on('bundle:progress', listener);
    return () => ipcRenderer.removeListener('bundle:progress', listener);
  },

  // Electron 32+ no longer exposes File.path; this is the supported replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
});
