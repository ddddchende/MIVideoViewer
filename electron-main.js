const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let server;
function getWindowStatePath() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
    try {
        const state = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8'));
        if (Number.isFinite(state.width) && Number.isFinite(state.height)) return state;
    } catch { /* 使用默认窗口尺寸 */ }
    return null;
}

function saveWindowState(win) {
    if (!win || win.isMaximized() || win.isMinimized()) return;
    try {
        const statePath = getWindowStatePath();
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(win.getBounds()), 'utf8');
    } catch (err) {
        console.warn('[window] 保存窗口尺寸失败:', err.message);
    }
}

function getDataPath() {
    // 统一数据目录：单体 EXE 与 ZIP 版共用 userData，保证登录凭据互通
    return path.join(app.getPath('userData'), 'data');
}

/**
 * 从旧数据位置（项目根）把数据文件迁移到统一数据目录。
 * 仅当目标文件不存在时拷贝，避免覆盖已更新的数据。
 */
function migrateLegacyData(dataPath) {
    try { fs.mkdirSync(dataPath, { recursive: true }); } catch { /* 目录已存在 */ }
    const legacyRoot = path.join(__dirname, '..');
    const files = ['config.json', 'go2rtc.yaml', 'credentials.json'];
    for (const name of files) {
        const src = path.join(legacyRoot, name);
        const dst = path.join(dataPath, name);
        try {
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
                fs.copyFileSync(src, dst);
                console.log(`[data] 已迁移 ${name} → ${dataPath}`);
            }
        } catch (err) {
            console.warn(`[data] 迁移 ${name} 失败:`, err.message);
        }
    }
}

function createWindow() {
    const savedBounds = loadWindowState();
    const win = new BrowserWindow({
        width: savedBounds?.width || 1920,
        height: savedBounds?.height || 1080,
        x: Number.isFinite(savedBounds?.x) ? savedBounds.x : undefined,
        y: Number.isFinite(savedBounds?.y) ? savedBounds.y : undefined,
        minWidth: 1590,
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

    win.on('close', () => {
        saveWindowState(win);
    });
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
ipcMain.on('window:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    saveWindowState(win);
    win?.close();
});
ipcMain.on('window:is-maximized', (e) => {
    e.returnValue = !!BrowserWindow.fromWebContents(e.sender)?.isMaximized();
});

ipcMain.handle('dialog:selectFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
        title: '选择视频目录',
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
    process.env.MI_VIDEO_VIEWER_DATA_PATH = getDataPath();
    // 启动前确保旧数据已迁移到统一数据目录（server 依据该 env 读取）
    migrateLegacyData(getDataPath());
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
