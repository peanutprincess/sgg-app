const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sgg', {
  version: '1.0.0',
  runBacktag:   (pdfPath) => ipcRenderer.invoke('run-backtag', pdfPath),
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),
});
