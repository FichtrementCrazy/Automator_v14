const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('blockflow', {
  runWorkflow: blocks => ipcRenderer.invoke('run-workflow', blocks),
  stopWorkflow: () => ipcRenderer.invoke('stop-workflow'),
  saveWorkflow: data => ipcRenderer.invoke('save-workflow', data),
  exportRunnable: data => ipcRenderer.invoke('export-runnable', data),
  createDesktopShortcut: target => ipcRenderer.invoke('create-desktop-shortcut', target),
  openWorkflow: () => ipcRenderer.invoke('open-workflow'),
  browseProgram: () => ipcRenderer.invoke('browse-program'),
  getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),
  startMouseCapture: () => ipcRenderer.invoke('start-mouse-capture'),
  stopMouseCapture: () => ipcRenderer.invoke('stop-mouse-capture'),
  platform: () => ipcRenderer.invoke('platform'),
  onRunnerEvent: cb => ipcRenderer.on('runner-event', (_e, data) => cb(data)),
});
