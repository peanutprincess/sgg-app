const { app, BrowserWindow, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

app.name = 'SG';
const launchTime = Date.now();

function createWindow() {
  // Set dock icon from SVG logo
  if (process.platform === 'darwin') {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/icon.icns'));
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

// ── Condition Report Generator IPC ──

function buildCRHtml(data, photoUrls) {
  const conditionLabels = ['Excellent', 'Good', 'Fair', 'Poor'];
  const conditionBoxes  = conditionLabels.map(lbl =>
    `<span style="margin-right:16px;">${data.condition === lbl ? '&#9745;' : '&#9744;'} ${lbl}</span>`
  ).join('');

  // Thumbnail — Front photo used as top-right header image
  const thumbBase64 = data.photoBase64 && data.photoBase64['Front'];
  const thumbMime   = (data.photoMime && data.photoMime['Front']) || 'image/jpeg';
  const thumbHtml   = thumbBase64
    ? `<img src="data:${thumbMime};base64,${thumbBase64}" style="width:190px;height:190px;object-fit:contain;border:1px solid #ccc;display:block;">`
    : `<div style="width:190px;height:190px;background:#e5e5e5;border:1px solid #ccc;"></div>`;

  // Photos grid — 9 slots (3×3): Front + 7 views + Signature
  const photoSlots = [
    'Front', 'Back', 'Top-Left Corner',
    'Top-Right Corner', 'Bottom-Left Corner', 'Bottom-Right Corner',
    'Detail 1', 'Detail 2', 'Signature'
  ];
  const photoCells = photoSlots.map(lbl => {
    const b64  = data.photoBase64 && data.photoBase64[lbl];
    const mime = (data.photoMime && data.photoMime[lbl]) || 'image/jpeg';
    const inner = b64
      ? `<img src="data:${mime};base64,${b64}" style="width:100%;height:100%;object-fit:cover;display:block;">`
      : `<div style="width:100%;height:100%;background:#e5e5e5;"></div>`;
    return `<div style="border:1px solid #ccc;overflow:hidden;aspect-ratio:1;">${inner}</div>`;
  }).join('');
  const photosGrid = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;">${photoCells}</div>`;

  // Double horizontal rule
  const doubleRule = `<div style="margin:14px 0;"><div style="border-top:1px solid #666;"></div><div style="border-top:1px solid #666;margin-top:3px;"></div></div>`;

  // Field row — gray bold label left, value right
  const fieldRow = (label, value) =>
    `<div style="display:flex;border-bottom:1px solid #e0e0e0;padding:7px 0;min-height:30px;align-items:flex-start;">
       <div style="width:210px;flex-shrink:0;font-size:11px;font-weight:700;color:#555;padding-right:12px;line-height:1.5;">${label}</div>
       <div style="flex:1;font-size:12px;color:#111;line-height:1.5;">${value || ''}</div>
     </div>`;

  // Condition diagram SVG — full-page graph grid with large circle
  const cell = 20, cols = 26, rows = 30;
  const svgW = cols * cell, svgH = rows * cell;   // 520 × 600
  let gridLines = '';
  for (let c = 0; c <= cols; c++) {
    const x = c * cell;
    gridLines += `<line x1="${x}" y1="0" x2="${x}" y2="${svgH}" stroke="#bbb" stroke-width="0.5"/>`;
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * cell;
    gridLines += `<line x1="0" y1="${y}" x2="${svgW}" y2="${y}" stroke="#bbb" stroke-width="0.5"/>`;
  }
  const cx = svgW / 2, cy = svgH / 2, radius = Math.round(svgW * 0.43);
  const damageSvg = `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg"
      style="display:block;width:100%;height:auto;border:1px solid #bbb;">
    <rect width="${svgW}" height="${svgH}" fill="white"/>
    ${gridLines}
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#666" stroke-width="1.5"/>
  </svg>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 8.5in 11in; margin: 0.75in; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 12px; color: #111; background: #fff; }
    .page2 { page-break-before: always; }
  </style></head><body>

  <!-- ═══ PAGE 1 ═══ -->

  <!-- Header: title/info left, thumbnail right -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
    <div style="flex:1;padding-right:24px;">
      <div style="font-size:20px;font-weight:700;margin-bottom:3px;">Condition Report</div>
      <div style="font-size:14px;margin-bottom:10px;">Sebastian Gladstone</div>
      <div style="font-size:11px;font-weight:700;color:#555;margin-bottom:10px;">
        <span>Date:</span>&nbsp;<span style="font-weight:400;">${data.dateIn || ''}</span>
        &nbsp;&nbsp;&nbsp;&nbsp;
        <span>Location:</span>&nbsp;<span style="font-weight:400;">${data.location || ''}</span>
      </div>
      <div style="font-size:11px;font-weight:700;color:#555;margin-bottom:8px;">Artwork</div>
      <div style="padding-left:80px;line-height:1.6;">
        <div style="font-weight:700;font-size:12px;">${data.artist || ''}</div>
        <div style="font-size:12px;"><em>${data.title || ''}</em>${data.year ? `, ${data.year}` : ''}</div>
        <div style="font-size:12px;">${data.medium || ''}</div>
        <div style="font-size:12px;">${data.dimensions || ''}</div>
      </div>
    </div>
    <div style="flex-shrink:0;">${thumbHtml}</div>
  </div>

  ${doubleRule}

  <!-- Condition fields -->
  ${fieldRow('General Condition', conditionBoxes)}
  ${fieldRow('Comments', (data.comments || '').replace(/\n/g, '<br>'))}
  ${fieldRow('Inscription information', (data.inscription || '').replace(/\n/g, '<br>'))}
  ${fieldRow('Frame condition and dimensions', (data.frameCondition || '').replace(/\n/g, '<br>'))}

  ${doubleRule}

  <!-- Photographs -->
  <div style="font-size:13px;font-weight:700;">Photographs</div>
  ${photosGrid}

  <!-- ═══ PAGE 2 ═══ -->
  <div class="page2">
    <div style="font-size:16px;font-weight:700;margin-bottom:10px;">Condition Diagram</div>
    <div style="font-size:11px;color:#555;line-height:2;margin-bottom:14px;">
      <div>&#9900; Chip &nbsp;&nbsp;&nbsp; &#10003; Dent &nbsp;&nbsp;&nbsp; &#8212; Scratches</div>
      <div>&#9900; Scuffs &nbsp;&nbsp;&nbsp; //// Cracks &nbsp;&nbsp;&nbsp; = Part missing</div>
      <div>&#8960; Stains &nbsp;&nbsp;&nbsp; &#215; Paint loss &nbsp;&nbsp;&nbsp; &#8743; Tear &nbsp;&nbsp;&nbsp; &#8745;&#8745; Crease</div>
    </div>

    ${damageSvg}

    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:28px;padding-top:6px;border-top:1px solid #555;">
      <div style="font-size:13px;font-weight:700;">Signature</div>
      <div style="font-size:13px;font-weight:700;">Date</div>
    </div>
  </div>

  </body></html>`;
}

ipcMain.handle('generate-cr', async (event, payload) => {
  const fs   = require('fs');
  const os   = require('os');
  const { net } = require('electron');

  // Choose fetch implementation — electron.net.fetch preferred in packaged builds
  const doFetch = (typeof net !== 'undefined' && net.fetch)
    ? (url, opts) => net.fetch(url, opts)
    : (url, opts) => fetch(url, opts);

  const SCRIPT_URL = payload.scriptUrl; // passed from renderer

  // Step 1: upload photos to GAS
  let photoUrls = {};
  if (payload.photos && Object.keys(payload.photos).length > 0) {
    const photosResp = await doFetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        type:     'cr-photos',
        stockNum: payload.stockNum,
        photos:   payload.photos
      })
    });
    const photosResult = await photosResp.json();
    if (!photosResult.success) throw new Error('Photo upload failed: ' + (photosResult.error || 'unknown'));
    photoUrls = photosResult.photoUrls || {};
  }

  // Step 2: build CR HTML and render to PDF
  const html    = buildCRHtml(payload, photoUrls);
  const tmpHtml = path.join(os.tmpdir(), `_cr_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const pdfBuf = await new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false, frame: false,
      width: 816, height: 1056,
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
    });
    win.loadFile(tmpHtml);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const buf = await win.webContents.printToPDF({
            pageSize: { width: 215900, height: 279400 },
            preferCSSPageSize: true,
            margins: { marginType: 'none' },
            printBackground: true,
            landscape: false,
            scaleFactor: 100
          });
          win.destroy();
          try { fs.unlinkSync(tmpHtml); } catch {}
          resolve(buf);
        } catch (e) { win.destroy(); reject(e); }
      }, 1200);
    });
    win.webContents.once('did-fail-load', (_, code, desc) => {
      win.destroy();
      reject(new Error(`CR page load failed: ${desc}`));
    });
  });

  // Step 3: save PDF locally
  const safeArtist = (payload.artist || 'Artist').replace(/[^a-zA-Z0-9 _-]/g, '_');
  const localName  = `${payload.stockNum || 'CR'}_${safeArtist}_CR_${payload.dateIn || 'nodate'}.pdf`;
  const localPath  = path.join(os.tmpdir(), localName);
  fs.writeFileSync(localPath, pdfBuf);

  // Step 4: upload PDF + log to GAS
  const pdfBase64  = pdfBuf.toString('base64');
  const crResp     = await doFetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      type:          'condition-report',
      stockNum:      payload.stockNum,
      artist:        payload.artist,
      title:         payload.title,
      dateIn:        payload.dateIn,
      condition:     payload.condition,
      signedBy:      payload.signedBy,
      pdfData:       pdfBase64
    })
  });
  const crResult = await crResp.json();
  if (!crResult.success) throw new Error('CR upload failed: ' + (crResult.error || 'unknown'));

  // Step 5: reveal in Finder
  shell.showItemInFolder(localPath);

  return { success: true, pdfUrl: crResult.pdfUrl, localPath };
});

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) {
    autoUpdater.autoDownload        = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', () => {}); // swallow silently — don't surface to user
    autoUpdater.on('update-downloaded', () => {
      // If update arrives within 8s of launch the user hasn't done anything yet —
      // restart immediately so they open straight into the new version.
      if (Date.now() - launchTime < 8000) {
        autoUpdater.quitAndInstall(true /* silent */, true /* restartAfterInstall */);
      }
      // Otherwise it installs automatically on next quit (autoInstallOnAppQuit).
    });
    autoUpdater.checkForUpdates();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
