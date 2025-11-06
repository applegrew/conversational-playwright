class ScreenshotService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.isRunning = false;
    this.intervalId = null;
    this.callback = null;
    this.targetFPS = 15;
    this.frameInterval = 1000 / this.targetFPS; // ~67ms for 15 FPS
  }

  start(callback) {
    if (this.isRunning) {
      console.log('Screenshot service already running');
      return;
    }

    this.isRunning = true;
    this.callback = callback;
    
    console.log(`Starting screenshot capture at ${this.targetFPS} FPS`);
    
    // Capture screenshots at the specified FPS
    this.intervalId = setInterval(async () => {
      try {
        const screenshot = await this.mcpService.takeScreenshot();
        if (screenshot && this.callback) {
          this.callback(screenshot);
        }
      } catch (error) {
        console.error('Error capturing screenshot:', error);
      }
    }, this.frameInterval);
  }

  stop() {
    if (!this.isRunning) {
      console.log('Screenshot service not running');
      return;
    }

    console.log('Stopping screenshot capture');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    this.isRunning = false;
    this.callback = null;
  }

  setFPS(fps) {
    const wasRunning = this.isRunning;
    const currentCallback = this.callback;
    
    if (wasRunning) {
      this.stop();
    }
    
    this.targetFPS = fps;
    this.frameInterval = 1000 / fps;
    
    if (wasRunning && currentCallback) {
      this.start(currentCallback);
    }
  }

  isActive() {
    return this.isRunning;
  }
}

module.exports = ScreenshotService;
