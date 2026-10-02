/**
 * CampusCore - Main process entry point.
 *
 * Responsibilities:
 *  - Create the secure BrowserWindow
 *  - Initialise SQLite before the renderer is shown
 *  - Register IPC handlers (see ipc.js)
 */
'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const database = require('./database');
const { registerIpcHandlers } = require('./ipc');

const isDev = process.argv.includes('--dev');
const APP_NAME = 'CampusCore';

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Guards the async database shutdown so will-quit only fires once. */
let databaseClosing = false;

/* Single instance lock: only one copy of the ERP may run at a time. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        // NOTE: accelerators are intentionally omitted here - the shortcuts
        // (Ctrl+D/S/I/R/G) are owned by the renderer's keyboard listener so
        // that they work uniformly regardless of focus inside a view.
        { label: 'Dashboard', click: () => send('nav:goto', 'dashboard') },
        { label: 'Students', click: () => send('nav:goto', 'students') },
        { label: 'Fee & Invoicing', click: () => send('nav:goto', 'fees') },
        { label: 'Grades & Report Cards', click: () => send('nav:goto', 'grades') },
        { label: 'Classes & Subjects', click: () => send('nav:goto', 'classes') },
        { label: 'Settings', click: () => send('nav:goto', 'settings') },
        { type: 'separator' },
        {
          label: 'Database Location',
          click: () => shell.showItemInFolder(database.getDatabaseFile()),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Ctrl+Shift+R - plain Ctrl+R belongs to "Grades & Report Cards".
        { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => send('nav:help'),
        },
        {
          label: 'About CampusCore',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About CampusCore',
              message: `${APP_NAME} v${app.getVersion()}`,
              detail: `Offline-first School Management & Invoicing ERP.\n\nDatabase file:\n${database.getDatabaseFile()}`,
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function createWindow() {
  await database.initDatabase();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f172a',
    title: APP_NAME,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  try {
    registerIpcHandlers({ getWindow: () => mainWindow });
    buildMenu();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox(`${APP_NAME} failed to start`, String((err && err.stack) || err));
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => {});
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// SQLite closes asynchronously, so defer the actual exit until it is done -
// otherwise the native addon is torn down mid-close and throws on shutdown.
app.on('will-quit', (event) => {
  if (!database.isDatabaseOpen()) return; // already closed, let it exit
  event.preventDefault();
  if (databaseClosing) return; // close in flight, wait for it below
  databaseClosing = true;
  database.closeDatabase().then(() => app.quit());
});

process.on('uncaughtException', (err) => {
  // Keep the app alive but surface the problem.
  if (mainWindow && !mainWindow.isDestroyed()) {
    send('app:error', String((err && err.message) || err));
  }
  console.error('[main] uncaughtException', err);
});
