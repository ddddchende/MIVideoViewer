const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.sendSync('window:is-maximized')
});

contextBridge.exposeInMainWorld('dialog', {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder')
});
