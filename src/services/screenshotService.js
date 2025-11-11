class ScreenshotService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.isRunning = false;
    this.intervalId = null;
    this.callback = null;
    this.targetFPS = 15;
    this.frameInterval = 1000 / this.targetFPS; // ~67ms for 15 FPS
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPaused = false;
    this.lastScreenshot = null; // Cache the last screenshot for LLM reuse
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
      // Skip if paused
      if (this.isPaused) {
        return;
      }
      
      try {
        const screenshot = await this.mcpService.takeScreenshot();
        if (screenshot && this.callback) {
          // Cache the screenshot for LLM reuse
          this.lastScreenshot = screenshot;
          this.callback(screenshot);
          // Reset error counter on success
          this.consecutiveErrors = 0;
        }
      } catch (error) {
        // Special handling for client not available (during reconnection)
        if (error.code === 'CLIENT_NOT_AVAILABLE') {
          // Don't count as consecutive error, just skip this frame
          // Client will be available again after reconnection completes
          return;
        }
        
        this.consecutiveErrors++;
        console.error(`Error capturing screenshot (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);
        
        // If too many consecutive errors, pause the screenshot stream
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          console.warn(`Too many consecutive screenshot errors (${this.maxConsecutiveErrors}), pausing screenshot stream...`);
          this.pause();
          
          // Try to resume after 10 seconds
          setTimeout(() => {
            if (this.isRunning && this.isPaused) {
              console.log('Attempting to resume screenshot stream...');
              this.resume();
            }
          }, 10000);
        }
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

  pause() {
    if (!this.isPaused) {
      console.log('Pausing screenshot capture');
      this.isPaused = true;
    }
  }
  
  resume() {
    if (this.isPaused) {
      console.log('Resuming screenshot capture');
      this.isPaused = false;
      this.consecutiveErrors = 0;
    }
  }
  
  isActive() {
    return this.isRunning && !this.isPaused;
  }
  
  getLastScreenshot() {
    return this.lastScreenshot;
  }
}

module.exports = ScreenshotService;
