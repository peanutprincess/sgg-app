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

// ── Condition Report Generator IPC ──

function buildCRHtml(data, photoUrls) {
  const conditionLabels = ['Excellent', 'Good', 'Fair', 'Poor'];
  const conditionBoxes  = conditionLabels.map(lbl =>
    `<span style="margin-right:18px;">${data.condition === lbl ? '&#9745;' : '&#9744;'} ${lbl}</span>`
  ).join('');

  // Thumbnail (artwork thumbnail slot)
  const thumbBase64 = data.photoBase64 && data.photoBase64['Artwork Thumbnail'];
  const thumbMime   = data.photoMime   && data.photoMime['Artwork Thumbnail'] || 'image/jpeg';
  const thumbHtml   = thumbBase64
    ? `<img src="data:${thumbMime};base64,${thumbBase64}" style="max-width:90px;max-height:90px;object-fit:contain;float:right;margin-left:12px;">`
    : '';

  // Photos grid — all labeled slots (skip thumbnail, already shown)
  const photoSlots = [
    'Front', 'Back', 'Top-Left Corner', 'Top-Right Corner',
    'Bottom-Left Corner', 'Bottom-Right Corner', 'Detail 1', 'Detail 2'
  ];
  const photoCells = photoSlots.map(lbl => {
    const b64  = data.photoBase64 && data.photoBase64[lbl];
    const mime = data.photoMime   && data.photoMime[lbl] || 'image/jpeg';
    const url  = photoUrls && photoUrls[lbl];
    if (!b64) return '';
    const imgTag = `<img src="data:${mime};base64,${b64}" style="width:100%;height:100px;object-fit:cover;display:block;">`;
    const link   = url ? `<a href="${url}" style="display:block;">${imgTag}</a>` : imgTag;
    return `<div style="display:flex;flex-direction:column;gap:4px;">${link}<div style="font-size:10px;color:#555;text-align:center;">${lbl}</div></div>`;
  }).filter(Boolean);
  const photosGrid = photoCells.length
    ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">${photoCells.join('')}</div>`
    : '<div style="color:#aaa;font-size:12px;">No photographs attached</div>';

  // Damage diagram SVG — 12-col × 10-row grid with centered ellipse
  const svgW = 520, svgH = 260, cols = 12, rows = 10;
  const cx = svgW / 2, cy = svgH / 2, rx = 255, ry = 120;
  let gridLines = '';
  for (let c = 0; c <= cols; c++) {
    const x = c * (svgW / cols);
    gridLines += `<line x1="${x}" y1="0" x2="${x}" y2="${svgH}" stroke="#ccc" stroke-width="0.5"/>`;
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * (svgH / rows);
    gridLines += `<line x1="0" y1="${y}" x2="${svgW}" y2="${y}" stroke="#ccc" stroke-width="0.5"/>`;
  }
  const damageSvg = `
    <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg" style="border:1px solid #ccc;display:block;">
      <rect width="${svgW}" height="${svgH}" fill="#fafafa"/>
      ${gridLines}
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#888" stroke-width="1.5"/>
    </svg>`;

  const legend = `
    <div style="font-size:10px;color:#555;line-height:1.9;white-space:nowrap;">
      <div>&#9900; Chip &nbsp;&nbsp; &#10003; Dent &nbsp;&nbsp; &#8212; Scratches</div>
      <div>&#9900; Scuffs &nbsp;&nbsp; //// Cracks &nbsp;&nbsp; = Part missing</div>
      <div>&#8960; Stains/dirt &nbsp;&nbsp; &#215; Paint loss &nbsp;&nbsp; &#8743; Tear &nbsp;&nbsp; &#8745;&#8745; Crease</div>
    </div>`;

  const fieldRow = (label, value) =>
    `<div style="display:flex;border-bottom:1px solid #e0e0e0;padding:7px 0;min-height:32px;">
       <div style="width:200px;flex-shrink:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:12px;color:#555;padding-right:12px;">${label}</div>
       <div style="flex:1;font-size:12px;color:#111;">${value || ''}</div>
     </div>`;

  const sectionLabel = (txt) =>
    `<div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#9ca3af;margin:20px 0 6px;">${txt}</div>`;

  const divider = `<hr style="border:none;border-top:1px solid #ccc;margin:14px 0;">`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 8.5in 11in; margin: 0.75in; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 12px; color: #111; background: #fff; }
  </style></head><body>
  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
    <div style="font-size:16px;font-weight:700;letter-spacing:0.02em;">Sebastian Gladstone</div>
    <div style="text-align:right;font-size:12px;line-height:1.8;">
      <div><span style="color:#777;">Date in:</span> ${data.dateIn || ''}</div>
      <div><span style="color:#777;">Date out:</span> ${data.dateOut || ''}</div>
    </div>
  </div>
  ${divider}

  <!-- Artwork info -->
  ${fieldRow('Stock number', data.stockNum)}
  <div style="display:flex;border-bottom:1px solid #e0e0e0;padding:7px 0;min-height:32px;">
    <div style="width:200px;flex-shrink:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:12px;color:#555;padding-right:12px;">Artwork</div>
    <div style="flex:1;font-size:12px;color:#111;">
      <strong>${data.artist || ''}</strong><br>
      ${data.title ? `<em>${data.title}</em>` : ''}${data.year ? `, ${data.year}` : ''}<br>
      ${data.medium || ''}<br>
      ${data.dimensions || ''}
    </div>
    ${thumbHtml}
  </div>
  ${divider}

  <!-- Condition -->
  ${fieldRow('General condition', conditionBoxes)}
  ${fieldRow('Comments', (data.comments || '').replace(/\n/g, '<br>'))}
  ${fieldRow('Inscription information', (data.inscription || '').replace(/\n/g, '<br>'))}
  ${fieldRow('Frame condition and dimensions', (data.frameCondition || '').replace(/\n/g, '<br>'))}
  ${divider}

  <!-- Photographs -->
  ${sectionLabel('Photographs')}
  ${photosGrid}
  ${divider}

  <!-- Damage diagram -->
  ${sectionLabel('Condition diagram')}
  <div style="display:flex;gap:16px;align-items:flex-start;">
    ${legend}
    <div style="flex:1;">${damageSvg}</div>
  </div>
  ${divider}

  <!-- Signature -->
  <div style="display:flex;gap:48px;margin-top:8px;">
    <div style="flex:1;">
      <div style="font-size:10px;color:#777;margin-bottom:6px;">Signature</div>
      <div style="border-bottom:1px solid #555;min-height:28px;padding-bottom:4px;">${data.signedBy || ''}</div>
    </div>
    <div style="flex:1;">
      <div style="font-size:10px;color:#777;margin-bottom:6px;">Date</div>
      <div style="border-bottom:1px solid #555;min-height:28px;padding-bottom:4px;">${data.sigDate || ''}</div>
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
