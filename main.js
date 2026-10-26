'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Store } = require('./db');

if (process.env.DAYBOOK_DATA_DIR) app.setPath('userData', process.env.DAYBOOK_DATA_DIR);

const DIST = path.join(__dirname, 'dist');
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: daybook-media:; media-src 'self' blob: daybook-media:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'daybook-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let store = null;
let win = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function trusted(e) {
  const url = (e.senderFrame && e.senderFrame.url) || '';
  return url.startsWith('app://daybook/');
}

function registerProtocols() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { headers: { 'Content-Type': type, 'Content-Security-Policy': CSP } });
    } catch { return new Response('Not found', { status: 404 }); }
  });

  /* daybook-media://m/<id>: streams a stored photo or video, with range support so videos can seek */
  protocol.handle('daybook-media', (req) => {
    const u = new URL(req.url);
    const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const m = store.mediaFile(id);
    if (!m) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(m.file).toString(), { headers: req.headers });
  });
}

function registerIpc() {
  ipcMain.on('db:loadAll', (e) => { e.returnValue = trusted(e) ? store.loadAll() : {}; });
  ipcMain.on('db:save', (e, out) => { if (trusted(e)) { try { store.saveAll(out); } catch (err) { console.error('save failed', err); } } });
  ipcMain.on('db:saveSync', (e, out) => { if (trusted(e)) { try { store.saveAll(out); } catch (err) { console.error('save failed', err); } } e.returnValue = true; });
  ipcMain.handle('media:putBuf', (e, id, mime, buf) => {
    if (!trusted(e)) return false;
    try { return store.putBuf(String(id), String(mime || ''), Buffer.from(buf)); } catch (err) { console.error(err); return false; }
  });
  ipcMain.handle('media:putPath', (e, id, mime, p) => {
    if (!trusted(e)) return false;
    try { return store.putPath(String(id), String(mime || ''), String(p)); } catch (err) { console.error(err); return false; }
  });
  ipcMain.on('media:del', (e, id) => { if (trusted(e)) { try { store.delMedia(String(id)); } catch (err) { console.error(err); } } });
}

function windowState() {
  const f = path.join(app.getPath('userData'), 'window.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const f = path.join(app.getPath('userData'), 'window.json');
  const b = win.getNormalBounds();
  try { fs.writeFileSync(f, JSON.stringify({ ...b, max: win.isMaximized() })); } catch { /* not critical */ }
}

function createWindow() {
  const st = windowState();
  win = new BrowserWindow({
    width: st.width || 1360, height: st.height || 900, x: st.x, y: st.y, minWidth: 360, minHeight: 560,
    backgroundColor: '#3a2e25', title: 'Daybook', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://daybook/')) e.preventDefault(); });
  win.loadURL('app://daybook/index.html');
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Back up data…', click: backUp },
      { label: 'Show data folder', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
    ] },
    { label: 'Help', submenu: [{ label: 'About Daybook', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Daybook', message: 'Daybook ' + app.getVersion(), detail: 'A page for every day.\nYour entries and media are stored on this computer:\n' + app.getPath('userData') }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (!mac && win) win.setAutoHideMenuBar(true);
}

async function backUp() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where to save the backup', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(r.filePaths[0], 'Daybook backup ' + stamp);
  try {
    store.backup(dest);
    shell.showItemInFolder(dest);
  } catch (err) { dialog.showErrorBox('Backup failed', String(err && err.message || err)); }
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  try { store.gc(); } catch (err) { console.error('gc failed', err); }
  registerProtocols();
  registerIpc();
  createWindow();
  buildMenu();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (store) store.close(); });
