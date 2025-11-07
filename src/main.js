const { app, BrowserWindow, ipcMain } = require('electron/main');
const path = require('node:path');
const logger = require('./utils/logger');

let mainWindow;
let mcpService;
let llmService;
let screenshotService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  
  // Open DevTools only in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
  
  // Forward renderer console logs to main process
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelMap = ['LOG', 'WARNING', 'ERROR'];
    console.log(`[Renderer Console ${levelMap[level] || 'LOG'}]:`, message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Start window creation and service initialization in parallel
  // They don't depend on each other, so this speeds up startup
  console.log('Starting parallel initialization...');
  
  const windowCreation = Promise.resolve(createWindow());
  
  const serviceInitialization = (async () => {
    try {
      const MCPService = require('./services/mcpService');
      const LLMService = require('./services/llmService');
      const ScreenshotService = require('./services/screenshotService');
      
      console.log('Creating MCP service...');
      mcpService = new MCPService();
      
      console.log('Initializing MCP service...');
      await mcpService.initialize();
      console.log('MCP service initialized successfully');
      
      console.log('Creating LLM service...');
      llmService = new LLMService(mcpService);
      console.log('LLM service created');
      
      console.log('Creating Screenshot service...');
      screenshotService = new ScreenshotService(mcpService);
      console.log('Screenshot service created');
      
      console.log('All services initialized successfully');
    } catch (error) {
      console.error('Error initializing services:', error);
      console.error('Stack trace:', error.stack);
      // Show error dialog to user
      const { dialog } = require('electron/main');
      dialog.showErrorBox('Initialization Error', `Failed to initialize services: ${error.message}`);
      throw error;
    }
  })();
  
  // Wait for both to complete
  await Promise.all([windowCreation, serviceInitialization]);
  
  // Notify renderer that services are ready
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('services-ready');
    console.log('Sent services-ready event to renderer');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Cleanup services
  if (screenshotService) {
    screenshotService.stop();
  }
  if (mcpService) {
    await mcpService.cleanup();
  }
});

// Handle process termination signals for proper cleanup
process.on('SIGINT', async () => {
  console.log('Received SIGINT, cleaning up...');
  if (mcpService) {
    await mcpService.cleanup();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  if (mcpService) {
    await mcpService.cleanup();
  }
  process.exit(0);
});

// IPC Handlers
ipcMain.handle('send-message', async (event, message) => {
  try {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    const response = await llmService.processMessage(message);
    return { success: true, response };
  } catch (error) {
    console.error('Error processing message:', error);
    // Return full error object with status info for proper formatting in UI
    const errorInfo = {
      message: error.message || 'An error occurred',
      status: error.status,
      statusText: error.statusText
    };
    return { success: false, error: errorInfo };
  }
});

ipcMain.handle('start-screenshot-stream', async (event) => {
  try {
    logger.debug('start-screenshot-stream called');
    if (!screenshotService) {
      logger.error('Screenshot service not initialized');
      return { success: false, error: 'Screenshot service not initialized' };
    }
    logger.info('Starting screenshot service...');
    screenshotService.start((screenshot) => {
      if (screenshot) {
        logger.verbose('Screenshot captured, sending to renderer');
        mainWindow.webContents.send('screenshot-update', screenshot);
      } else {
        logger.verbose('Screenshot is null');
      }
    });
    logger.info('Screenshot service started');
    return { success: true };
  } catch (error) {
    console.error('Error starting screenshot stream:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-screenshot-stream', async (event) => {
  try {
    screenshotService.stop();
    return { success: true };
  } catch (error) {
    console.error('Error stopping screenshot stream:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-mcp-tools', async (event) => {
  try {
    if (!mcpService) {
      return { success: false, error: 'MCP service not initialized' };
    }
    const tools = await mcpService.getAvailableTools();
    return { success: true, tools };
  } catch (error) {
    console.error('Error getting MCP tools:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-llm-provider', async (event) => {
  try {
    if (!llmService) {
      return { success: false, error: 'LLM service not initialized' };
    }
    const provider = llmService.provider;
    return { success: true, provider };
  } catch (error) {
    console.error('Error getting LLM provider:', error);
    return { success: false, error: error.message };
  }
});
