require('dotenv').config();
const logger = require('../utils/logger');

class MCPService {
  constructor() {
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.tools = [];
    this.isReconnecting = false;
    this.lastSuccessfulCall = null; // Will be set on first successful call
    this.lastFailedCall = null; // Track when last failure occurred
    this.healthCheckInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
  }

  async initialize() {
    try {
      console.log('Initializing MCP Service...');
      
      // Dynamically import MCP SDK (ES modules)
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      const { spawn } = require('child_process');
      const http = require('http');
      
      const serverPort = process.env.MCP_SERVER_PORT || 3000;
      
      // Start the MCP server manually with --port flag
      console.log(`Starting MCP server on port ${serverPort}...`);
      this.serverProcess = spawn('npx', ['@playwright/mcp@latest', '--browser', 'chrome', '--caps', 'vision', '--headless', '--port', serverPort.toString()], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      if (!this.serverProcess || !this.serverProcess.pid) {
        throw new Error('Failed to spawn MCP server process');
      }
      
      console.log(`MCP server process started with PID: ${this.serverProcess.pid}`);
      
      // Log any server output for debugging
      this.serverProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          logger.debug(`[MCP Server]: ${output}`);
        }
      });
      
      this.serverProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`MCP server process exited with code ${code}`);
        }
      });
      
      // Wait for server to be ready by polling the health endpoint with retry logic
      console.log('Waiting for MCP server to be ready...');
      const serverUrl = `http://localhost:${serverPort}`;

      const retry = async (fn, options) => {
        const { retries, factor, minTimeout, maxTimeout } = {
          retries: 15, // Approx 90 seconds total with backoff
          factor: 1.5,
          minTimeout: 500,
          maxTimeout: 10000,
          ...options,
        };

        let lastError;

        for (let i = 0; i < retries; i++) {
          try {
            return await fn();
          } catch (error) {
            lastError = error;
            const timeout = Math.min(maxTimeout, minTimeout * Math.pow(factor, i));
            logger.debug(`MCP health check attempt ${i + 1}/${retries} failed. Retrying in ${timeout}ms...`);
            await new Promise(resolve => setTimeout(resolve, timeout));
          }
        }
        throw new Error(`MCP server did not become ready after ${retries} attempts. Last error: ${lastError.message}`);
      };

      await retry(async () => {
        return new Promise((resolve, reject) => {
          const req = http.get(`${serverUrl}/health`, (res) => {
            // Any 2xx, 3xx, or 4xx status code indicates the server is running.
            if (res.statusCode >= 200 && res.statusCode < 500) {
              resolve();
            } else {
              reject(new Error(`Server not ready, status code: ${res.statusCode}`));
            }
          });
          req.on('error', (err) => reject(err));
          req.setTimeout(1000, () => {
            req.destroy();
            reject(new Error('Health check request timed out'));
          });
        });
      });
      
      console.log('MCP server is ready!');
      
      // Create SSE transport
      const sseUrl = `${serverUrl}/sse`;
      console.log(`Connecting to MCP server at ${sseUrl}...`);
      this.transport = new SSEClientTransport(new URL(sseUrl));

      this.client = new Client({
        name: 'conversational-playwright-client',
        version: '1.0.0'
      }, {
        capabilities: {
          tools: {}
        }
      });

      // Connect to the server via SSE
      console.log('Connecting to MCP server via SSE...');
      await this.client.connect(this.transport);
      console.log('Connected to MCP server successfully');

      // List available tools
      const toolsList = await this.client.listTools();
      const allTools = toolsList.tools || [];
      // Filter out the redundant browser_type tool to avoid confusion with browser_fill_form
      this.tools = allTools//.filter(tool => tool.name !== 'browser_type');
      console.log(`Available tools: ${this.tools.map(t => t.name).join(', ')}`);
      
      // Start health check monitoring
      this.startHealthCheck();

      return true;
    } catch (error) {
      console.error('Error initializing MCP service:', error);
      // Clean up on failure
      if (this.transport) {
        try {
          await this.transport.close();
        } catch (cleanupError) {
          console.error('Error cleaning up transport:', cleanupError);
        }
      }
      if (this.serverProcess) {
        this.serverProcess.kill();
        console.log('Killed MCP server process');
      }
      throw error;
    }
  }

  async getAvailableTools() {
    return this.tools;
  }

  async callTool(toolName, args, options = {}) {
    try {
      const isStreaming = options.isStreaming || false;
      
      // Check if client is available (might be null during reconnection)
      if (!this.client) {
        const error = new Error('MCP client not available (reconnecting or not initialized)');
        error.code = 'CLIENT_NOT_AVAILABLE';
        throw error;
      }
      
      // For screenshot calls from streaming service, only log at verbose level
      if (toolName === 'browser_take_screenshot' && isStreaming) {
        logger.verbose(`Calling tool: ${toolName} (streaming)`);
      } else {
        // For all other tools or LLM-invoked screenshots, log at info level
        logger.info(`Calling tool: ${toolName} with args:`, args);
      }
      
      const result = await this.client.callTool({
        name: toolName,
        arguments: args
      });
      
      // Update last successful call timestamp
      this.lastSuccessfulCall = Date.now();
      this.lastFailedCall = null; // Clear failure timestamp on success
      this.reconnectAttempts = 0; // Reset reconnect attempts on success
      
      // Similar logic for results
      if (toolName === 'browser_take_screenshot' && isStreaming) {
        logger.verbose(`Tool ${toolName} completed (streaming)`);
      } else {
        logger.info(`Tool ${toolName} result:`, result);
      }
      
      return result;
    } catch (error) {
      // Don't log client not available errors from streaming calls, they are expected during reconnect
      if (!(isStreaming && error.code === 'CLIENT_NOT_AVAILABLE')) {
        logger.error(`Error calling tool ${toolName}:`, error);
      }
      
      // Track last failed call
      this.lastFailedCall = Date.now();
      
      // Check if it's a timeout or connection error that warrants reconnection
      const isTimeoutError = error.code === -32001 || error.message?.includes('timeout');
      const isConnectionError = error.code === 'ECONNRESET' || error.message?.includes('fetch failed');
      
      if ((isTimeoutError || isConnectionError) && !this.isReconnecting) {
        logger.warn('Detected MCP server issue, attempting to reconnect...');
        await this.reconnect();
        
        // Retry the tool call once after reconnection
        if (this.client) {
          logger.info(`Retrying tool ${toolName} after reconnection...`);
          try {
            const result = await this.client.callTool({
              name: toolName,
              arguments: args
            });
            this.lastSuccessfulCall = Date.now();
            this.reconnectAttempts = 0;
            return result;
          } catch (retryError) {
            console.error(`Retry failed for tool ${toolName}:`, retryError);
            throw retryError;
          }
        }
      }
      
      throw error;
    }
  }

  async takeScreenshot() {
    try {
      const result = await this.callTool('browser_take_screenshot', {}, { isStreaming: true });

      // Added for diagnostics
      logger.verbose('[takeScreenshot] Raw result:', JSON.stringify(result));

      if (result && result.content && result.content.length > 0) {
        // The screenshot is returned as base64 in the content
        for (const content of result.content) {
          if (content.type === 'image') {
            logger.verbose('[takeScreenshot] Found image data, length:', content.data ? content.data.length : 0);
            return content.data; // Base64 image data
          }
        }
      }
      logger.verbose('[takeScreenshot] No image data found in result.');
      return null;
    } catch (error) {
      // If the client is not available (reconnecting), just re-throw without logging.
      // The ScreenshotService is designed to handle this gracefully.
      if (error.code === 'CLIENT_NOT_AVAILABLE') {
        throw error;
      }
      // For other errors, log them as they might be important.
      logger.error('Error taking screenshot:', error);
      throw error;
    }
  }

  async reconnect() {
    if (this.isReconnecting) {
      logger.warn('Reconnection already in progress, skipping...');
      return;
    }
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached, giving up`);
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    try {
      logger.info(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
      
      // Stop health check during reconnection
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      
      // Clean up existing connections
      logger.info('Cleaning up existing connections...');
      await this.cleanup();
      
      // Wait a bit before reconnecting (exponential backoff)
      const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
      logger.info(`Waiting ${backoffMs}ms before reconnecting...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      
      // Reinitialize
      logger.info('Reinitializing MCP service...');
      await this.initialize();
      
      logger.info('Reconnection successful!');
      this.reconnectAttempts = 0;
    } catch (error) {
      logger.error('Reconnection failed:', error);
    } finally {
      this.isReconnecting = false;
    }
  }
  
  startHealthCheck() {
    // Check health every 60 seconds
    this.healthCheckInterval = setInterval(() => {
      // Only run health check if:
      // 1. We've had at least one successful call (server has been used)
      // 2. We've had a recent failure
      // 3. It's been more than 2 minutes since last successful call
      // 4. We're not already reconnecting
      if (!this.lastSuccessfulCall || !this.lastFailedCall || this.isReconnecting) {
        return; // Skip health check
      }
      
      const timeSinceLastSuccess = Date.now() - this.lastSuccessfulCall;
      const timeSinceLastFailure = Date.now() - this.lastFailedCall;
      
      // Only check if we had a recent failure (within last 5 minutes) and no success in 2 minutes
      if (timeSinceLastFailure < 300000 && timeSinceLastSuccess > 120000) {
        logger.warn('Detected potential MCP server issue, running health check...');
        
        // Try a simple tool call to check if server is responsive
        this.callTool('browser_console_messages', {}, { isStreaming: true })
          .then(() => {
            logger.verbose('Health check passed');
          })
          .catch((error) => {
            logger.warn('Health check failed:', error.message);
            // Don't trigger reconnect here - let the callTool error handler do it
          });
      }
    }, 60000); // Check every 60 seconds instead of 30
  }

  async cleanup() {
    try {
      // Stop health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      
      if (this.client) {
        try {
          await this.client.close();
        } catch (err) {
          logger.debug('Error closing client:', err.message);
        }
      }
      if (this.transport) {
        try {
          await this.transport.close();
        } catch (err) {
          logger.debug('Error closing transport:', err.message);
        }
      }
      if (this.serverProcess) {
        try {
          this.serverProcess.kill('SIGTERM');
          // Wait a bit for graceful shutdown
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Force kill if still running
          if (!this.serverProcess.killed) {
            this.serverProcess.kill('SIGKILL');
          }
          console.log('MCP server process terminated');
        } catch (err) {
          logger.debug('Error killing server process:', err.message);
        }
      }
      
      // Reset state
      this.client = null;
      this.transport = null;
      this.serverProcess = null;
      
      console.log('MCP service cleaned up');
    } catch (error) {
      console.error('Error cleaning up MCP service:', error);
    }
  }
}

module.exports = MCPService;
