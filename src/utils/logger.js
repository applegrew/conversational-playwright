// Simple logger with configurable log levels
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  VERBOSE: 4
};

class Logger {
  constructor() {
    // Get log level from environment variable, default to INFO
    const envLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.level = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.INFO;
    
    console.log(`[Logger] Log level set to: ${envLevel} (${this.level})`);
  }

  error(...args) {
    if (this.level >= LOG_LEVELS.ERROR) {
      console.error('[ERROR]', ...args);
    }
  }

  warn(...args) {
    if (this.level >= LOG_LEVELS.WARN) {
      console.warn('[WARN]', ...args);
    }
  }

  info(...args) {
    if (this.level >= LOG_LEVELS.INFO) {
      console.log('[INFO]', ...args);
    }
  }

  debug(...args) {
    if (this.level >= LOG_LEVELS.DEBUG) {
      console.log('[DEBUG]', ...args);
    }
  }

  verbose(...args) {
    if (this.level >= LOG_LEVELS.VERBOSE) {
      console.log('[VERBOSE]', ...args);
    }
  }

  // Convenience method to check if verbose logging is enabled
  isVerbose() {
    return this.level >= LOG_LEVELS.VERBOSE;
  }

  isDebug() {
    return this.level >= LOG_LEVELS.DEBUG;
  }
}

// Export a singleton instance
module.exports = new Logger();
