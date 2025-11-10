const { contextBridge, ipcRenderer } = require('electron/renderer');

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (message) => ipcRenderer.invoke('send-message', message),
  startScreenshotStream: () => ipcRenderer.invoke('start-screenshot-stream'),
  stopScreenshotStream: () => ipcRenderer.invoke('stop-screenshot-stream'),
  getMCPTools: () => ipcRenderer.invoke('get-mcp-tools'),
  getLLMProvider: () => ipcRenderer.invoke('get-llm-provider'),
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),
  onScreenshotUpdate: (callback) => {
    ipcRenderer.on('screenshot-update', (event, screenshot) => callback(screenshot));
  },
  onServicesReady: (callback) => {
    ipcRenderer.on('services-ready', () => callback());
  },
  onStreamStopped: (callback) => {
    ipcRenderer.on('stream-stopped', () => callback());
  },
  onStreamStarted: (callback) => {
    ipcRenderer.on('stream-started', () => callback());
  }
});
