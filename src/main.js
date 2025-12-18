require('dotenv').config();
const { app, BrowserWindow, dialog } = require('electron/main');
const path = require('node:path');
const logger = require('./utils/logger');
const { initializeIpcHandlers } = require('./ipcManager');

let mainWindow;
let mcpService;
let llmService;
let screenshotService;
let playbookService;

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
  // Parse command line arguments
  const args = process.argv.slice(1); // Skip electron executable
  let playbookPath = null;
  let zoomPercent = null;
  
  // Look for -p flag
  const pIndex = args.indexOf('-p');
  if (pIndex !== -1 && pIndex + 1 < args.length) {
    playbookPath = args[pIndex + 1];
    console.log(`[Main] Playbook mode: ${playbookPath}`);
  }

  // Look for -z flag (zoom percent)
  const zIndex = args.indexOf('-z');
  if (zIndex !== -1 && zIndex + 1 < args.length) {
    const rawZoom = args[zIndex + 1];
    const parsed = Number.parseFloat(rawZoom);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.warn(`[Main] Ignoring invalid zoom percent for -z: ${rawZoom}`);
    } else {
      zoomPercent = parsed;
    }
  }

  // Translate zoom percent to viewport size.
  // 0% zoom means base viewport (1920x1080).
  // 400% zoom means 4x zoom => viewport divided by 4.
  if (zoomPercent !== null && zoomPercent !== 0) {
    const baseWidth = 1920;
    const baseHeight = 1080;
    const zoomFactor = zoomPercent / 100;

    if (zoomFactor > 0) {
      const width = Math.max(1, Math.round(baseWidth / zoomFactor));
      const height = Math.max(1, Math.round(baseHeight / zoomFactor));
      process.env.MCP_VIEWPORT_SIZE = `${width}x${height}`;
      console.log(`[Main] Zoom: ${zoomPercent}% -> MCP viewport: ${process.env.MCP_VIEWPORT_SIZE}`);
    } else {
      console.warn(`[Main] Ignoring zoom percent ${zoomPercent} because it results in invalid zoomFactor ${zoomFactor}`);
    }
  }
  
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
      
      // Create playbook service if needed
      if (playbookPath) {
        console.log('Creating Playbook service...');
        const PlaybookService = require('./services/playbookService');
        playbookService = new PlaybookService(llmService, mainWindow);
        console.log('Playbook service created');
      }
      
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
  initializeIpcHandlers({ llmService, mcpService, screenshotService, playbookService, mainWindow });

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
  
  // Execute playbook if -p flag was provided
  if (playbookPath && playbookService) {
    logger.info(`[Main] Starting playbook execution: ${playbookPath}`);
    try {
      // Wait a moment for UI to be fully ready
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Execute the playbook
      await playbookService.executePlaybook(playbookPath);
      logger.info('[Main] Playbook execution completed');
    } catch (error) {
      logger.error('[Main] Playbook execution failed:', error);
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
