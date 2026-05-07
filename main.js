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

// Render one SVG file to a PDF Buffer using a hidden BrowserWindow
function svgFileToPdfBuffer(svgPath) {
  const fs   = require('fs');
  const os   = require('os');
  const svgContent = fs.readFileSync(svgPath, 'utf8');

  // Write to a temp HTML file — avoids data URL size limits
  const tmpHtml = path.join(os.tmpdir(), `_bt_render_${Date.now()}.html`);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 612pt 792pt; margin: 0; }
    *{margin:0;padding:0;}
    html,body{width:612pt;height:792pt;overflow:hidden;background:#fff;}
    svg{display:block;width:612pt;height:792pt;}
  </style></head><body>${svgContent}</body></html>`;
  fs.writeFileSync(tmpHtml, html, 'utf8');

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      frame: false,            // no title bar — content area is exactly width×height
      width: 816, height: 1056,  // 612pt × 792pt at 96dpi — matches Letter exactly
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    win.loadFile(tmpHtml);
    win.webContents.once('did-finish-load', () => {
      // Small delay to let SVG fully paint before capturing
      setTimeout(async () => {
        try {
          const pdfBuf = await win.webContents.printToPDF({
            pageSize: { width: 215900, height: 279400 },  // 8.5"×11" in microns — exact MediaBox
            preferCSSPageSize: true,           // use @page size exactly — no auto-scaling
            margins: { marginType: 'none' },
            printBackground: true,
            landscape: false,
            scaleFactor: 100
          });
          win.destroy();
          try { fs.unlinkSync(tmpHtml); } catch {}
          resolve(pdfBuf);
        } catch (e) { win.destroy(); reject(e); }
      }, 800);
    });
    win.webContents.once('did-fail-load', (ev, code, desc) => {
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

  // Step 2: Convert each SVG to a PDF page using Electron's Chromium renderer
  const pdfDir  = path.dirname(pdfPath);
  const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
  const outPdf  = path.join(pdfDir, `${pdfStem}_backtags.pdf`);

  const tmpPdfs = [];
  for (let i = 0; i < svgPaths.length; i++) {
    const pdfBuf  = await svgFileToPdfBuffer(svgPaths[i]);
    const tmpPath = path.join(pdfDir, `_bt_tmp_${i}.pdf`);
    fs.writeFileSync(tmpPath, pdfBuf);
    tmpPdfs.push(tmpPath);
  }

  // Step 3: Merge pages (pdfunite from poppler) or just rename if single page
  if (tmpPdfs.length === 1) {
    fs.renameSync(tmpPdfs[0], outPdf);
  } else {
    await new Promise((resolve, reject) => {
      const proc = spawn('/opt/homebrew/bin/pdfunite', [...tmpPdfs, outPdf], { env });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('pdfunite failed')));
      proc.on('error', reject);
    });
    tmpPdfs.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  }

  // Step 4: Clean up intermediate SVG files
  svgPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

  return { ok: true, pdfPath: outPdf };
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
