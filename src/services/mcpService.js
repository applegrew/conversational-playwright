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
      this.serverProcess = spawn('npx', ['@playwright/mcp@latest', '--browser', 'chrome', '--headless', '--port', serverPort.toString()], {
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
      
      // Wait for server to be ready by testing the HTTP endpoint
      console.log('Waiting for MCP server to be ready...');
      const serverUrl = `http://localhost:${serverPort}`;
      const maxAttempts = 180;
      let attempts = 0;
      let serverReady = false;
      
      while (attempts < maxAttempts && !serverReady) {
        try {
          await new Promise((resolve, reject) => {
            const req = http.get(`${serverUrl}/health`, (res) => {
              if (res.statusCode === 200 || res.statusCode === 404 || res.statusCode === 400) {
                // 404/400 is ok - server is running, just no /health endpoint
                serverReady = true;
              }
              resolve();
            });
            req.on('error', () => resolve()); // Ignore errors, will retry
            req.setTimeout(500, () => {
              req.destroy();
              resolve();
            });
          });
        } catch (err) {
          console.warn('MCP server health check failed:', err);
        }
        
        if (!serverReady) {
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        }
      }
      
      if (!serverReady) {
        throw new Error(`MCP server did not start within ${maxAttempts * 0.5} seconds`);
      }
      
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
      this.tools = toolsList.tools || [];
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
      console.error(`Error calling tool ${toolName}:`, error);
      
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
      // Use the browser_take_screenshot tool from @playwright/mcp
      // Pass isStreaming flag to suppress logs at INFO level
      const result = await this.callTool('browser_take_screenshot', {
        type: 'png'
      }, { isStreaming: true });
      
      logger.verbose('Screenshot result:', result ? 'received' : 'null');
      if (result && result.content) {
        logger.verbose('Screenshot content length:', result.content.length);
        logger.verbose('Screenshot content types:', result.content.map(c => c.type));
      }
      
      if (result && result.content && result.content.length > 0) {
        // The screenshot is returned as base64 in the content
        for (const content of result.content) {
          if (content.type === 'image') {
            logger.verbose('Found image content, data length:', content.data ? content.data.length : 0);
            return content.data; // Base64 image data
          } else if (content.type === 'text') {
            // Try to extract base64 from text
            const match = content.text.match(/data:image\/png;base64,(.+)/);
            if (match) {
              logger.verbose('Found base64 in text, length:', match[1].length);
              return match[1];
            }
          }
        }
      }
      logger.verbose('No screenshot data found');
      return null;
    } catch (error) {
      console.error('Error taking screenshot:', error);
      return null;
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
