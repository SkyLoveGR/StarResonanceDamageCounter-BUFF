const { app, BrowserWindow, ipcMain, screen, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let floatWindow = null;
let serverProcess = null;
let serverPort = 8989;

async function clearCacheAndLogs() {
    try {
        const ses = session.defaultSession;
        await ses.clearCache();
        await ses.clearStorageData({
            storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
        });
    } catch (err) {}

    try {
        const logsPath = path.join(app.getPath('userData'), 'logs');
        if (fs.existsSync(logsPath)) {
            const files = fs.readdirSync(logsPath);
            for (const file of files) {
                const filePath = path.join(logsPath, file);
                fs.unlinkSync(filePath);
            }
        }
    } catch (err) {}

    try {
        const gpuCachePath = path.join(app.getPath('userData'), 'GPUCache');
        if (fs.existsSync(gpuCachePath)) {
            const files = fs.readdirSync(gpuCachePath);
            for (const file of files) {
                const filePath = path.join(gpuCachePath, file);
                fs.unlinkSync(filePath);
            }
        }
    } catch (err) {}
}

function createMainWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: path.join(__dirname, 'public', 'icon.png'),
        title: 'Star Resonance Damage Counter',
    });

    mainWindow.loadURL(`http://localhost:${serverPort}`);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        setTimeout(() => {
            if (mainWindow) {
                mainWindow.loadURL(`http://localhost:${serverPort}`);
            }
        }, 1000);
    });
}

function createFloatWindow() {
    if (floatWindow) {
        floatWindow.show();
        floatWindow.setAlwaysOnTop(true, 'screen-saver');
        return;
    }

    floatWindow = new BrowserWindow({
        width: 320,
        height: 400,
        minWidth: 200,
        minHeight: 150,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    floatWindow.setAlwaysOnTop(true, 'screen-saver');
    floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    floatWindow.loadURL(`http://localhost:${serverPort}/float.html`);

    floatWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        setTimeout(() => {
            if (floatWindow) {
                floatWindow.loadURL(`http://localhost:${serverPort}/float.html`);
            }
        }, 1000);
    });

    floatWindow.on('close', (e) => {
        if (!floatWindow._forceClose) {
            e.preventDefault();
            floatWindow.hide();
        }
    });

    floatWindow.on('closed', () => {
        floatWindow = null;
    });

    floatWindow.on('moved', () => {
        saveFloatWindowPosition();
    });

    floatWindow.on('resized', () => {
        saveFloatWindowPosition();
    });

    floatWindow.on('minimize', (e) => {
        e.preventDefault();
        floatWindow.restore();
    });
}

function saveFloatWindowPosition() {
    if (!floatWindow) return;
    const bounds = floatWindow.getBounds();
    const positionData = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    };
    mainWindow?.webContents.send('float-position-saved', positionData);
}

function startServer() {
    return new Promise((resolve, reject) => {
        serverProcess = spawn('node', ['server.js', 'auto', 'info'], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });

        serverProcess.stdout.on('data', (data) => {
            const output = data.toString();
            const portMatch = output.match(/Web Server started at http:\/\/localhost:(\d+)/);
            if (portMatch) {
                serverPort = parseInt(portMatch[1]);
                resolve(serverPort);
            }
        });

        serverProcess.stderr.on('data', (data) => {});

        serverProcess.on('error', (err) => {
            reject(err);
        });

        serverProcess.on('close', (code) => {
            serverProcess = null;
        });

        setTimeout(() => {
            resolve(serverPort);
        }, 5000);
    });
}

app.whenReady().then(async () => {
    try {
        await clearCacheAndLogs();
        await startServer();

        setTimeout(() => {
            createMainWindow();
            createFloatWindow();
        }, 1000);
    } catch (err) {
        app.quit();
    }

    globalShortcut.register('CommandOrControl+Shift+F', () => {
        if (floatWindow) {
            if (floatWindow.isVisible()) {
                floatWindow.hide();
            } else {
                floatWindow.show();
            }
        } else {
            createFloatWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (serverProcess) {
        serverProcess.kill();
    }
});

ipcMain.on('toggle-float-window', () => {
    if (floatWindow) {
        if (floatWindow.isVisible()) {
            floatWindow.hide();
        } else {
            floatWindow.show();
        }
    } else {
        createFloatWindow();
    }
});

ipcMain.on('create-float-window', () => {
    createFloatWindow();
});

ipcMain.on('close-float-window', () => {
    if (floatWindow) {
        floatWindow._forceClose = true;
        floatWindow.close();
    }
});

ipcMain.on('set-float-always-on-top', (event, isOnTop) => {
    if (floatWindow) {
        floatWindow.setAlwaysOnTop(isOnTop);
    }
});

ipcMain.on('set-float-opacity', (event, opacity) => {
    if (floatWindow) {
        floatWindow.setOpacity(opacity);
    }
});

ipcMain.on('minimize-float-window', () => {
    if (floatWindow) {
        floatWindow.minimize();
    }
});

ipcMain.handle('get-float-bounds', () => {
    if (floatWindow) {
        return floatWindow.getBounds();
    }
    return null;
});
