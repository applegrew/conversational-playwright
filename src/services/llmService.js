const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI, Type } = require('@google/genai');
const { PNG } = require('pngjs');
require('dotenv').config();
const logger = require('../utils/logger');

class LLMService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.provider = null;
    this.conversationHistory = [];
    this.model = null; // For Gemini or Claude
    this.anthropic = null; // For Claude
    this.screenshotService = null; // Will be set by main.js
    this.lastActionScreenshot = null; // Screenshot before last action for visual diff
    this.mainWindow = null; // Will be set by main.js for IPC communication
    this.actionLog = []; // Track all actions for Playwright script generation
    this.cancelRequested = false; // Flag to cancel ongoing execution
    this.isExecuting = false; // Track if LLM is currently executing
    this.isPlaybookMode = false; // Track if we're executing a playbook
    this.validationResults = []; // Track all validation results for assertions/validations
  }

  async initialize() {
    // Check LLM_PROVIDER env var first for explicit selection
    const explicitProvider = process.env.LLM_PROVIDER?.toLowerCase();
    
    if (explicitProvider === 'fara' && process.env.FARA_REST) {
      this.provider = 'fara';
      this.faraBaseUrl = process.env.FARA_REST;
      console.log(`Using Fara (local) as LLM provider at ${this.faraBaseUrl}`);
    } else if (process.env.GEMINI_API_KEY) {
      this.provider = 'gemini';
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      this.modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
      console.log(`Using Gemini (${this.modelName}) as LLM provider`);
    } else if (process.env.ANTHROPIC_API_KEY) {
      this.provider = 'claude';
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      console.log('Using Claude as LLM provider');
    } else if (process.env.FARA_REST) {
      // Fallback to Fara if FARA_REST is set but no explicit provider
      this.provider = 'fara';
      this.faraBaseUrl = process.env.FARA_REST;
      console.log(`Using Fara (local) as LLM provider at ${this.faraBaseUrl}`);
    } else {
      this.provider = 'none';
      console.warn('No LLM provider configured. Please set GEMINI_API_KEY, ANTHROPIC_API_KEY, or FARA_REST in .env');
    }
  }

  async processMessage(userMessage) {
    // Reset cancellation flag for new message
    this.cancelRequested = false;
    
    try {
      // Set executing flag
      this.isExecuting = true;
      logger.info('[LLM Service] Starting message processing');
      
      if (this.provider === 'gemini') {
        return await this.processMessageGemini(userMessage);
      } else if (this.provider === 'claude') {
        return await this.processMessageClaude(userMessage);
      } else if (this.provider === 'fara') {
        return await this.processMessageFara(userMessage);
      } else {
        throw new Error('No active LLM provider to process message. Please set GEMINI_API_KEY, ANTHROPIC_API_KEY, or FARA_REST in .env');
      }
    } finally {
      // Always clear executing flag, even if error occurs
      this.isExecuting = false;
      logger.info('[LLM Service] Message processing completed');
    }
  }

  async getLLMProvider() {
    return { provider: this.provider };
  }
  
  setScreenshotService(service) {
    this.screenshotService = service;
  }
  
  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }

  /**
   * Set playbook execution mode
   * @param {boolean} isPlaybook - True if executing a playbook
   */
  setPlaybookMode(isPlaybook) {
    this.isPlaybookMode = isPlaybook;
  }

  /**
   * Cancel the ongoing LLM execution
   */
  cancelExecution() {
    logger.info('[LLM Service] Cancellation requested');
    this.cancelRequested = true;
  }

  generateToolId() {
    return `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  emitToolEvent(eventName, data) {
    if (this.mainWindow && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(eventName, data);
    }
  }

  /**
   * Send a message to the renderer to display in the UI
   * @param {string} message - The message to display
   */
  sendAssistantMessage(message) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('show-assistant-message', message);
    } else {
      logger.warn('Cannot send assistant message: mainWindow not available');
    }
  }
  
  /**
   * Compare two base64 screenshots and detect visual changes
   * @param {string} beforeBase64 - Base64 encoded PNG screenshot before action
   * @param {string} afterBase64 - Base64 encoded PNG screenshot after action
   * @returns {object} - { changed: boolean, percentDiff: number, pixelsDiff: number }
   */
  async compareScreenshots(beforeBase64, afterBase64, toolName = null) {
    try {
      if (!beforeBase64 || !afterBase64) {
        return { changed: false, percentDiff: 0, pixelsDiff: 0, error: 'Missing screenshots' };
      }
      
      // Dynamically import pixelmatch (ES module)
      const pixelmatch = (await import('pixelmatch')).default;
      
      // Convert base64 to buffers
      const beforeBuffer = Buffer.from(beforeBase64, 'base64');
      const afterBuffer = Buffer.from(afterBase64, 'base64');
      
      // Parse PNG images
      const beforePng = PNG.sync.read(beforeBuffer);
      const afterPng = PNG.sync.read(afterBuffer);
      
      // Check if dimensions match
      if (beforePng.width !== afterPng.width || beforePng.height !== afterPng.height) {
        return { changed: true, percentDiff: 100, pixelsDiff: -1, error: 'Dimension mismatch' };
      }
      
      const { width, height } = beforePng;
      const diff = new PNG({ width, height });
      
      // Compare images using pixelmatch
      const numDiffPixels = pixelmatch(
        beforePng.data,
        afterPng.data,
        diff.data,
        width,
        height,
        { threshold: 0.1 } // 0.1 = 10% tolerance for minor anti-aliasing differences
      );
      
      const totalPixels = width * height;
      const percentDiff = (numDiffPixels / totalPixels * 100).toFixed(2);
      
      // Use lower threshold for form-filling tools as they have subtle changes
      // Form fields with light text or password dots may show minimal pixel differences
      const isFormTool = toolName && ['browser_fill_form', 'browser_type'].includes(toolName);
      const changeThreshold = isFormTool ? 0.1 : 0.5; // 0.1% for forms, 0.5% for others
      
      // Consider changed if more than threshold of pixels differ
      const changed = percentDiff > changeThreshold;
      
      return {
        changed,
        percentDiff: parseFloat(percentDiff),
        pixelsDiff: numDiffPixels,
        totalPixels
      };
    } catch (error) {
      console.error('Error comparing screenshots:', error.message);
      return { changed: false, percentDiff: 0, pixelsDiff: 0, error: error.message };
    }
  }

  async processMessageClaude(userMessage) {
    try {
      console.log('Processing message with Claude:', userMessage);
      
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage
      });

      // Get available tools from MCP
      const tools = await this.mcpService.getAvailableTools();
      
      // Convert MCP tools to Anthropic tool format
      const anthropicTools = tools.map(tool => ({
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        input_schema: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: []
        }
      }));

      // Create system prompt
      const systemPrompt = `You are a helpful AI assistant that can control a web browser using Playwright tools.
You have access to various browser automation tools through the Model Context Protocol (MCP).

Available tools:
${tools.map(t => `- ${t.name}: ${t.description || 'Browser automation tool'}`).join('\n')}

When the user asks you to perform browser tasks, use the appropriate tools to accomplish them.
Be conversational and explain what you're doing. If you need to navigate, click, type, or take screenshots, use the available tools.

Always respond in a helpful and friendly manner.`;

      // Call Claude with tool use
      let response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemPrompt,
        messages: this.conversationHistory,
        tools: anthropicTools
      });

      console.log('Claude response:', JSON.stringify(response, null, 2));

      // Process tool calls if any
      while (response.stop_reason === 'tool_use') {
        const toolUseBlock = response.content.find(block => block.type === 'tool_use');
        
        if (toolUseBlock) {
          console.log(`Executing tool: ${toolUseBlock.name}`);
          
          // Execute the tool via MCP
          const toolResult = await this.mcpService.callTool(
            toolUseBlock.name,
            toolUseBlock.input
          );

          // Add assistant response with tool use to history
          this.conversationHistory.push({
            role: 'assistant',
            content: response.content
          });

          // Add tool result to history
          this.conversationHistory.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: JSON.stringify(toolResult)
            }]
          });

          // Get next response from Claude
          response = await this.anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4096,
            system: systemPrompt,
            messages: this.conversationHistory,
            tools: anthropicTools
          });

          console.log('Claude follow-up response:', JSON.stringify(response, null, 2));
        } else {
          break;
        }
      }

      // Extract text response
      const textContent = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      // Add final assistant response to history
      if (response.stop_reason !== 'tool_use') {
        this.conversationHistory.push({
          role: 'assistant',
          content: textContent
        });
      }

      // Keep conversation history manageable (last 20 messages)
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      return textContent || 'I executed the requested action.';
    } catch (error) {
      console.error('Error processing message with Claude:', error);
      
      if (error.message && error.message.includes('API key')) {
        const apiKeyError = new Error('Please set your ANTHROPIC_API_KEY in the .env file.');
        apiKeyError.status = 401;
        apiKeyError.statusText = 'Unauthorized';
        throw apiKeyError;
      }
      
      // Re-throw the error to be handled by main.js
      throw error;
    }
  }

  /**
   * Get the system prompt for Fara model (Microsoft's Computer Use Agent)
   * Adapted from magentic-ui prompts for browser-only access
   * @returns {string} The Fara system prompt
   */
  getFaraSystemPrompt() {
    // Get screen dimensions from screenshot service if available
    const screenWidth = this.screenshotService?.lastScreenshotDimensions?.scaledWidth || 1024;
    const screenHeight = this.screenshotService?.lastScreenshotDimensions?.scaledHeight || 768;
    
    // Build the computer_use function definition (NousFnCallPrompt format)
    const computerUseFunction = {
      type: "function",
      function: {
        name: "computer_use",
        description: "Use mouse and keyboard to interact with a web browser. The browser viewport is " + screenWidth + "x" + screenHeight + " pixels.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["left_click", "type", "key", "scroll", "mouse_move", "visit_url", "web_search", "history_back", "wait", "terminate"],
              description: "The action to perform"
            },
            coordinate: {
              type: "array",
              items: { type: "integer" },
              description: "For left_click, type, mouse_move: [x, y] pixel coordinates"
            },
            ref: {
              type: "string",
              description: "For left_click, type: element reference like 'e42' from page snapshot"
            },
            text: {
              type: "string",
              description: "For type: the text to type"
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "For key: keys to press, e.g. ['Enter'], ['Control', 'a']"
            },
            pixels: {
              type: "integer",
              description: "For scroll: positive=up, negative=down"
            },
            url: {
              type: "string",
              description: "For visit_url: the URL to navigate to"
            },
            query: {
              type: "string",
              description: "For web_search: the search query"
            },
            time: {
              type: "integer",
              description: "For wait: seconds to wait"
            },
            status: {
              type: "string",
              enum: ["success", "failure"],
              description: "For terminate: the task status"
            },
            answer: {
              type: "string",
              description: "For terminate: brief description of what was done"
            }
          },
          required: ["action"]
        }
      }
    };
    
    return `You are a helpful assistant.

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${JSON.stringify(computerUseFunction)}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": "computer_use", "arguments": {"action": "visit_url", "url": "https://example.com"}}
</tool_call>

# Browser Interface

- Viewport: ${screenWidth}x${screenHeight} pixels
- When you click, a red dot shows where you clicked on the next screenshot
- Use element refs (e.g., ref="e42") from the Page Snapshot for reliable targeting
- Use coordinates for images, canvas, or when refs don't work

# Page Snapshot

The snapshot shows interactive elements:
\`\`\`yaml
- button "Sign In" [ref=e34]
- textbox "Email" [ref=e56]
\`\`\`

# Instructions

1. Look at the screenshot to understand the current state
2. Execute the action requested by the user
3. After the action succeeds, call terminate with status="success"
`;
  }

  /**
   * Parse Fara's tool call from its response text
   * Fara outputs tool calls in JSON format (may be wrapped in code blocks)
   * @param {string} text - The response text from Fara
   * @returns {object|null} Parsed tool call or null if none found
   */
  parseFaraToolCall(text) {
    if (!text) return null;
    
    // Try to find JSON block in various formats Fara might output
    // Order matters - more specific patterns first
    const patterns = [
      // <tool_call> {...} </tool_call> format (most common for Fara)
      /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/i,
      // ```json {...}``` format
      /```(?:json)?\s*(\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\})\s*```/,
      // Raw JSON with computer_use
      /(\{[\s\S]*?"name"\s*:\s*"computer_use"[\s\S]*?"arguments"[\s\S]*?\})/,
      // Any JSON with name and arguments
      /(\{[\s\S]*?"name"\s*:\s*"[^"]*"[\s\S]*?"arguments"[\s\S]*?\})/
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed.name && parsed.arguments) {
            logger.debug('[Fara] Parsed tool call:', JSON.stringify(parsed));
            return parsed;
          }
        } catch (e) {
          logger.debug('[Fara] Failed to parse JSON match:', e.message);
        }
      }
    }
    
    // Try parsing the entire text as JSON (in case it's a clean response)
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed.name && parsed.arguments) {
        return parsed;
      }
    } catch (e) {
      // Not valid JSON
    }
    
    logger.debug('[Fara] No tool call found in response');
    return null;
  }

  /**
   * Map Fara's computer_use action to MCP tool
   * @param {object} action - Fara's action object (with action type and params)
   * @returns {object} MCP tool call {name, args}
   */
  mapFaraActionToMCP(action) {
    const { action: actionType, ...params } = action;
    
    // Normalize action type (handle case variations)
    const normalizedAction = actionType?.toLowerCase()?.replace(/[_-]/g, '');
    
    switch (normalizedAction) {
      // Navigation actions
      case 'visiturl':
      case 'visit':
      case 'goto':
      case 'navigate':
      case 'open':
        return {
          name: 'browser_navigate',
          args: { url: params.url }
        };
      
      case 'websearch':
      case 'search':
      case 'googlesearch':
        // Navigate to Google with search query
        return {
          name: 'browser_navigate',
          args: { url: `https://www.bing.com/search?q=${encodeURIComponent(params.query)}&FORM=QBLH` }
        };
      
      // Click actions
      case 'leftclick':
      case 'click':
      case 'singleclick':
      case 'tap':
        // Support both coordinate-based and ref-based clicks
        if (params.ref) {
          // Use browser_click with ref from page snapshot
          return {
            name: 'browser_click',
            args: { 
              ref: params.ref,
              element: params.element || `element ${params.ref}`
            }
          };
        }
        if (params.coordinate && Array.isArray(params.coordinate)) {
          return {
            name: 'browser_mouse_click_xy',
            args: { 
              x: params.coordinate[0], 
              y: params.coordinate[1],
              element: params.element || `element at (${params.coordinate[0]}, ${params.coordinate[1]})`
            }
          };
        }
        // Support x, y params directly (alternative format)
        if (params.x !== undefined && params.y !== undefined) {
          return {
            name: 'browser_mouse_click_xy',
            args: { 
              x: params.x, 
              y: params.y,
              element: params.element || `element at (${params.x}, ${params.y})`
            }
          };
        }
        return null;
      
      case 'rightclick':
        // Right click support (coordinate-based)
        if (params.coordinate && Array.isArray(params.coordinate)) {
          return {
            name: 'browser_mouse_click_xy',
            args: { 
              x: params.coordinate[0], 
              y: params.coordinate[1],
              button: 'right',
              element: params.element || `right click at (${params.coordinate[0]}, ${params.coordinate[1]})`
            }
          };
        }
        return null;
      
      case 'doubleclick':
        if (params.coordinate && Array.isArray(params.coordinate)) {
          return {
            name: 'browser_mouse_click_xy',
            args: { 
              x: params.coordinate[0], 
              y: params.coordinate[1],
              clickCount: 2,
              element: params.element || `double click at (${params.coordinate[0]}, ${params.coordinate[1]})`
            }
          };
        }
        return null;
      
      case 'mousemove':
      case 'hover':
      case 'moveto':
        if (params.coordinate && Array.isArray(params.coordinate)) {
          return {
            name: 'browser_mouse_move',
            args: { 
              x: params.coordinate[0], 
              y: params.coordinate[1],
              element: params.element || `element at (${params.coordinate[0]}, ${params.coordinate[1]})`
            }
          };
        }
        return null;
      
      // Text input actions
      case 'type':
      case 'input':
      case 'entertext':
      case 'fill': {
        // Fara's type action can include coordinate to click field first
        // Or use ref from page snapshot like [ref=e42]
        const refValue = params.ref || params.element;
        
        // If coordinate is provided, need to click first then type
        if (params.coordinate && Array.isArray(params.coordinate)) {
          // Return a special action that indicates click-then-type
          return {
            name: '_type_with_click',
            args: {
              x: params.coordinate[0],
              y: params.coordinate[1],
              text: params.text || params.content || '',
              pressEnter: params.press_enter || params.submit || false,
              clearFirst: params.delete_existing_text || false,
              element: `input at (${params.coordinate[0]}, ${params.coordinate[1]})`
            }
          };
        }
        
        return {
          name: 'browser_type',
          args: { 
            ref: refValue,
            text: params.text || params.content || '',
            submit: params.press_enter || params.submit || false,
            slowly: params.delete_existing_text || false, // Use slowly to clear first
            element: `input field ${refValue}`  // Required by MCP tool
          }
        };
      }
      
      // Keyboard actions
      case 'key':
      case 'presskey':
      case 'keypress':
      case 'keyboard': {
        // Handle both array and single key
        let keys = params.keys || params.key;
        if (!Array.isArray(keys)) {
          keys = [keys];
        }
        // Map Fara key names to Playwright key names
        const keyMap = {
          'Enter': 'Enter',
          'Return': 'Enter',
          'Tab': 'Tab',
          'Escape': 'Escape',
          'Esc': 'Escape',
          'Backspace': 'Backspace',
          'Delete': 'Delete',
          'ArrowUp': 'ArrowUp',
          'Up': 'ArrowUp',
          'ArrowDown': 'ArrowDown',
          'Down': 'ArrowDown',
          'ArrowLeft': 'ArrowLeft',
          'Left': 'ArrowLeft',
          'ArrowRight': 'ArrowRight',
          'Right': 'ArrowRight',
          'PageUp': 'PageUp',
          'PageDown': 'PageDown',
          'Control': 'Control',
          'Ctrl': 'Control',
          'Alt': 'Alt',
          'Shift': 'Shift',
          'Space': 'Space',
          'Home': 'Home',
          'End': 'End'
        };
        const key = keys.map(k => keyMap[k] || k).join('+');
        return {
          name: 'browser_press_key',
          args: { key }
        };
      }
      
      // Scroll actions
      case 'scroll':
      case 'scrollpage': {
        // Support multiple scroll formats:
        // 1. pixels (positive=up, negative=down)
        // 2. direction + amount
        // 3. direction only (use default amount)
        let direction, amount;
        
        if (params.pixels !== undefined) {
          direction = params.pixels > 0 ? 'up' : 'down';
          amount = Math.abs(params.pixels);
        } else if (params.direction) {
          direction = params.direction;
          amount = params.amount || 300;
        } else {
          // Default scroll down
          direction = 'down';
          amount = 300;
        }
        
        return {
          name: 'browser_scroll',
          args: { direction, amount }
        };
      }
      
      // Navigation history
      case 'historyback':
      case 'goback':
      case 'back':
        return {
          name: 'browser_navigate_back',
          args: {}
        };
      
      case 'historyforward':
      case 'goforward':
      case 'forward':
        return {
          name: 'browser_navigate_forward',
          args: {}
        };
      
      case 'refresh':
      case 'reload':
        return {
          name: 'browser_navigate',
          args: { url: '' }  // Refresh current page
        };
      
      // Wait/pause actions
      case 'wait':
      case 'pause':
      case 'sleep':
      case 'delay':
        return {
          name: '_wait',
          args: { time: params.time || params.seconds || params.duration || 1 }
        };
      
      // Completion actions
      case 'terminate':
      case 'stopaction':
      case 'stop':
      case 'done':
      case 'finish':
      case 'complete':
      case 'answer':
        return {
          name: '_terminate',
          args: { 
            status: params.status || 'success',
            answer: params.answer || params.response || params.message || ''
          }
        };
      
      // Memory actions
      case 'pauseandmemorizefact':
      case 'memorize':
      case 'remember':
      case 'note':
        return {
          name: '_memorize',
          args: { fact: params.fact || params.text || params.note }
        };
      
      // Screenshot (handled specially but including for completeness)
      case 'screenshot':
      case 'takescreenshot':
      case 'capture':
        return {
          name: 'browser_take_screenshot',
          args: {}
        };
      
      default:
        logger.warn(`[Fara] Unknown action type: ${actionType}`);
        return null;
    }
  }

  /**
   * Process a message using Microsoft's Fara model via OpenAI-compatible API
   * @param {string} userMessage - The user's message
   * @returns {Promise<string>} The response text
   */
  async processMessageFara(userMessage) {
    try {
      console.log('Processing message with Fara:', userMessage);
      
      // Get screenshot for the message
      const screenshotData = this.screenshotService?.getLastScreenshot();
      
      // Build system prompt with current date
      const systemPrompt = this.getFaraSystemPrompt()
        .replace('{DATE_TODAY}', new Date().toLocaleDateString());
      
      // Initialize or use existing conversation history for Fara
      if (!this._faraHistory) {
        this._faraHistory = [];
      }
      
      // Build the current message with screenshot
      const currentMessage = {
        role: 'user',
        content: []
      };
      
      // Add screenshot if available (Fara is a vision model)
      if (screenshotData?.scaled) {
        currentMessage.content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${screenshotData.scaled}`
          }
        });
      }
      
      // Get current page snapshot for element refs
      let pageSnapshot = '';
      try {
        const snapshotResult = await this.mcpService.callTool('browser_snapshot', {});
        if (snapshotResult?.content?.[0]?.text) {
          const snapshotText = snapshotResult.content[0].text;
          const snapshotMatch = snapshotText.match(/```yaml\n([\s\S]*?)```/);
          if (snapshotMatch) {
            pageSnapshot = snapshotMatch[1];
          }
        }
      } catch (err) {
        logger.debug('[Fara] Could not get page snapshot:', err.message);
      }
      
      // Add the text message with structured format (magentic-ui style)
      let messageText = `## User Request\n\n${userMessage}\n`;
      
      // Add memorized facts if any
      if (this._faraFacts && this._faraFacts.length > 0) {
        messageText += `\n## Memorized Facts\n\n${this._faraFacts.map(f => `- ${f}`).join('\n')}\n`;
      }
      
      // Add page snapshot for element refs
      if (pageSnapshot) {
        messageText += `\n## Page Snapshot\n\nUse [ref=...] values from this snapshot with left_click and type actions:\n\`\`\`yaml\n${pageSnapshot}\`\`\``;
      }
      
      currentMessage.content.push({
        type: 'text',
        text: messageText
      });
      
      // Build messages array for API call
      const messages = [
        { role: 'system', content: systemPrompt },
        ...this._faraHistory,
        currentMessage
      ];
      
      // Store memorized facts
      if (!this._faraFacts) {
        this._faraFacts = [];
      }
      
      let textContent = '';
      let iterations = 0;
      const maxIterations = 20; // Safety limit
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 3; // Break loop after 3 consecutive errors
      
      while (iterations < maxIterations) {
        iterations++;
        
        // Check for consecutive error limit
        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error(`[Fara] Breaking loop after ${maxConsecutiveErrors} consecutive errors`);
          throw new Error(`Action failed after ${maxConsecutiveErrors} consecutive attempts. The browser tool may be having issues. Please try a different approach.`);
        }
        
        // Check for cancellation
        if (this.cancelRequested) {
          logger.info('[Fara] Execution cancelled by user');
          this.cancelRequested = false;
          throw new Error('Execution cancelled by user');
        }
        
        logger.info(`[Fara] Iteration ${iterations}, sending request to ${this.faraBaseUrl}`);
        
        // Call the OpenAI-compatible API
        const response = await fetch(`${this.faraBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'fara', // Model name (llama.cpp will ignore this)
            messages: messages,
            max_tokens: 4096,
            temperature: 0.1
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Fara API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        const assistantMessage = data.choices?.[0]?.message?.content || '';
        
        logger.debug('[Fara] Response:', assistantMessage);
        
        // Parse tool call from response
        const toolCall = this.parseFaraToolCall(assistantMessage);
        
        if (!toolCall) {
          // No tool call - this is a text response
          textContent = assistantMessage;
          
          // Add to history
          messages.push({ role: 'assistant', content: assistantMessage });
          this._faraHistory.push(currentMessage);
          this._faraHistory.push({ role: 'assistant', content: assistantMessage });
          
          // Keep history manageable
          if (this._faraHistory.length > 20) {
            this._faraHistory = this._faraHistory.slice(-20);
          }
          
          break;
        }
        
        // We have a tool call
        logger.info(`[Fara] Tool call: ${toolCall.name}`, toolCall.arguments);
        
        // Add assistant's response to messages
        messages.push({ role: 'assistant', content: assistantMessage });
        
        // Handle 'goto' as a navigation shortcut
        if (toolCall.name === 'goto' && toolCall.arguments?.url) {
          toolCall.name = 'computer_use';
          toolCall.arguments = { action: 'visit_url', url: toolCall.arguments.url };
        }
        
        // Handle 'stop_action' as a direct tool call (Fara's native stop)
        if (toolCall.name === 'stop_action') {
          textContent = toolCall.arguments?.answer || 'Task completed.';
          break;
        }
        
        // Check if it's computer_use (Fara's main tool)
        if (toolCall.name === 'computer_use') {
          let action = toolCall.arguments;
          
          // Handle missing action field - infer from arguments
          if (!action.action && action.url) {
            action = { action: 'visit_url', url: action.url };
          }
          
          const mcpMapping = this.mapFaraActionToMCP(action);
          
          if (!mcpMapping) {
            // Unknown action - track as error to prevent infinite loops
            consecutiveErrors++;
            logger.warn(`[Fara] Unknown action '${action.action}', consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
            
            // Include screenshot for context
            const invalidActionScreenshot = this.screenshotService?.getLastScreenshot();
            const invalidObservation = {
              role: 'user',
              content: []
            };
            
            if (invalidActionScreenshot?.scaled) {
              invalidObservation.content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${invalidActionScreenshot.scaled}` }
              });
            }
            
            invalidObservation.content.push({
              type: 'text',
              text: `## Observation\n\n**Status:** FAILED\n**Action:** ${action.action}\n**Error:** Unknown action type\n\n**Valid Actions:**\n- visit_url: Navigate to URL\n- web_search: Google search\n- left_click: Click element (use ref or coordinate)\n- type: Type text (use ref)\n- scroll: Scroll page\n- key: Press keyboard key\n- wait: Wait for content\n- stop_action: Complete task with answer\n\n**Guidance:** Use one of the valid actions above.`
            });
            
            messages.push(invalidObservation);
            continue;
          }
          
          // Handle special internal actions
          if (mcpMapping.name === '_terminate') {
            // Use answer from stop_action if provided, otherwise generic message
            textContent = mcpMapping.args.answer || `Task ${mcpMapping.args.status}. Done.`;
            break;
          }
          
          if (mcpMapping.name === '_wait') {
            const waitTime = mcpMapping.args.time * 1000;
            logger.info(`[Fara] Waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Take new screenshot after wait
            const newScreenshot = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
            const observation = {
              role: 'user',
              content: []
            };
            if (newScreenshot?.scaled) {
              observation.content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${newScreenshot.scaled}` }
              });
            }
            observation.content.push({
              type: 'text',
              text: `## Observation\n\n**Status:** SUCCESS\n**Action:** wait\n**Duration:** ${mcpMapping.args.time} seconds\n\nThe page may have updated. Analyze the screenshot and continue with the task.`
            });
            messages.push(observation);
            consecutiveErrors = 0; // Reset on successful wait
            continue;
          }
          
          if (mcpMapping.name === '_memorize') {
            this._faraFacts.push(mcpMapping.args.fact);
            
            // Include screenshot for visual context
            const memorizeScreenshot = this.screenshotService?.getLastScreenshot();
            const memorizeObservation = {
              role: 'user',
              content: []
            };
            
            if (memorizeScreenshot?.scaled) {
              memorizeObservation.content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${memorizeScreenshot.scaled}` }
              });
            }
            
            memorizeObservation.content.push({
              type: 'text',
              text: `## Observation\n\n**Status:** SUCCESS\n**Action:** memorize\n**Fact stored:** "${mcpMapping.args.fact}"\n\nThis fact will be included in future observations. Continue with the task.`
            });
            
            messages.push(memorizeObservation);
            consecutiveErrors = 0; // Reset on successful memorize
            continue;
          }
          
          // Handle type with coordinate (click first, then type)
          if (mcpMapping.name === '_type_with_click') {
            const toolId = this.generateToolId();
            const startTime = Date.now();
            
            this.emitToolEvent('tool-execution-start', {
              toolId,
              toolName: 'type_with_click',
              args: mcpMapping.args
            });
            
            try {
              const { x, y, text, pressEnter, clearFirst, element } = mcpMapping.args;
              
              // Set click indicator for visual feedback
              if (this.screenshotService) {
                this.screenshotService.setClickIndicator(x, y);
              }
              
              // First click the field
              await this.mcpService.callTool('browser_mouse_click_xy', {
                x, y, element: `click to focus ${element}`
              });
              
              // Wait for focus
              await new Promise(resolve => setTimeout(resolve, 300));
              
              // Clear existing text if requested
              if (clearFirst) {
                await this.mcpService.callTool('browser_press_key', { key: 'Control+a' });
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.mcpService.callTool('browser_press_key', { key: 'Backspace' });
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              
              // Type the text using browser_run_code with page.keyboard.type()
              // This properly types text character by character like a real user
              const typeCode = `await page.keyboard.type(${JSON.stringify(text)}, { delay: 50 });`;
              await this.mcpService.callTool('browser_run_code', { code: typeCode });
              
              // Press Enter if requested
              if (pressEnter) {
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.mcpService.callTool('browser_press_key', { key: 'Enter' });
              }
              
              const duration = Date.now() - startTime;
              this.emitToolEvent('tool-execution-success', {
                toolId,
                toolName: 'type_with_click',
                duration,
                visualChange: true
              });
              
              // Log action
              this.actionLog.push({
                timestamp: new Date().toISOString(),
                toolName: 'type_with_click',
                args: mcpMapping.args,
                success: true
              });
              
              // Wait for typing to take effect
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Build observation
              const typeScreenshot = this.screenshotService?.getLastScreenshot();
              const typeObservation = {
                role: 'user',
                content: []
              };
              
              if (typeScreenshot?.scaled) {
                typeObservation.content.push({
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${typeScreenshot.scaled}` }
                });
              }
              
              typeObservation.content.push({
                type: 'text',
                text: `## Observation\n\n**Status:** SUCCESS\n**Action:** type\n**Text typed:** "${text}"\n**Location:** (${x}, ${y})\n\nText has been entered. Check the screenshot to verify.`
              });
              
              messages.push(typeObservation);
              consecutiveErrors = 0;
              continue;
              
            } catch (error) {
              logger.error('[Fara] type_with_click error:', error);
              consecutiveErrors++;
              
              this.emitToolEvent('tool-execution-error', {
                toolId,
                toolName: 'type_with_click',
                error: error.message
              });
              
              const errorScreenshot = this.screenshotService?.getLastScreenshot();
              const errorObservation = {
                role: 'user',
                content: []
              };
              
              if (errorScreenshot?.scaled) {
                errorObservation.content.push({
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${errorScreenshot.scaled}` }
                });
              }
              
              errorObservation.content.push({
                type: 'text',
                text: `## Observation\n\n**Status:** ERROR\n**Action:** type\n**Error:** ${error.message}\n\n**Guidance:** Try using left_click to focus the field first, then use type with ref.`
              });
              
              messages.push(errorObservation);
              continue;
            }
          }
          
          // Execute the MCP tool
          const toolId = this.generateToolId();
          const startTime = Date.now();
          
          // Emit tool execution start
          this.emitToolEvent('tool-execution-start', {
            toolId,
            toolName: mcpMapping.name,
            args: mcpMapping.args
          });
          
          try {
            // Special handling for coordinate clicks - set visual indicator
            if (mcpMapping.name === 'browser_mouse_click_xy' && this.screenshotService) {
              const { x, y } = mcpMapping.args;
              if (x !== undefined && y !== undefined) {
                logger.info(`[Fara Click Indicator] Setting at (${x}, ${y})`);
                this.screenshotService.setClickIndicator(x, y);
              }
            }
            
            // Capture before screenshot for visual change detection
            const beforeScreenshot = this.screenshotService?.getLastScreenshot()?.full;
            
            // Execute the tool
            const toolResult = await this.mcpService.callTool(mcpMapping.name, mcpMapping.args);
            
            // Log action
            this.actionLog.push({
              timestamp: new Date().toISOString(),
              toolName: mcpMapping.name,
              args: mcpMapping.args,
              success: !toolResult.isError
            });
            
            // Wait for visual changes
            const waitTime = mcpMapping.name === 'browser_navigate' ? 1500 : 
                            mcpMapping.name === 'browser_mouse_click_xy' ? 800 : 500;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Get new screenshot
            const afterScreenshotData = this.screenshotService?.getLastScreenshot();
            const afterScreenshot = afterScreenshotData?.full;
            
            // Detect visual changes
            let visualChangeText = '';
            if (beforeScreenshot && afterScreenshot) {
              const comparison = await this.compareScreenshots(beforeScreenshot, afterScreenshot, mcpMapping.name);
              if (comparison.changed) {
                visualChangeText = `Visual change detected (${comparison.percentDiff}% pixels changed).`;
              } else {
                visualChangeText = `WARNING: No visual change detected. The action may have failed.`;
              }
            }
            
            // Emit success
            const duration = Date.now() - startTime;
            this.emitToolEvent('tool-execution-success', {
              toolId,
              toolName: mcpMapping.name,
              duration,
              visualChange: visualChangeText.includes('Visual change detected'),
              changePercent: visualChangeText.match(/(\d+\.?\d*)%/)?.[1]
            });
            
            // Build observation for Fara - screenshots + page snapshot for element refs
            const observation = {
              role: 'user',
              content: []
            };
            
            // Add screenshot first - Fara is a vision model
            if (afterScreenshotData?.scaled) {
              observation.content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${afterScreenshotData.scaled}` }
              });
            }
            
            // Build structured observation text (magentic-ui style)
            let resultText = '';
            
            // Status section
            if (toolResult.isError && toolResult.content?.[0]?.text) {
              resultText = `## Observation\n\n**Status:** FAILED\n**Action:** ${action.action}\n**Error:** ${toolResult.content[0].text.substring(0, 300)}\n`;
              consecutiveErrors++;
              logger.warn(`[Fara] Tool error, consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
            } else {
              resultText = `## Observation\n\n**Status:** SUCCESS\n**Action:** ${action.action}\n`;
              consecutiveErrors = 0;
            }
            
            // Visual feedback section
            resultText += `\n**Visual Feedback:** ${visualChangeText}\n`;
            
            // Page snapshot section for element refs
            const toolResultText = toolResult.content?.[0]?.text || '';
            const snapshotMatch = toolResultText.match(/- Page Snapshot:\n```yaml\n([\s\S]*?)```/);
            if (snapshotMatch) {
              resultText += `\n**Page Snapshot** (use [ref=...] values for interactions):\n\`\`\`yaml\n${snapshotMatch[1]}\`\`\`\n`;
            }
            
            // Guidance section
            if (toolResult.isError) {
              resultText += `\n**Guidance:** The action failed. Analyze the screenshot and try an alternative approach. Consider:\n- Using a different element ref\n- Scrolling to reveal the target\n- Waiting for page to load\n- Clicking to focus before typing\n`;
            } else if (!visualChangeText.includes('Visual change detected')) {
              resultText += `\n**Guidance:** No visual change detected. The action may not have had the expected effect. Consider:\n- Verifying the element was correct\n- Trying a different interaction method\n- Checking if the page needs to load\n`;
            }
            
            observation.content.push({
              type: 'text',
              text: resultText
            });
            
            messages.push(observation);
            
          } catch (error) {
            logger.error(`[Fara] Tool execution error:`, error);
            consecutiveErrors++; // Track consecutive errors
            logger.warn(`[Fara] Exception error, consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
            
            // Emit error event
            this.emitToolEvent('tool-execution-error', {
              toolId,
              toolName: mcpMapping.name,
              error: error.message
            });
            
            // Add error observation with screenshot (Fara needs visual context)
            const errorScreenshot = this.screenshotService?.getLastScreenshot();
            const errorObservation = {
              role: 'user',
              content: []
            };
            
            // Include screenshot even on error - Fara relies on visual feedback
            if (errorScreenshot?.scaled) {
              errorObservation.content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${errorScreenshot.scaled}` }
              });
            }
            
            errorObservation.content.push({
              type: 'text',
              text: `## Observation\n\n**Status:** ERROR\n**Action:** ${action.action}\n**Error:** ${error.message.substring(0, 300)}\n\n**Guidance:** The action encountered an error. Analyze the screenshot and try an alternative approach. Consider:\n- Using a different element or ref\n- Checking if the page has fully loaded\n- Trying a different action type\n`
            });
            
            messages.push(errorObservation);
          }
        } else {
          // Unknown tool name from Fara - include screenshot for context
          const unknownToolScreenshot = this.screenshotService?.getLastScreenshot();
          const unknownObservation = {
            role: 'user',
            content: []
          };
          
          if (unknownToolScreenshot?.scaled) {
            unknownObservation.content.push({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${unknownToolScreenshot.scaled}` }
            });
          }
          
          unknownObservation.content.push({
            type: 'text',
            text: `## Observation\n\n**Status:** FAILED\n**Error:** Unknown tool "${toolCall.name}"\n\n**Guidance:** Please use the computer_use tool with valid actions:\n- visit_url, web_search, left_click, type, scroll, key, wait, stop_action\n\nExample: {"name": "computer_use", "arguments": {"action": "visit_url", "url": "https://google.com"}}`
          });
          
          messages.push(unknownObservation);
        }
      }
      
      if (iterations >= maxIterations) {
        logger.warn('[Fara] Max iterations reached');
        textContent = 'I have reached the maximum number of steps. Please try breaking down the task into smaller parts.';
      }
      
      // Update conversation history - STRIP IMAGES to prevent context overflow
      // Images are huge (base64) and accumulate quickly, exceeding context limit
      // Only keep text content in history; fresh screenshot is added with each new request
      this._faraHistory = messages.slice(1)
        .filter(m => m.role !== 'system')
        .map(m => {
          // Strip image_url content from history to save context space
          if (Array.isArray(m.content)) {
            return {
              role: m.role,
              content: m.content
                .filter(c => c.type !== 'image_url')
                .map(c => c.type === 'text' ? c : { type: 'text', text: '[image]' })
            };
          }
          return m;
        })
        .filter(m => {
          // Remove empty messages (had only images)
          if (Array.isArray(m.content)) {
            return m.content.length > 0 && m.content.some(c => c.text && c.text !== '[image]');
          }
          return true;
        });
      
      // Keep only last 10 exchanges to stay within context limits
      if (this._faraHistory.length > 10) {
        this._faraHistory = this._faraHistory.slice(-10);
      }
      
      return textContent || 'Done.';
      
    } catch (error) {
      console.error('Error processing message with Fara:', error);
      
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch failed')) {
        const connectionError = new Error(`Cannot connect to Fara server at ${this.faraBaseUrl}. Make sure llama.cpp server is running.`);
        connectionError.status = 503;
        connectionError.statusText = 'Service Unavailable';
        throw connectionError;
      }
      
      // Check for context size exceeded error
      if (error.message?.includes('context size') || error.message?.includes('exceed_context_size')) {
        // Clear history and suggest retry
        this._faraHistory = [];
        const contextError = new Error(
          `Context size exceeded. History has been cleared. Please try your request again.`
        );
        contextError.status = 400;
        contextError.statusText = 'Context Size Exceeded';
        throw contextError;
      }
      
      // Check for mmproj error - vision model not properly configured
      if (error.message?.includes('mmproj') || error.message?.includes('image input is not supported')) {
        const visionError = new Error(
          `Fara vision model not properly configured. The llama.cpp server needs the multimodal projector (mmproj) file.\n\n` +
          `Start llama.cpp with:\n` +
          `llama-server -m Fara-7B.gguf --mmproj Fara-7B-mmproj.gguf --port 8080\n\n` +
          `Download both the model and mmproj files from Hugging Face.`
        );
        visionError.status = 500;
        visionError.statusText = 'Vision Model Not Configured';
        throw visionError;
      }
      
      throw error;
    }
  }

  /**
   * Converts a JSON Schema object from the MCP format to the Gemini FunctionDeclaration parameters format.
   * This is a recursive function to handle nested types (like objects and arrays).
   * @param {object} schema - The JSON Schema object to convert.
   * @returns {object} The converted parameters object.
   */
  convertSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const { type, description, properties, required, items, enum: enumValues } = schema;
    const converted = {};

    // Map string type to Gemini Type enum
    if (type) {
        // Playwright uses "number" for integers and floats, but we check for common types
        switch (type.toLowerCase()) {
            case 'object':
                converted.type = Type.OBJECT;
                break;
            case 'array':
                converted.type = Type.ARRAY;
                break;
            case 'string':
                converted.type = Type.STRING;
                break;
            case 'number':
                // Note: Playwright often uses 'number' for both float and integer.
                // We'll stick to Type.NUMBER unless there's an explicit 'integer' in the source.
                converted.type = Type.NUMBER;
                break;
            case 'boolean':
                converted.type = Type.BOOLEAN;
                break;
            default:
                converted.type = type.toUpperCase(); // Fallback
        }
    }

    if (description) {
        converted.description = description;
    }

    if (required) {
        converted.required = required;
    }

    if (enumValues) {
        converted.enum = enumValues;
    }

    // Recursively handle properties for objects
    if (properties) {
        converted.properties = {};
        for (const key in properties) {
            converted.properties[key] = this.convertSchema(properties[key]);
        }
    }

    // Recursively handle items for arrays
    if (items) {
        converted.items = this.convertSchema(items);
    }

    return converted;
  }

  /**
  * Converts an array of MCP tools specifications to the format required by the Gemini API.
  * * @param {Array<object>} mcpToolsSpec - The array of tool specifications in MCP format.
  * @returns {Array<object>} An array of FunctionDeclaration objects for the Gemini API.
  */
  convertMcpToGeminiTools(mcpToolsSpec) {
    if (!Array.isArray(mcpToolsSpec)) {
        console.error("Input must be an array of tool specifications.");
        return [];
    }

    return mcpToolsSpec.map(tool => {
        // Start with the basic properties
        const geminiDeclaration = {
            name: tool.name,
            description: tool.description,
        };

        // Convert the inputSchema to the required parameters format
        if (tool.inputSchema) {
            geminiDeclaration.parameters = this.convertSchema(tool.inputSchema);
        } else {
            // For functions with no input (like browser_close), the parameters object is still expected.
            // We ensure it has a type of OBJECT and an empty properties field.
            geminiDeclaration.parameters = {
                type: Type.OBJECT,
                properties: {}
            };
        }

        return geminiDeclaration;
    });
  }

  pruneHistory() {
    // Increased 10 to give LLM more short-term memory and prevent amnesia.
    const maxMessages = 20;
    
    if (this.conversationHistory.length <= maxMessages) {
      // Even if under limit, strip images from older messages
      this.stripOldImages();
      return;
    }
    logger.info(`Pruning history from ${this.conversationHistory.length} messages...`);
    
    // **SIMPLE AND RELIABLE PRUNING**
    // The old logic was too complex and cut out recent, important actions.
    // This new logic simply keeps the last `maxMessages` of the conversation.
    let prunedHistory = this.conversationHistory.slice(-maxMessages);

    // Find the index of the first 'user' message to ensure we don't start with a 'model' response. Also ensure that first message is not a functionResponse for a function call which is no longer in the history.
    const firstUserIndex = prunedHistory.findIndex(m => m.role === 'user' && m.parts.findIndex(p => !!p.functionResponse) === -1);
    if (firstUserIndex === -1) {
      // Should not happen in a valid conversation, but as a safeguard:
      this.conversationHistory = [];
      logger.warn('Conversation history is empty. This should not happen in a valid conversation.');
      return;
    }
    // If the first message isn't from the user, slice it off to maintain the turn structure.
    prunedHistory = prunedHistory.slice(firstUserIndex);

    this.conversationHistory = prunedHistory;
    logger.info(`History pruned to ${this.conversationHistory.length} messages.`);
    
    // Strip images from all but the last 2 messages to save massive tokens
    this.stripOldImages();
  }
  
  /**
   * Strip ALL images from history to prevent token explosion
   * Screenshots are base64 and consume massive tokens (~50-100KB each)
   * LLM sees current screenshot in current response, doesn't need old ones
   * Text history (accessibility trees, actions, visual change detection) is sufficient
   */
  stripOldImages() {
    if (this.conversationHistory.length === 0) {
      return;
    }
    
    const keepImagesCount = 0; // Strip ALL images - LLM sees current one in response
    const stripCount = this.conversationHistory.length - keepImagesCount;
    
    for (let i = 0; i < stripCount; i++) {
      const message = this.conversationHistory[i];
      if (message.parts && Array.isArray(message.parts)) {
        // Remove inline_data (images) but keep text
        message.parts = message.parts.filter(part => !part.inlineData && !part.inline_data);
      }
    }
    
    logger.info(`Stripped images from ${stripCount} older messages to save tokens.`);
  }

  addVisualChangeInfoToToolResult(toolResult, visualChangeInfo) {
    if (!visualChangeInfo) {
      return toolResult;
    }
    const enhanced = { ...toolResult };
    enhanced.content = [...(toolResult.content || [])];
    let added = false;
    // Add visual change info to the text content
    if (enhanced.content.length > 0) {
      let i = 0;
      while (typeof enhanced.content[i].text !== 'undefined') {
        enhanced.content[i].text = enhanced.content[i].text + visualChangeInfo;
        i++;
        added = true;
        break;
      }
    }
    if (!added) {
      // If no text content exists, add visual change info as new text content
      enhanced.content.unshift({
        text: `### Result\nExecuted ${functionCall.name}.${visualChangeInfo}`
      });
    }
    return enhanced;
  }

  toolResultToGeminiFunctionResponse(toolResult) {
    const r = {...toolResult};
    r.result = r.content; // Renaming content key to result for Gemini
    delete r.content;
    return r; 
  }

  /**
   * Strip console messages section from tool result text
   * The @playwright/mcp server includes "### New console messages" in responses
   * which adds unnecessary noise to the LLM context
   */
  stripConsoleMessages(toolResult) {
    if (!toolResult || !toolResult.content || toolResult.content.length === 0) {
      return toolResult;
    }

    const enhanced = { ...toolResult };
    enhanced.content = toolResult.content.map(contentItem => {
      if (contentItem.text && typeof contentItem.text === 'string') {
        // Remove "### New console messages" and its messages
        const consoleMessageIndex = contentItem.text.indexOf('### New console messages');
        if (consoleMessageIndex !== -1) {
          let text = contentItem.text;
          let nextHeaderIndex = text.substring(consoleMessageIndex + '### New console messages'.length).search(/(### .+\n)/g);
          if (nextHeaderIndex === -1) {
            nextHeaderIndex = text.length;
          } else {
            nextHeaderIndex += consoleMessageIndex + '### New console messages'.length;
          }
          return {
            ...contentItem,
            text: text.substring(0, consoleMessageIndex) + text.substring(nextHeaderIndex)
          };
        }
      }
      return contentItem;
    });

    return enhanced;
  }

  stringifyContent(content) {
    return JSON.stringify(content, (key, value) => {
      if (key === 'inlineData') {
        return {...value, data: '--BASE64 Encoded data--'};
      }
      return value;
    }, 2);
  }

  async processMessageGemini(userMessage) {
    try {
      console.log('Processing message with Gemini:', userMessage);

      if (!this._geminiToolDeclarations || !this._geminiSystemPrompt) {
        // Get available tools from MCP
        const tools = await this.mcpService.getAvailableTools();
          
        // Convert MCP tools to the required formats
        this._geminiToolDeclarations = this.convertMcpToGeminiTools(tools);
        
        // Add custom validateScenario tool
        this._geminiToolDeclarations.push({
          name: 'validateScenario',
          description: 'MANDATORY tool for recording validation results. You MUST call this tool whenever the user asks to validate, verify, check, or assert any condition. After analyzing the page state (via browser_snapshot), you MUST call this tool with pass or fail. Never return empty or text response for validation requests.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              scenario_description: {
                type: Type.STRING,
                description: 'A clear description of what is being validated (e.g., "Login button is visible", "User is on dashboard page", "Error message displays")'
              },
              validation_result: {
                type: Type.STRING,
                description: 'The result of the validation',
                enum: ['pass', 'fail']
              },
              fail_reason: {
                type: Type.STRING,
                description: 'Detailed explanation of why the validation failed. Required when validation_result is "fail", optional otherwise.'
              }
            },
            required: ['scenario_description', 'validation_result']
          }
        });
        
        logger.verbose('Gemini tool declarations:', JSON.stringify(this._geminiToolDeclarations, null, 2));

        this._geminiSystemPrompt = `### **Core Identity and Role**
You are a helpful AI Assistant with Browser Automation capabilities. Your primary function is to help users by:
1. **Answering general questions** - You can engage in normal conversation and answer knowledge questions
2. **Automating browser tasks** - When users request web-based actions (navigation, interaction, validation), you use the available Playwright tools

You operate within a secure, sandboxed browser environment which is pre-configured with necessary access and proxies when performing automation tasks.

### **Available Data Sources & Feedback Mechanisms**

You have access to three types of information about the web page:

1.  **Page Snapshot (YAML)** - Your primary working data.
    -   A structured text representation of the page's accessibility tree.
    -   Available via the \`browser_snapshot\` tool.
    -   Contains element references (\`ref\` IDs) for efficient interaction.

2.  **Visual Screenshots** - For autonomous visual analysis.
    -   **You MUST take screenshots autonomously** by calling the \`browser_take_screenshot\` tool.
    -   **NEVER ask the user for a screenshot.**
    -   This is required for interacting with visual elements (charts, graphs, icons) and as a fallback when \`ref\`-based methods fail.
    -   Fallback to this method of taking screenshot if the element the user is trying to interact with is not found in the "Page Snapshot".

3.  **Visual Change Detection** - Automatic feedback after most tool executions.
    -   After most tool executions, you receive a visual change detection summary:
        -   **"Visual change detected..."** means your action had a visible effect.
        -   **"WARNING: NO visual change detected..."** means your action likely failed. **You MUST react to this warning** by trying a different approach.

### **Unified Execution Strategy (MUST FOLLOW)**

Your goal is to complete the user's request using the most appropriate tool. Follow this single workflow:

1.  **Analyze the Request:**
    -   If the user's request involves standard elements (buttons, links, forms), start with the \`browser_snapshot\` to get \`ref\` IDs and use \`ref\`-based tools (\`browser_click\`, \`browser_type\`).
    -   If the user's request involves **visual attributes** (e.g., "the red button", "the chart on the left", "the icon that looks like a gear"), or if a \`ref\`-based action fails (indicated by a "NO visual change" warning), or if the element the user is trying to interact with is not found in the "Page Snapshot", **you MUST start with \`browser_take_screenshot\`.**

2.  **Execute the Action:**
    -   **For \`ref\`-based actions:** Use the \`ref\` ID with the appropriate tool.
    -   **For vision-based actions:**
        a.  Call \`browser_take_screenshot\`.
        b.  Analyze the image to find the coordinates (X, Y) of the target.
        c.  Call \`browser_mouse_click_xy\` with the identified coordinates.

3.  **Verify the Result:**
    -   After every action, check the **visual change detection feedback**.
    -   If you used \`browser_mouse_click_xy\`, you will also get a **red dot** on the screenshot showing where you clicked. Use this to confirm your accuracy.
    -   If the action did not produce the expected result (no visual change, or the red dot missed), **try a different approach**. Do not repeat the exact same failed action.

**Important Notes:**
- **YOU MUST take screenshots yourself** - NEVER ask the user to provide them
- After using \`browser_take_screenshot\`, you must follow it up with one of the mouse based tools like \`browser_mouse_click_xy\`, etc.
- Coordinates must be precise - if wrong, action won't work as intended
- Always verify coordinates from red dot feedback before giving up
- If element not in Page Snapshot but user mentions it, trust user and use vision strategy

### **Action Mandates**

1.  **Choose Response Type Appropriately:**
    -   **General questions** (e.g., "What is a pie chart?"): Answer conversationally without tools.
    -   **Browser automation requests** (e.g., "Click the button"): Use tools and do not narrate your actions.

2. **Tool Use for Automation:** When user requests browser actions, you **MUST** use these tools. If automation task is not complete, your response **MUST** be a tool call.

3. **Silent Operation:** During automation, do not explain which tools you're using or what parameters you're sending. Execute actions directly without narration.

4. **No Unprompted Actions:** **DO NOT** take actions not explicitly requested by user or required for error resolution. Example: Don't click search results unless directed.

5. **Form Handling:** Use \`browser_fill_form\` for form filling. It is more robust and efficient.
   - **IMPORTANT:** When using \`browser_fill_form\`, you **MUST** provide the \`name\` of each form field. The \`name\` should be the descriptive label of the field from the Page Snapshot (e.g., "Username", "Password", "First Name").
   - **DO NOT** use the \`ref\` attribute (e.g., "e11") for fields in this tool. Use the human-readable \`name\`.

6. **Validation and Assertions (CRITICAL):** When user asks to validate, verify, check, or assert any condition (e.g., "validate that the login button is visible", "validate that the cart page has shown up", "check if we're on the dashboard", "assert the error message shows"), you **MUST ALWAYS** call the \`validateScenario\` tool as the FINAL action.

   **VALIDATION WORKFLOW:**
   a. First, get current page state:
      - Use \`browser_snapshot\` for text/element validation (buttons, text, links, form fields)
      - Use \`browser_take_screenshot\` for visual validation (colors, layout, icons, charts, images)
   b. Analyze the snapshot/screenshot to determine if the condition passes or fails
   c. **IMMEDIATELY** call \`validateScenario\` with \`pass\` or \`fail\` result - THIS IS MANDATORY
   
   **CRITICAL RULES:**
   - A validation request is NOT complete until \`validateScenario\` is called
   - You must NEVER return an empty response after checking page state for validation
   - You must NEVER return only text without calling \`validateScenario\`
   - If you cannot determine the result, call \`validateScenario\` with \`fail\` and explain in \`fail_reason\`
   
   **Example:** User says "Validate the cart shows 2 items"
   1. Call \`browser_snapshot\` → See page state
   2. Call \`validateScenario\` with \`pass\` if cart shows 2 items, or \`fail\` with reason if not

7. **Final Output:** When user's automation task is fully completed, respond with a concise confirmation: **"Done."**

### **Error Resolution Protocol**

- **"Ref not found" Error:** 
  1. Call \`browser_snapshot\` to get latest page state with updated refs
  2. If still failing, switch to vision-based actions with coordinates

- **No Visual Change After Action:**
  1. Action likely failed silently
  2. Try alternative selector/ref in Page Snapshot
  3. If still failing, switch to vision-based actions

- **User Reports Failure:** 
  - **Believe them immediately**
  - Re-examine Page Snapshot and request screenshot
  - Try vision-based actions with coordinates

- **Coordinate Click Misses Target:**
  1. Look at red dot indicator in returned screenshot
  2. Calculate offset from intended target
  3. Adjust coordinates and retry

- **Browser Not Installed:** Use \`browser_install\` tool

- **Give Up After 6 Attempts:** If unable to complete task after 6 attempts, respond: "I have run out of tries to complete this task."

### **Key Reminders**

- Page Snapshot (refs) = Primary efficient method
- Screenshots (vision) = Fallback for visual elements or failures  
- Visual Change Detection = Your success/failure indicator
- Red Dot Feedback = Coordinate accuracy verification when using vision-based actions
- Switch strategies quickly when visual change shows no effect
- **VALIDATION = MUST call \`validateScenario\`** - Never return empty or text-only for validation requests

`;
        logger.debug('Gemini system prompt:', this._geminiSystemPrompt);
      }

      // Always prepend tool context to ensure Gemini knows to use tools
      let messageToSend = `The current time is: ${new Date().toLocaleString()}\n\n[Remember: Use the available browser automation tools to complete this request]\n\n${userMessage}`;
      
      // Add extra reminder for validation requests
      const lowerMessage = userMessage.toLowerCase();
      if (lowerMessage.includes('validate') || lowerMessage.includes('verify') || lowerMessage.includes('check') || lowerMessage.includes('assert')) {
        messageToSend += `\n\n[REMINDER: This is a validation request. You MUST call the validateScenario tool with pass or fail result. Do NOT return empty or text-only response.]`;
      }

      // Debug logging
      logger.debug('Message to send:', messageToSend.substring(0, 200) + '...');

      // Build contents array for the new API
      const contents = [];
      
      // Add conversation history
      if (this.conversationHistory.length > 0) {
        contents.push(...this.conversationHistory.map(msg => ({
          role: msg.role === 'model' ? 'model' : 'user',
          parts: msg.parts
        })));
      }
      
      // Add current message
      const currentParts = [{ text: messageToSend }];
      contents.push({ role: 'user', parts: currentParts });
      
      // Handle function calls
      let currentFunctionCalls = [];
      let response;
      let textContent = "";
      do {
        // Check for cancellation request
        if (this.cancelRequested) {
          logger.info('[LLM Service] Execution cancelled by user');
          this.cancelRequested = false; // Reset flag
          throw new Error('Execution cancelled by user');
        }
        
        if (logger.level >= logger.LOG_LEVELS.VERBOSE) {
          logger.verbose("About to make Gemini call with content: ", this.stringifyContent(contents));
        }
        // Call the model API
        response = await this.client.models.generateContent({
          model: this.modelName,
          contents,
          config: {
            systemInstruction: this._geminiSystemPrompt,
            tools: [{ functionDeclarations: this._geminiToolDeclarations }],
            seed: 42,
            temperature: 0,
            maxOutputTokens: 6000
          }
        });
        
        // Debug logging
        logger.debug('Gemini response received:', JSON.stringify(response, null, 2));
        response = response.candidates[0] || {};

        // Extract text response
        textContent = response.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
        
        // Extract function calls from response
        currentFunctionCalls = response.content?.parts?.filter(p => !!p.functionCall).map(p => p.functionCall) || [];
        logger.debug('Gemini requested function calls:', currentFunctionCalls);
        logger.debug('Function calls count:', currentFunctionCalls.length);

        const functionResponses = [];
        for (const functionCall of currentFunctionCalls) {
          // Check for cancellation request before processing each tool
          if (this.cancelRequested) {
            logger.info('[LLM Service] Execution cancelled by user during tool execution');
            this.cancelRequested = false; // Reset flag
            throw new Error('Execution cancelled by user');
          }
          
          // Generate unique tool ID for tracking
          const toolId = this.generateToolId();
          const startTime = Date.now();
          
          // Emit tool execution start event
          this.emitToolEvent('tool-execution-start', {
            toolId,
            toolName: functionCall.name,
            args: functionCall.args || {}
          });
          
          logger.info(`Executing tool: ${functionCall.name}`);
          
          // Capture screenshot BEFORE action for visual change detection
          const screenshotData = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
          // Use FULL resolution for accurate change detection
          const beforeScreenshot = screenshotData ? screenshotData.full : null;

          if (functionCall.name === "browser_take_screenshot") {
            // Send SCALED screenshot to LLM for token savings (50% size = 75% token reduction)
            const scaledScreenshot = screenshotData ? screenshotData.scaled : null;
            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: {
                  result: [{
                    inlineData: {
                      mimeType: 'image/png',
                      data: scaledScreenshot
                    }
                  }, {
                    text: "Successfully captured screenshot"
                  }],
                }
              }
            });
            
            // Emit success event for screenshot tool (short-circuited, no MCP call needed)
            const duration = Date.now() - startTime;
            this.emitToolEvent('tool-execution-success', {
              toolId,
              toolName: functionCall.name,
              duration,
              visualChange: undefined, // No visual change for screenshot capture
              changePercent: undefined
            });
          } else if (functionCall.name === 'validateScenario') {
            // Handle custom validateScenario tool
            try {
              const args = functionCall.args || {};
              const { scenario_description, validation_result, fail_reason } = args;
              
              // Validate inputs
              if (!scenario_description || !validation_result) {
                throw new Error('scenario_description and validation_result are required');
              }
              
              if (!['pass', 'fail'].includes(validation_result)) {
                throw new Error('validation_result must be either "pass" or "fail"');
              }
              
              // Create validation record
              const validationRecord = {
                timestamp: new Date().toISOString(),
                scenario: scenario_description,
                result: validation_result,
                failReason: fail_reason || null
              };
              
              // Store validation result
              this.validationResults.push(validationRecord);
              
              // Log validation
              const resultIcon = validation_result === 'pass' ? '✅' : '❌';
              logger.info(`[Validation] ${resultIcon} ${scenario_description}: ${validation_result.toUpperCase()}${fail_reason ? ' - ' + fail_reason : ''}`);
              
              // Emit tool execution success
              const duration = Date.now() - startTime;
              this.emitToolEvent('tool-execution-success', {
                toolId,
                toolName: functionCall.name,
                duration,
                visualChange: undefined,
                changePercent: undefined
              });
              
              // Send validation result back to Gemini
              const resultMessage = validation_result === 'pass' 
                ? `Validation passed: ${scenario_description}`
                : `Validation failed: ${scenario_description}. Reason: ${fail_reason || 'Not specified'}`;
              
              functionResponses.push({
                functionResponse: {
                  name: functionCall.name,
                  response: {
                    content: [{
                      type: 'text',
                      text: `${resultIcon} ${resultMessage}\n\nValidation has been recorded. Total validations so far: ${this.validationResults.length}`
                    }]
                  }
                }
              });
              
              // Also send a user-visible message for validations
              this.sendAssistantMessage(`${resultIcon} **Validation ${validation_result === 'pass' ? 'Passed' : 'Failed'}**: ${scenario_description}${fail_reason ? '\n**Reason**: ' + fail_reason : ''}`);
              
            } catch (error) {
              logger.error(`Error handling validateScenario:`, error);
              
              // Emit error event
              this.emitToolEvent('tool-execution-error', {
                toolId,
                toolName: functionCall.name,
                error: error.message
              });
              
              // Send error response
              functionResponses.push({
                functionResponse: {
                  name: functionCall.name,
                  response: {
                    isError: true,
                    content: [{
                      type: 'text',
                      text: `Error recording validation: ${error.message}`
                    }]
                  }
                }
              });
              
              hadError = true;
            }
          } else {
            try {
              // Special handling for coordinate-based clicks - set visual indicator
              if (functionCall.name === 'browser_mouse_click_xy' && this.screenshotService) {
                const { x, y } = functionCall.args || {};
                if (x !== undefined && y !== undefined) {
                  // LLM provides coordinates in SCALED space
                  // Store them in SCALED space for drawing red dot on SCALED screenshot
                  // MCP service will scale them separately for Playwright
                  logger.info(`[Click Indicator] Setting indicator at LLM coordinates (${x}, ${y}) in scaled space`);
                  this.screenshotService.setClickIndicator(x, y);
                }
              }

              // Execute the tool via MCP
              const toolResult = await this.mcpService.callTool(
                functionCall.name,
                functionCall.args || {}
              );
              
              // Log action for Playwright script generation
              this.actionLog.push({
                timestamp: new Date().toISOString(),
                toolName: functionCall.name,
                args: functionCall.args || {},
                success: !toolResult.isError
              });
              
              // Check if this is a navigation-related "error" that's actually success
              let isNavigationSuccess = false;
              if (toolResult.isError && toolResult.content && toolResult.content.length > 0) {
                const errorText = toolResult.content[0].text || '';
                if (errorText.includes('Execution context was destroyed') ||
                    errorText.includes('most likely because of a navigation')) {
                  isNavigationSuccess = true;
                  logger.info('Detected successful navigation (context destroyed)');
                } else {
                  // Real error - emit error event
                  this.emitToolEvent('tool-execution-error', {
                    toolId,
                    toolName: functionCall.name,
                    error: errorText
                  });
                }
              }
              
              // Try to enhance response with cached screenshot from screenshot service
              // This avoids making duplicate MCP calls to browser_take_screenshot
              try {
                // Different wait times based on tool type to ensure visual changes are captured
                const isCoordinateClick = functionCall.name === 'browser_mouse_click_xy';
                const isFormFilling = ['browser_fill_form', 'browser_type'].includes(functionCall.name);
                
                let waitTime;
                if (isNavigationSuccess) {
                  waitTime = 1000; // Navigation needs time for page load
                } else if (isFormFilling) {
                  waitTime = 1000; // Form fields need time to render text and animations
                } else if (isCoordinateClick) {
                  waitTime = 800; // Coordinate clicks need time for red dot to be drawn
                } else {
                  waitTime = 500; // Default wait time for other actions
                }
                
                logger.info(`[Visual Change] Waiting ${waitTime}ms for visual changes to render after ${functionCall.name}`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                
                // Get the cached screenshot from screenshot service (already captured at 15 FPS)
                // For coordinate clicks, scaled version will include the red dot indicator
                const cachedScreenshotData = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
                const cachedScreenshotFull = cachedScreenshotData ? cachedScreenshotData.full : null;
                const cachedScreenshotScaled = cachedScreenshotData ? cachedScreenshotData.scaled : null;
                
                // Detect visual changes by comparing before and after screenshots (use FULL resolution for accuracy)
                // Skip visual change detection for read-only tools that don't perform actions
                const readOnlyTools = ['browser_snapshot', 'browser_take_screenshot', 'browser_tabs', 'browser_console_messages', 'browser_network_requests'];
                const shouldDetectVisualChange = !readOnlyTools.includes(functionCall.name);
                
                let visualChangeInfo = '';
                if (shouldDetectVisualChange && beforeScreenshot && cachedScreenshotFull && beforeScreenshot !== cachedScreenshotFull) {
                  const comparison = await this.compareScreenshots(beforeScreenshot, cachedScreenshotFull, functionCall.name);
                  logger.info(`[Visual Change] Tool: ${functionCall.name}, Changed: ${comparison.changed}, Percent: ${comparison.percentDiff}%, Pixels: ${comparison.pixelsDiff}/${comparison.totalPixels}`);
                  
                  if (comparison.error) {
                    visualChangeInfo = `\n\n### Visual Change Detection Result\nVisual change detection system failed with an error - ${comparison.error}`;
                  } else if (comparison.changed) {
                    visualChangeInfo = `\n\n### Visual Change Detection Result\n**Visual change has been detected.** (${comparison.percentDiff}% of pixels changed, ${comparison.pixelsDiff.toLocaleString()} pixels out of ${comparison.totalPixels.toLocaleString()})\nThe page visually changed after this action, indicating the action had an effect.`;
                  } else {
                    // For form filling tools, provide more context
                    const threshold = isFormFilling ? '0.1%' : '0.5%';
                    if (isFormFilling) {
                      visualChangeInfo = `\n\n### Visual Change Detection Result\n**Visual change has not been detected.** (${comparison.percentDiff}% of pixels changed, threshold is ${threshold})\n**Note**: Form fields may have subtle visual changes. If you can see text in the screenshot, the form was likely filled successfully even if visual change detection shows minimal difference.`;
                    } else {
                      visualChangeInfo = `\n\n### Visual Change Detection Result\n**Visual change has not been detected.** (${comparison.percentDiff}% of pixels changed, threshold is ${threshold})\n**WARNING**: The page did not visually change after this action. The action may have failed or had no effect. Consider trying a different approach or verifying if the action succeeded.`;
                    }
                  }
                } else if (shouldDetectVisualChange && beforeScreenshot === cachedScreenshotFull) {
                  logger.warn(`[Visual Change] Screenshot identical before and after ${functionCall.name}`);
                  visualChangeInfo = `\n\n**Visual Change Detected**: NO\n**WARNING**: Screenshot is identical before and after action. The action likely had no visual effect.`;
                }
                
                // Emit tool execution success event
                const duration = Date.now() - startTime;
                // Only calculate visual change comparison for action tools, not read-only tools
                const comparison = shouldDetectVisualChange && beforeScreenshot && cachedScreenshotFull ? await this.compareScreenshots(beforeScreenshot, cachedScreenshotFull, functionCall.name) : null;
                this.emitToolEvent('tool-execution-success', {
                  toolId,
                  toolName: functionCall.name,
                  duration,
                  visualChange: comparison ? comparison.changed : undefined,
                  changePercent: comparison ? comparison.percentDiff.toFixed(2) : undefined
                });
                
                // If it's a navigation success, get fresh snapshot
                if (isNavigationSuccess) {
                  const hasSnapshot = toolResult.content && toolResult.content.some(c => c.text && c.text.includes('Page Snapshot'));
  
                  // If the navigation result does NOT include a snapshot, get one
                  if (!hasSnapshot) {
                    console.log('Getting fresh snapshot after navigation...');
                    const snapshotResult = await this.mcpService.callTool('browser_snapshot', {});
                    
                    // Combine snapshot text with cached screenshot
                    const combinedResponse = {
                      result: {
                        text: `### Result\nSuccessfully executed ${functionCall.name}. Page navigated.\n\n${this.stripConsoleMessages(snapshotResult).content[0].text}.${visualChangeInfo}`
                      }
                    };
                    
                    // DON'T add screenshot - causes token explosion
                    // Accessibility tree + visual change text is sufficient
                    
                    functionResponses.push({
                      functionResponse: {
                        name: functionCall.name,
                        response: combinedResponse
                      }
                    });
                  } else {
                    // Navigation result has snapshot, add visual change info only (no screenshot)
                    functionResponses.push({ functionResponse: { name: functionCall.name, response: this.toolResultToGeminiFunctionResponse(this.addVisualChangeInfoToToolResult(this.stripConsoleMessages(toolResult), visualChangeInfo)) } });
                  }
                } else {
                  // Special handling for coordinate-based clicks - send screenshot WITH red dot indicator
                  // Use SCALED resolution with red dot (red dot is drawn on scaled screenshot for LLM)
                  if (isCoordinateClick && cachedScreenshotScaled) {
                    const enhancedResult = this.toolResultToGeminiFunctionResponse(this.addVisualChangeInfoToToolResult(this.stripConsoleMessages(toolResult), visualChangeInfo));
                    
                    // Add the screenshot with the red dot indicator for LLM feedback
                    if (!enhancedResult.result) {
                      enhancedResult.result = [];
                    }
                    
                    // Ensure result is an array
                    if (!Array.isArray(enhancedResult.result)) {
                      enhancedResult.result = [enhancedResult.result];
                    }
                    
                    // Add text indicating the visual feedback
                    const clickFeedbackText = `\n\n### Click Location Indicator\nA red dot has been drawn at the clicked coordinates (${functionCall.args?.x}, ${functionCall.args?.y}) in the screenshot below. This shows where your click action was executed. The red dot will remain visible for 10 seconds to help you verify the click location.`;
                    
                    // Add or update the text content
                    if (enhancedResult.result.length > 0 && enhancedResult.result[0].text) {
                      enhancedResult.result[0].text += clickFeedbackText;
                    } else {
                      enhancedResult.result.unshift({ text: clickFeedbackText });
                    }
                    
                    // Add the SCALED screenshot with red dot (red dot drawn at scaled coordinates)
                    enhancedResult.result.push({
                      inlineData: {
                        mimeType: 'image/png',
                        data: cachedScreenshotScaled
                      }
                    });
                    
                    logger.info(`[Click Indicator] Sending SCALED screenshot with red dot to LLM for coordinates (${functionCall.args?.x}, ${functionCall.args?.y}) in scaled space`);
                    
                    functionResponses.push({ 
                      functionResponse: { 
                        name: functionCall.name, 
                        response: enhancedResult 
                      } 
                    });
                  } else {
                    // Normal result - add visual change info only (no screenshot to save tokens)
                    functionResponses.push({ functionResponse: { name: functionCall.name, response: this.addVisualChangeInfoToToolResult(this.stripConsoleMessages(toolResult), visualChangeInfo) } });
                  }
                }
              } catch (error) {
                console.error('Error enhancing response with screenshot:', error);
                // Fall back to original result
                functionResponses.push({
                  functionResponse: {
                    name: functionCall.name,
                    response: this.stripConsoleMessages(toolResult)
                  }
                });
              }
            } catch (error) {
              console.error(`Error executing tool ${functionCall.name}:`, error);
              
              // Emit tool execution error event
              this.emitToolEvent('tool-execution-error', {
                toolId,
                toolName: functionCall.name,
                error: error.message || error.toString()
              });
              
              functionResponses.push({
                functionResponse: {
                  name: functionCall.name,
                  response: { 
                    content: [{
                      text: `### Result\nError: ${error.message}`
                    }],
                    isError: true
                  }
                }
              });
            }
          }
        }

        if (currentFunctionCalls.length > 0) {
          // Add model's function call and our responses to contents
          contents.push({ 
            role: 'model', 
            parts: currentFunctionCalls.map(fc => ({ functionCall: fc })) 
          });
          contents.push({ 
            role: 'user', 
            parts: functionResponses.map(fr => ({ functionResponse: fr.functionResponse })) 
          });

          if (textContent) {
            // This message will not get chance to show up in the UI, hence pushing it now itself to UI.
            this.sendAssistantMessage(textContent);
          }
        }
        logger.debug("Will loop if currentFunctionCalls.length > 0. It is actually: ", currentFunctionCalls.length);
        
      } while (currentFunctionCalls.length > 0);
      
      // Check if LLM gave up during playbook execution
      if (this.isPlaybookMode && currentFunctionCalls.length === 0 && textContent) {
        // Detect refusal patterns in the text
        const refusalPatterns = [
          /I cannot/i,
          /I am unable/i,
          /I do not have/i,
          /I don't have/i,
          /cannot fulfill/i,
          /unable to/i,
          /not possible/i
        ];
        
        const hasRefusal = refusalPatterns.some(pattern => pattern.test(textContent));
        
        if (hasRefusal) {
          logger.error('[Playbook] LLM gave up on step:', textContent.substring(0, 200));
          throw new Error('LLM was unable to complete the step. Stopping playbook execution.');
        }
      }
      
      // Update conversation history for next turn - convert contents to history format
      this.conversationHistory = contents.map(c => ({
        role: c.role,
        parts: c.parts
      }));
      
      // Add final model response to history
      if (response) {
        this.conversationHistory.push({
          role: 'model',
          parts: response.content?.parts || []
        });
      }
      
      // Prune history to keep it manageable, while preserving conversation structure.
      this.pruneHistory();

      return textContent || 'I executed the requested action.';
    } catch (error) {
      console.error('Error processing message with Gemini:', error);
      
      if (error.message && error.message.includes('API key')) {
        const apiKeyError = new Error('Please set your GEMINI_API_KEY in the .env file.');
        apiKeyError.status = 401;
        apiKeyError.statusText = 'Unauthorized';
        throw apiKeyError;
      }
      
      // Re-throw the error to be handled by main.js
      // Gemini errors already have status and statusText properties
      throw error;
    }
  }

  clearHistory() {
    this.conversationHistory = [];
    // Also clear Fara-specific history if it exists
    if (this._faraHistory) {
      this._faraHistory = [];
    }
    if (this._faraFacts) {
      this._faraFacts = [];
    }
  }

  getActionLog() {
    return this.actionLog;
  }

  clearActionLog() {
    this.actionLog = [];
  }

  getValidationResults() {
    return this.validationResults;
  }

  clearValidationResults() {
    this.validationResults = [];
  }

  /**
   * Generate a Playwright test script from the action log
   * @returns {Promise<string>} - The generated Playwright test script
   */
  async generatePlaywrightScript() {
    if (this.provider !== 'gemini' && this.provider !== 'fara') {
      throw new Error('Playwright script generation is only supported with Gemini or Fara providers');
    }
    
    // Fara is a vision/automation model, use Gemini-style prompt parsing for script generation
    if (this.provider === 'fara') {
      throw new Error('Playwright script generation with Fara is not yet implemented. Please use Gemini provider for script generation.');
    }

    if (this.actionLog.length === 0) {
      throw new Error('No actions recorded. Please perform some browser automation first.');
    }

    // Create a prompt for Gemini to generate Playwright script
    const prompt = `You are an expert Playwright test automation engineer. I will provide you with a log of browser automation actions that were performed. Your task is to generate a reliable, optimal, and executable Playwright test script that replicates these exact actions.

**Requirements:**
1. Generate a complete, runnable Playwright test script
2. Use TypeScript syntax
3. Include proper imports and test structure
4. Add appropriate waits and assertions where needed
5. Handle navigation, clicks, typing, and other actions
6. Use best practices for selector stability (prefer role-based selectors over XPath when possible)
7. Add comments explaining each major step
8. Include error handling where appropriate
9. The script should be executable with: npx playwright test
10. Use Page Object Model pattern if the test is complex

**Action Log (JSON):**
\`\`\`json
${JSON.stringify(this.actionLog, null, 2)}
\`\`\`

**Tool to Playwright Mapping:**
- browser_navigate → await page.goto(url)
- browser_click → await page.click(selector) or await page.locator(selector).click()
- browser_mouse_click_xy → await page.mouse.click(x, y)
- browser_type → await page.fill(selector, text) or await page.locator(selector).fill(text)
- browser_press → await page.keyboard.press(key)
- browser_select → await page.selectOption(selector, value)
- browser_hover → await page.hover(selector)
- browser_scroll → await page.evaluate(() => window.scrollBy(x, y))
- browser_wait → await page.waitForTimeout(ms)

**Important Notes:**
- For clicks with 'ref' parameter, you'll need to convert them to appropriate selectors
- For coordinate-based clicks (browser_mouse_click_xy), use page.mouse.click(x, y)
- Add proper waiting strategies (waitForLoadState, waitForSelector) after navigation
- Include a viewport size setup if coordinate clicks are used, like \`page.setViewportSize({ width: 1920, height: 1080 });\`
- Add meaningful test name and description

Please generate ONLY the Playwright test script code. Do not include any explanation or additional text outside the code block.`;

    try {
      logger.info('[Script Generation] Generating Playwright script from action log...');
      
      // Use Gemini to generate the script (without function calling)
      const response = await this.client.models.generateContent({
        model: this.modelName,
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        config: {
          temperature: 0.3, // Low temperature for consistent code generation
          maxOutputTokens: 8000 // Allow for longer scripts
        }
      });

      const result = response.candidates[0];
      const generatedText = result.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
      
      // Extract code from markdown code blocks if present
      let scriptCode = generatedText;
      const codeBlockMatch = generatedText.match(/```(?:typescript|javascript)?\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        scriptCode = codeBlockMatch[1];
      }

      logger.info('[Script Generation] Successfully generated Playwright script');
      return scriptCode.trim();
    } catch (error) {
      logger.error('[Script Generation] Error generating Playwright script:', error);
      throw new Error(`Failed to generate Playwright script: ${error.message}`);
    }
  }
}

module.exports = LLMService;
