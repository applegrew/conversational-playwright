const { ipcMain } = require('electron/main');
const logger = require('./utils/logger');

function initializeIpcHandlers(services) {
  const { llmService, mcpService, screenshotService, mainWindow } = services;

  // IPC Handlers
  ipcMain.handle('send-message', async (event, message) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      const response = await llmService.processMessage(message);
      return { success: true, response };
    } catch (error) {
      logger.error('Error processing message:', error);
      const errorInfo = {
        message: error.message || 'An error occurred',
        status: error.status,
        statusText: error.statusText
      };
      return { success: false, error: errorInfo };
    }
  });

  ipcMain.handle('start-screenshot-stream', async (event) => {
    if (!screenshotService || !mainWindow) {
      logger.error('Screenshot service or main window not initialized');
      return { success: false, error: 'Screenshot service or main window not initialized' };
    }
    try {
      logger.info('Starting screenshot service...');
      screenshotService.start((screenshot) => {
        if (screenshot && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('screenshot-update', screenshot);
        }
      });
      logger.info('Screenshot service started');
      // Notify renderer that stream has started
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-started');
      }
      return { success: true };
    } catch (error) {
      logger.error('Error starting screenshot stream:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-screenshot-stream', async (event) => {
    if (!screenshotService) {
      return { success: false, error: 'Screenshot service not initialized' };
    }
    try {
      screenshotService.stop();
      // Notify renderer that stream has stopped
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-stopped');
      }
      return { success: true };
    } catch (error) {
      logger.error('Error stopping screenshot stream:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-llm-provider', async (event) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      const provider = await llmService.getLLMProvider();
      return { success: true, provider: provider.provider };
    } catch (error) {
      logger.error('Error getting LLM provider:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-mcp-tools', async (event) => {
    if (!mcpService) {
      return { success: false, error: 'MCP service not initialized' };
    }
    try {
      const tools = await mcpService.getAvailableTools();
      return { success: true, tools };
    } catch (error) {
      logger.error('Error getting MCP tools:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { initializeIpcHandlers };
