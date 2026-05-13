const { app, BrowserWindow, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

app.name = 'SG';

function createWindow() {
  // Set dock icon from SVG logo
  if (process.platform === 'darwin') {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/logo.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch(e) {}
  }

  const win = new BrowserWindow({
    title: 'SG',
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    backgroundColor: '#fafafa',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('renderer/index.html');

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Back Tag Generator IPC ──

// Render all SVG sheets as a single multi-page PDF — no external tools needed
function svgSheetsToPdf(svgPaths) {
  const fs  = require('fs');
  const os  = require('os');

  // Build one HTML document with all sheets separated by CSS page breaks
  const pages = svgPaths.map(p => {
    const svg = fs.readFileSync(p, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '');
    return `<div class="page">${svg}</div>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 612pt 792pt; margin: 0; }
    * { margin: 0; padding: 0; }
    .page { width: 612pt; height: 792pt; overflow: hidden; background: #fff;
            page-break-after: always; }
    .page:last-child { page-break-after: avoid; }
    svg { display: block; width: 612pt; height: 792pt; }
  </style></head><body>${pages}</body></html>`;

  const tmpHtml = path.join(os.tmpdir(), `_bt_all_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false, frame: false,
      width: 816, height: 1056,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    win.loadFile(tmpHtml);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const pdfBuf = await win.webContents.printToPDF({
            pageSize: { width: 215900, height: 279400 },
            preferCSSPageSize: true,
            margins: { marginType: 'none' },
            printBackground: true,
            landscape: false,
            scaleFactor: 100
          });
          win.destroy();
          try { fs.unlinkSync(tmpHtml); } catch {}
          resolve(pdfBuf);
        } catch (e) { win.destroy(); reject(e); }
      }, 1200);  // slightly longer delay for multi-page render
    });
    win.webContents.once('did-fail-load', (_, code, desc) => {
      win.destroy();
      reject(new Error(`Page load failed: ${desc}`));
    });
  });
}

ipcMain.handle('run-backtag', async (event, pdfPath) => {
  const fs = require('fs');

  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'backtag_gen.py')
    : path.join(__dirname, 'assets', 'backtag_gen.py');

  const pythonPaths = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3'];
  const pythonBin = pythonPaths.find(p => {
    try { fs.accessSync(p); return true; } catch { return false; }
  }) || 'python3';

  const env = Object.assign({}, process.env, {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '')
  });

  // Step 1: Run Python — generates per-sheet SVG files, prints "SVG:/path" per sheet
  const svgPaths = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(pythonBin, [scriptPath, pdfPath], { env });
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || stdout || `Python exited with code ${code}`));
      const paths = stdout.split('\n')
        .filter(l => l.startsWith('SVG:'))
        .map(l => l.slice(4).trim())
        .filter(Boolean);
      resolve(paths);
    });
    proc.on('error', err => reject(new Error(`Could not start python3: ${err.message}`)));
  });

  if (!svgPaths.length) throw new Error('No artworks found in this PDF — check that it has extractable text.');

  // Step 2: Render all sheets into one multi-page PDF (no external tools needed)
  const pdfDir  = path.dirname(pdfPath);
  const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
  const outPdf  = path.join(pdfDir, `${pdfStem}_backtags.pdf`);

  const pdfBuf = await svgSheetsToPdf(svgPaths);
  fs.writeFileSync(outPdf, pdfBuf);

  // Step 3: Clean up intermediate SVG files
  svgPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

  return { ok: true, pdfPath: outPdf };
});

ipcMain.on('get-version', (event) => { event.returnValue = app.getVersion(); });

ipcMain.handle('parse-payable', async (event, pdfPath) => {
  const fs = require('fs');

  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'payable_parse.py')
    : path.join(__dirname, 'assets', 'payable_parse.py');

  const pythonPaths = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3'];
  const pythonBin = pythonPaths.find(p => {
    try { fs.accessSync(p); return true; } catch { return false; }
  }) || 'python3';

  const env = Object.assign({}, process.env, {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '')
  });

  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(pythonBin, [scriptPath, pdfPath], { env });
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || stdout || `Python exited with code ${code}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch (e) { reject(new Error('Could not parse payable PDF output: ' + stdout)); }
    });
    proc.on('error', err => reject(new Error(`Could not start python3: ${err.message}`)));
  });
});

ipcMain.handle('show-in-finder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
