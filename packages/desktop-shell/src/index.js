const { app, BrowserWindow, session, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

/** Reads/writes a tiny JSON file in userData so the window reopens at the same size/position. */
function boundsStore(name) {
  const file = () => path.join(app.getPath('userData'), `${name}-window-bounds.json`);
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return null; }
    },
    write(bounds) {
      try { fs.writeFileSync(file(), JSON.stringify(bounds)); } catch { /* best-effort only */ }
    },
  };
}

/**
 * Creates the one BrowserWindow for a KIU desktop wrapper app.
 * Loads the real running web app's URL (not a local bundle): auth cookies are
 * SameSite=Lax/Strict and would silently stop working across a file:// or
 * packaged-asset origin, so the window must share the web app's real origin.
 */
function createShellWindow(opts) {
  const { url, title, width = 1280, height = 860 } = opts;
  const store = boundsStore(title.toLowerCase().replace(/\s+/g, '-'));
  const saved = store.read();

  // Only media (camera/mic) is needed, for QR/face camera capture; everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const win = new BrowserWindow({
    title,
    width: saved?.width ?? width,
    height: saved?.height ?? height,
    x: saved?.x,
    y: saved?.y,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const persistBounds = () => store.write(win.getBounds());
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  // Keep external links (e.g. a target="_blank" help link) in the OS browser, not a second app window.
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const sameOrigin = (() => { try { return new URL(targetUrl).origin === new URL(url).origin; } catch { return false; } })();
    if (sameOrigin) return { action: 'allow' };
    require('electron').shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  win.loadURL(url);
  return win;
}

/** Minimal app menu: standard edit/view/window items only, no app-specific commands yet. */
function installMinimalMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

module.exports = { createShellWindow, installMinimalMenu };
