const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sgg', {
  version: (() => { try { return require('electron').ipcRenderer.sendSync('get-version'); } catch(e) { return '1.13.0'; } })(),
  runBacktag:    (pdfPath)  => ipcRenderer.invoke('run-backtag', pdfPath),
  parsePayable:  (pdfPath)  => ipcRenderer.invoke('parse-payable', pdfPath),
  showInFinder:  (filePath) => ipcRenderer.invoke('show-in-finder', filePath),
  generateCR:    (payload)  => ipcRenderer.invoke('generate-cr', payload),
});
