const { ipcMain } = require('electron/main');
const logger = require('./utils/logger');

function initializeIpcHandlers(services) {
  const { llmService, mcpService, screenshotService, playbookService, mainWindow } = services;

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

  ipcMain.handle('cancel-execution', async (event) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      llmService.cancelExecution();
      return { success: true };
    } catch (error) {
      logger.error('Error cancelling execution:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('show-assistant-message', async (event, message) => {
    try {
      mainWindow.webContents.send('show-assistant-message', message);
      return { success: true };
    } catch (error) {
      logger.error('Error showing assistant message:', error);
      return { success: false, error: error.message };
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

  ipcMain.handle('get-current-url', async (event) => {
    if (!mcpService) {
      return { success: false, error: 'MCP service not initialized' };
    }
    try {
      const url = await mcpService.getCurrentUrl();
      return { success: true, url };
    } catch (error) {
      logger.error('Error getting current URL:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('generate-playwright-script', async (event) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      logger.info('Generating Playwright script from action log...');
      const script = await llmService.generatePlaywrightScript();
      return { success: true, script };
    } catch (error) {
      logger.error('Error generating Playwright script:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-action-log', async (event) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      const actionLog = llmService.getActionLog();
      return { success: true, actionLog };
    } catch (error) {
      logger.error('Error getting action log:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-action-log', async (event) => {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    try {
      llmService.clearActionLog();
      return { success: true };
    } catch (error) {
      logger.error('Error clearing action log:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('get-playbook-status', async (event) => {
    if (!playbookService) {
      return { success: true, status: null }; // No playbook service = not executing
    }
    try {
      const status = playbookService.getStatus();
      return { success: true, status };
    } catch (error) {
      logger.error('Error getting playbook status:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('is-llm-executing', async (event) => {
    if (!llmService) {
      return { success: true, isExecuting: false };
    }
    try {
      // Check if LLM service has an isExecuting property or method
      const isExecuting = llmService.isExecuting || false;
      return { success: true, isExecuting };
    } catch (error) {
      logger.error('Error checking LLM execution status:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { initializeIpcHandlers };
