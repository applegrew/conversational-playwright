require('dotenv').config();
const { app, BrowserWindow, dialog } = require('electron/main');
const path = require('node:path');
const logger = require('./utils/logger');
const { initializeIpcHandlers } = require('./ipcManager');

let mainWindow;
let mcpService;
let llmService;
let screenshotService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'assets', 'html', 'index.html'));
  
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
  
  createWindow();

  // Set the dock icon for macOS
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  
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
      await llmService.initialize(); // Initialize the LLM provider
      console.log('LLM service initialized');
      
      console.log('Creating Screenshot service...');
      screenshotService = new ScreenshotService(mcpService);
      console.log('Screenshot service created');

      // Provide the screenshotService instance to the mcpService
      mcpService.setScreenshotService(screenshotService);
      // Provide the mainWindow instance to the mcpService
      mcpService.setMainWindow(mainWindow);
      // Provide the screenshotService instance to the llmService
      llmService.setScreenshotService(screenshotService);
      // Provide the mainWindow instance to the llmService for IPC communication
      llmService.setMainWindow(mainWindow);
      
      console.log('All services initialized successfully');
    } catch (error) {
      console.error('Error initializing services:', error);
      console.error('Stack trace:', error.stack);
      dialog.showErrorBox('Initialization Error', `Failed to initialize services: ${error.message}`);
      throw error;
    }
  })();
  
  await serviceInitialization;

  // Initialize IPC handlers now that all services are ready
  initializeIpcHandlers({ llmService, mcpService, screenshotService, mainWindow });

  // Notify the renderer that all services are ready
  if (mainWindow && mainWindow.webContents) {
    const sendServicesReady = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('services-ready');
        logger.info('Services ready event sent to renderer.');
      }
    };

    // If window is still loading, wait for it to finish. Otherwise, send immediately.
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', sendServicesReady);
    } else {
      sendServicesReady();
    }
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
  logger.info('before-quit event received, cleaning up...');
  if (screenshotService) {
    screenshotService.stop();
  }
  if (mcpService) {
    await mcpService.cleanup();
  }
  logger.info('Cleanup complete.');
});
