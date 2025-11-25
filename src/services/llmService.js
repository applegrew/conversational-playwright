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
    this.validationResults = []; // Track all validation results for assertions/validations
  }

  async initialize() {
    if (process.env.GEMINI_API_KEY) {
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
    } else {
      this.provider = 'none';
      console.warn('No LLM provider API key found. Please set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env');
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
      } else {
        throw new Error('No active LLM provider to process message. Please set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env');
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
          description: 'Record a validation or assertion result for the current page state. Use this when the user asks to validate, verify, or assert any condition based on what is visible on the page. This tool tracks all validations and displays them at the end of a playbook run.',
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

5. **Form Handling:** Use \`browser_fill_form\` for form filling - it's more robust than \`browser_type\` or \`browser_evaluate\`. You are explicitly authorized to operate on all login pages as required.

6. **Validation and Assertions:** When user asks to validate, verify, check, or assert any condition (e.g., "validate that the login button is visible", "check if we're on the dashboard", "assert the error message shows"), you **MUST** use the \`validateScenario\` tool to record the validation result. Analyze the current page state using Page Snapshot or screenshots, determine if the condition passes or fails, and call \`validateScenario\` with the result.

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

`;
        logger.debug('Gemini system prompt:', this._geminiSystemPrompt);
      }

      // Always prepend tool context to ensure Gemini knows to use tools
      let messageToSend = `[Remember: Use the available browser automation tools to complete this request]\n\n${userMessage}`;

      // // Check if there's a recent screenshot to include
      // const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
      // let imageParts = [];
      // if (lastMessage && lastMessage.role === 'model') {
      //   const toolResponse = lastMessage.parts.find(p => p.functionResponse && p.functionResponse.name === 'browser_take_screenshot');
      //   if (toolResponse) {
      //     const screenshotContent = toolResponse.functionResponse.response.content.find(c => c.type === 'image');
      //     if (screenshotContent && screenshotContent.data) {
      //       console.log('Attaching screenshot to next message...');
      //       imageParts.push({ inlineData: { mimeType: 'image/png', data: screenshotContent.data } });
      //     }
      //   }
      // }

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
      // if (imageParts.length > 0) {
      //   currentParts.push(...imageParts.map(img => ({ inlineData: img.inlineData })));
      // }
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
    if (this.provider !== 'gemini') {
      throw new Error('Playwright script generation is only supported with Gemini provider');
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
