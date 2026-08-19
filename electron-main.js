const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let server;

function getDataPath() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
    }
    return path.join(app.getPath('userData'), 'data');
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 700,
        frame: false,
        backgroundColor: '#0b0d12',
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.once('ready-to-show', () => win.show());

    const { loadConfig, startServer } = require('./server');
    const config = loadConfig();
    const port = Number(config.port) || 3000;
    server = startServer(() => win.loadURL(`http://localhost:${port}`));

    win.on('closed', () => {
        if (server) server.close();
    });
}

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('window:is-maximized', (e) => {
    e.returnValue = !!BrowserWindow.fromWebContents(e.sender)?.isMaximized();
});

app.whenReady().then(() => {
    process.env.MI_VIDEO_VIEWER_DATA_PATH = getDataPath();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
