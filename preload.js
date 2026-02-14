const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    toggleFloatWindow: () => ipcRenderer.send('toggle-float-window'),
    createFloatWindow: () => ipcRenderer.send('create-float-window'),
    closeFloatWindow: () => ipcRenderer.send('close-float-window'),
    minimizeFloatWindow: () => ipcRenderer.send('minimize-float-window'),
    setFloatAlwaysOnTop: (isOnTop) => ipcRenderer.send('set-float-always-on-top', isOnTop),
    setFloatOpacity: (opacity) => ipcRenderer.send('set-float-opacity', opacity),
    getFloatBounds: () => ipcRenderer.invoke('get-float-bounds'),
    onFloatPositionSaved: (callback) => ipcRenderer.on('float-position-saved', (event, data) => callback(data)),
    isElectron: true,
});
