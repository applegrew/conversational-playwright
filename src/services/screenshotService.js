const logger = require('../utils/logger');
const { createCanvas, loadImage } = require('canvas');

class ScreenshotService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.isRunning = false;
    this.intervalId = null;
    this.callback = null;
    // Adaptive FPS settings
    this.minFPS = 2;  // Minimum FPS when idle (no changes)
    this.maxFPS = 15; // Maximum FPS when active (rapid changes)
    this.currentFPS = this.maxFPS; // Start at max FPS
    this.frameInterval = 1000 / this.currentFPS;
    // Change detection
    this.consecutiveUnchangedFrames = 0;
    this.unchangedThreshold = 3; // Slow down after 3 unchanged frames
    this.lastScreenshot = null; // Cache the last screenshot for LLM reuse
    this.previousScreenshot = null; // For change detection
    // Error handling
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPaused = false;
    // Click indicator for visual feedback
    this.clickIndicator = null; // { x, y, timestamp }
    this.clickIndicatorDuration = 10000; // Show for 10 seconds
    this.clickIndicatorRadius = 20; // Red dot radius in pixels
  }

  start(callback) {
    if (this.isRunning) {
      console.log('Screenshot service already running');
      return;
    }

    this.isRunning = true;
    this.callback = callback;
    this.currentFPS = this.maxFPS; // Start at max FPS
    this.frameInterval = 1000 / this.currentFPS;
    
    console.log(`Starting adaptive screenshot capture (${this.minFPS}-${this.maxFPS} FPS)`);
    
    this.captureLoop();
  }
  
  async captureLoop() {
    if (!this.isRunning) {
      return;
    }
    
    const captureStart = Date.now();
    
    // Capture screenshot
    await this.captureFrame();
    
    // Calculate next capture time based on current FPS
    const captureTime = Date.now() - captureStart;
    const nextInterval = Math.max(this.frameInterval - captureTime, 0);
    
    // Schedule next capture
    setTimeout(() => this.captureLoop(), nextInterval);
  }
  
  async captureFrame() {
    // Skip if paused
    if (this.isPaused) {
      return;
    }
    
    try {
      let screenshot = await this.mcpService.takeScreenshot();
      
      if (screenshot && this.callback) {
        // Check if we should draw a click indicator
        if (this.clickIndicator && this.shouldShowClickIndicator()) {
          screenshot = await this.drawClickIndicator(screenshot);
        }
        
        // Detect if screenshot changed
        const hasChanged = this.detectChange(screenshot);
        
        // Adjust FPS based on changes
        this.adjustFPS(hasChanged);
        
        // Cache the screenshots
        this.previousScreenshot = this.lastScreenshot;
        this.lastScreenshot = screenshot;
        
        this.callback(screenshot);
        // Reset error counter on success
        this.consecutiveErrors = 0;
      }
    } catch (error) {
      // Special handling for client not available (during reconnection)
      if (error.code === 'CLIENT_NOT_AVAILABLE') {
        // Don't count as consecutive error, just skip this frame
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
  }
  
  /**
   * Detect if screenshot has changed from previous one
   * Simple comparison: if base64 strings are different, it changed
   */
  detectChange(currentScreenshot) {
    if (!this.previousScreenshot) {
      return true; // First screenshot, assume change
    }
    
    // Simple string comparison (base64)
    // For more sophisticated detection, could use image diff libraries
    return currentScreenshot !== this.previousScreenshot;
  }
  
  /**
   * Adjust FPS based on whether content is changing
   */
  adjustFPS(hasChanged) {
    if (hasChanged) {
      // Content changed - increase to max FPS
      this.consecutiveUnchangedFrames = 0;
      if (this.currentFPS !== this.maxFPS) {
        this.currentFPS = this.maxFPS;
        this.frameInterval = 1000 / this.currentFPS;
        logger.verbose(`[Adaptive FPS] Content changing → ${this.currentFPS} FPS`);
      }
    } else {
      // Content unchanged
      this.consecutiveUnchangedFrames++;
      
      // After threshold, reduce FPS gradually
      if (this.consecutiveUnchangedFrames >= this.unchangedThreshold) {
        const newFPS = Math.max(
          this.minFPS,
          this.currentFPS - 1 // Decrease by 1 FPS
        );
        
        if (newFPS !== this.currentFPS) {
          this.currentFPS = newFPS;
          this.frameInterval = 1000 / this.currentFPS;
          logger.verbose(`[Adaptive FPS] No changes detected → ${this.currentFPS} FPS`);
        }
      }
    }
  }
  
  // OLD setInterval-based code removed, replaced with captureLoop
  startOld(callback) {
    if (this.isRunning) {
      console.log('Screenshot service already running');
      return;
    }

    this.isRunning = true;
    this.callback = callback;
    
    console.log(`Starting screenshot capture at ${this.currentFPS} FPS`);
    
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
    
    // No need to clear interval anymore since we use setTimeout in loop
    this.isRunning = false;
    this.callback = null;
    this.previousScreenshot = null;
    this.consecutiveUnchangedFrames = 0;
  }

  setFPS(minFPS, maxFPS) {
    // Update adaptive FPS range
    if (minFPS !== undefined) {
      this.minFPS = minFPS;
    }
    if (maxFPS !== undefined) {
      this.maxFPS = maxFPS;
    }
    
    console.log(`[Adaptive FPS] Range updated: ${this.minFPS}-${this.maxFPS} FPS`);
    
    // Clamp current FPS to new range
    this.currentFPS = Math.max(this.minFPS, Math.min(this.maxFPS, this.currentFPS));
    this.frameInterval = 1000 / this.currentFPS;
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
  
  /**
   * Set a click indicator to be drawn on screenshots
   * @param {number} x - X coordinate in pixels
   * @param {number} y - Y coordinate in pixels
   */
  setClickIndicator(x, y) {
    this.clickIndicator = {
      x,
      y,
      timestamp: Date.now()
    };
    logger.info(`[Click Indicator] Set indicator at (${x}, ${y}) - will show for ${this.clickIndicatorDuration}ms`);
  }
  
  /**
   * Check if the click indicator should be shown
   * @returns {boolean}
   */
  shouldShowClickIndicator() {
    if (!this.clickIndicator) {
      return false;
    }
    
    const elapsed = Date.now() - this.clickIndicator.timestamp;
    if (elapsed > this.clickIndicatorDuration) {
      logger.verbose('[Click Indicator] Duration expired, removing indicator');
      this.clickIndicator = null;
      return false;
    }
    
    return true;
  }
  
  /**
   * Draw a red dot on the screenshot at the click indicator position
   * @param {string} screenshotBase64 - Base64 encoded screenshot
   * @returns {Promise<string>} - Modified screenshot with red dot
   */
  async drawClickIndicator(screenshotBase64) {
    try {
      // Remove data URL prefix if present
      const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      
      // Load the image
      const img = await loadImage(imageBuffer);
      
      // Create a canvas with the same dimensions
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      
      // Draw the original screenshot
      ctx.drawImage(img, 0, 0);
      
      // Draw the red dot
      const { x, y } = this.clickIndicator;
      
      // Draw outer circle (slightly transparent red)
      ctx.beginPath();
      ctx.arc(x, y, this.clickIndicatorRadius, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.fill();
      
      // Draw inner circle (solid red)
      ctx.beginPath();
      ctx.arc(x, y, this.clickIndicatorRadius / 2, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
      ctx.fill();
      
      // Draw white border
      ctx.beginPath();
      ctx.arc(x, y, this.clickIndicatorRadius, 0, 2 * Math.PI);
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Convert back to base64
      const modifiedBase64 = canvas.toBuffer('image/png').toString('base64');
      
      logger.verbose(`[Click Indicator] Drew red dot at (${x}, ${y})`);
      return modifiedBase64;
    } catch (error) {
      logger.error('[Click Indicator] Failed to draw indicator:', error.message);
      // Return original screenshot on error
      return screenshotBase64;
    }
  }
}

module.exports = ScreenshotService;
