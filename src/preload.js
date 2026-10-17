'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer gets exactly these calls and nothing else: no Node, no fs, no network.
contextBridge.exposeInMainWorld('api', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  pickBody: () => ipcRenderer.invoke('pick:body'),
  pickAppendixFiles: () => ipcRenderer.invoke('pick:appendix'),
  inspectFiles: (paths) => ipcRenderer.invoke('inspect:files', paths),
  locateFile: (missingName) => ipcRenderer.invoke('pick:locate', missingName),
  previewLayout: (bodyPages, counts) => ipcRenderer.invoke('layout:preview', bodyPages, counts),
  pickOutput: (defaultName) => ipcRenderer.invoke('pick:output', defaultName),
  build: (spec) => ipcRenderer.invoke('bundle:build', spec),
  openFile: (path) => ipcRenderer.invoke('shell:open', path),

  historyList: () => ipcRenderer.invoke('history:list'),
  historyRestore: (id) => ipcRenderer.invoke('history:restore', id),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', id),
  revealFile: (path) => ipcRenderer.invoke('shell:reveal', path),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  onProgress: (callback) => {
    const listener = (_event, stage) => callback(stage);
    ipcRenderer.on('bundle:progress', listener);
    return () => ipcRenderer.removeListener('bundle:progress', listener);
  },

  // The tool grid.
  listTools: () => ipcRenderer.invoke('tools:list'),
  describeFiles: (paths) => ipcRenderer.invoke('files:describe', paths),
  pickFiles: (spec) => ipcRenderer.invoke('files:pick', spec),
  pickFolder: (spec) => ipcRenderer.invoke('folder:pick', spec),
  startJob: (spec) => ipcRenderer.invoke('job:start', spec),
  cancelJob: (id) => ipcRenderer.invoke('job:cancel', id),
  onJobProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
  onJobStarted: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('job:started', listener);
    return () => ipcRenderer.removeListener('job:started', listener);
  },
  scanAvailable: () => ipcRenderer.invoke('scan:available'),
  scanAcquire: (spec) => ipcRenderer.invoke('scan:acquire', spec),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),
  onScanPage: (callback) => {
    const listener = (_event, n) => callback(n);
    ipcRenderer.on('scan:page', listener);
    return () => ipcRenderer.removeListener('scan:page', listener);
  },
  workflowsSave: (spec) => ipcRenderer.invoke('workflows:save', spec),
  workflowsRemove: (id) => ipcRenderer.invoke('workflows:remove', id),
  workflowsSteps: () => ipcRenderer.invoke('workflows:steps'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSetKey: (key) => ipcRenderer.invoke('settings:setKey', key),
  settingsClearKey: () => ipcRenderer.invoke('settings:clearKey'),
  signaturesList: () => ipcRenderer.invoke('signatures:list'),
  signaturesSave: (spec) => ipcRenderer.invoke('signatures:save', spec),
  signaturesRemove: (id) => ipcRenderer.invoke('signatures:remove', id),
  formsRead: (path) => ipcRenderer.invoke('forms:read', path),
  runsList: () => ipcRenderer.invoke('runs:list'),
  runsRemove: (id) => ipcRenderer.invoke('runs:remove', id),
  recentFiles: () => ipcRenderer.invoke('runs:recent'),

  // Electron 32+ no longer exposes File.path; this is the supported replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
});
