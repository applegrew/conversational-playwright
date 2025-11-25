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
  showAssistantMessage: (message) => ipcRenderer.invoke('show-assistant-message', message),
  startScreenshotStream: () => ipcRenderer.invoke('start-screenshot-stream'),
  stopScreenshotStream: () => ipcRenderer.invoke('stop-screenshot-stream'),
  getMCPTools: () => ipcRenderer.invoke('get-mcp-tools'),
  getLLMProvider: () => ipcRenderer.invoke('get-llm-provider'),
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),
  generatePlaywrightScript: () => ipcRenderer.invoke('generate-playwright-script'),
  getActionLog: () => ipcRenderer.invoke('get-action-log'),
  clearActionLog: () => ipcRenderer.invoke('clear-action-log'),
  getValidationResults: () => ipcRenderer.invoke('get-validation-results'),
  clearValidationResults: () => ipcRenderer.invoke('clear-validation-results'),
  cancelExecution: () => ipcRenderer.invoke('cancel-execution'),
  getPlaybookStatus: () => ipcRenderer.invoke('get-playbook-status'),
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
  },
  onToolExecutionStart: (callback) => {
    ipcRenderer.on('tool-execution-start', (event, data) => callback(data));
  },
  onToolExecutionSuccess: (callback) => {
    ipcRenderer.on('tool-execution-success', (event, data) => callback(data));
  },
  onToolExecutionError: (callback) => {
    ipcRenderer.on('tool-execution-error', (event, data) => callback(data));
  },
  onShowAssistantMessage: (callback) => {
    ipcRenderer.on('show-assistant-message', (event, message) => callback(message));
  },
  onPlaybookMessage: (callback) => {
    ipcRenderer.on('playbook-message', (event, data) => callback(data));
  },
  onPlaybookStarted: (callback) => {
    ipcRenderer.on('playbook-started', () => callback());
  },
  onPlaybookCompleted: (callback) => {
    ipcRenderer.on('playbook-completed', (event, data) => callback(data));
  }
});
