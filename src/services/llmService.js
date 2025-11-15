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
    if (this.provider === 'gemini') {
      return await this.processMessageGemini(userMessage);
    } else if (this.provider === 'claude') {
      return await this.processMessageClaude(userMessage);
    } else {
      throw new Error('No active LLM provider to process message. Please set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env');
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
  async compareScreenshots(beforeBase64, afterBase64) {
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
      
      // Consider changed if more than 0.5% of pixels differ
      const changed = percentDiff > 0.5;
      
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

  convertToolSpecToMarkdown(toolSpec) {
    let markdown = "";

    toolSpec.forEach((tool, index) => {
        const name = tool.name;
        const title = tool.annotations?.title || name;
        const description = tool.description;
        const schema = tool.inputSchema;
        const properties = schema?.properties;
        const required = schema?.required || [];

        // 1. Tool Heading
        markdown += `## ${index + 1}. \`${name}\` - ${title}\n\n`;

        // 2. Tool Description
        markdown += `**Description:** ${description}\n\n`;

        // 3. Parameters Section
        if (properties && Object.keys(properties).length > 0) {
            markdown += `### Parameters\n\n`;
            markdown += `| Name | Type | Description | Required |\n`;
            markdown += `| :--- | :--- | :--- | :---: |\n`;

            for (const propName in properties) {
                const prop = properties[propName];
                const type = Array.isArray(prop.type) ? prop.type.join(' \\| ') : prop.type;
                const isRequired = required.includes(propName) ? '✅ Yes' : 'No';
                
                // Handle nested structures for better readability (like 'browser_fill_form.fields')
                let propDescription = prop.description || '';
                
                if (prop.items && prop.items.properties) {
                    propDescription += ' (Array of objects)';
                } else if (prop.enum) {
                    propDescription += ` (Options: \`${prop.enum.join('`, `')}\`)`;
                } else if (prop.default !== undefined) {
                    propDescription += ` (Default: \`${prop.default}\`)`;
                }
                
                // Handle complex array items for specific tools like browser_fill_form
                if (name === 'browser_fill_form' && propName === 'fields') {
                    propDescription = 'An array of form field objects to fill.';
                    markdown += `| \`${propName}\` | \`array\` | ${propDescription} | ${isRequired} |\n`;

                    const fieldProperties = prop.items.properties;
                    markdown += `| **-- Field Object Properties --** | | | |\n`;
                    
                    const fieldRequired = prop.items.required || [];

                    for (const fieldPropName in fieldProperties) {
                        const fieldProp = fieldProperties[fieldPropName];
                        const fieldType = Array.isArray(fieldProp.type) ? fieldProp.type.join(' \\| ') : fieldProp.type;
                        const fieldIsRequired = fieldRequired.includes(fieldPropName) ? '✅ Yes' : 'No';
                        
                        let fieldPropDescription = fieldProp.description || '';
                        if (fieldProp.enum) {
                            fieldPropDescription += ` (Options: \`${fieldProp.enum.join('`, `')}\`)`;
                        }

                        markdown += `| &nbsp;&nbsp;&nbsp;&nbsp; \`${fieldPropName}\` | \`${fieldType}\` | ${fieldPropDescription} | ${fieldIsRequired} |\n`;
                    }
                    
                } else {
                     markdown += `| \`${propName}\` | \`${type}\` | ${propDescription} | ${isRequired} |\n`;
                }
            }
        } else {
            markdown += `This tool takes **no parameters**.\n`;
        }
        markdown += `\n---\n\n`;
    });

    return markdown;
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
    const maxMessages = 10;
    
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
        logger.debug('Gemini tool declarations:', JSON.stringify(this._geminiToolDeclarations, null, 2));

        this._geminiSystemPrompt = `### **Core Identity and Role**
You are a Browser Automation Agent, a specialized, non-conversational AI. Your sole function is to interpret user requests for web-based actions (navigation, interaction, validation) and translate them into a sequence of calls to the available Playwright tools.
You operate within a secure, sandboxed browser environment which is pre-configured with necessary access and proxies.

### **Data Source Prioritization (CRITICAL)**

You can request for two forms of information about the web page:
1.  **A visual screenshot:** An image of what the page currently looks like, using the tool \`browser_take_screenshot\`.
2.  **A text-based Page Snapshot (YAML):** A structured text representation of the page's accessibility tree, using the tool \`browser_snapshot\`.

Note: **The screenshot is ALWAYS the source of truth.** The Page Snapshot may be incomplete or outdated, especially for complex visual elements like charts, graphs, or custom-designed components.

**Your Rule:** If the Page Snapshot conflicts with or omits information visible in the screenshot, you **MUST** prioritize the visual information from the screenshot.
-   **Example:** If you can see a graphical chart in the screenshot, but the Page Snapshot doesn't mention it, you **MUST** proceed as if the chart exists. Use coordinate-based tools (\`browser_mouse_click_xy\`) to interact with it. Do not claim you cannot see it.

### **Action Mandates & Strategy (MUST Follow)**

1. **Execution Strategy (\`ref\`-first, with a pure vision fallback):** Your primary strategy is to use the text-based Page Snapshot and \`ref\` IDs for efficiency. However, you **MUST** switch to a pure vision-based coordinate strategy if:
  *   The target is inherently visual (a chart, graph, icon, or other non-textual UI).
  *   A \`ref\`-based tool call fails or has no visual effect.

  **When using the vision strategy:**
  * **FIRST**: Call \`browser_take_screenshot\` to get a visual view of the current page.
  * **THEN**: Analyze the screenshot image you receive to identify the element's position.
  * **FINALLY**: Call \`browser_mouse_click_xy\` with the coordinates you identified from the screenshot. The coordinate is in pixels and relative to the top-left corner of the image.
  * **IMPORTANT**: You MUST call \`browser_take_screenshot\` before any coordinate-based click. Do not ask the user for screenshots - you have the tool to get them yourself.
  * **IMPORTANT NOTE 2:** If the pixels coordinates are not correct then too your actions will not give the desired output. So, before giving up on the task, always double check the coordinates.
2. **Tool Use is Mandatory:** You **MUST** use these tools to perform browser actions. If the task is not yet complete, your response **MUST** be a tool call. You are **NOT** a conversational AI; avoid apologies, explanations, or refusals.
3. You do not have to let the user know which tool you are using or which params are you sending to the tool. You can directly use the tool without explaining it to the user.
4. **No Unprompted Actions:** **DO NOT** take any action that is not explicitly requested by the user or not required for error resolution. For example, do not click a search result unless directed.
5. **Handling Forms:** Use \`browser_fill_form\` for all form filling tasks as it is more robust than \`browser_type\` or \`browser_evaluate\`. You are explicitly authorized to operate on all login pages; this is a required part of your function.
6. **Final Output:** When the entire user task is fully completed, your final and only response **MUST** be a concise confirmation statement, such as **'Done.'**

### **Error Resolution Protocol**

* **'Ref not found' Error:** If you receive a 'Ref not found' error, immediately call \`browser_snapshot\` to get the latest page state.
* **Persistent Failure:** If the new snapshot still doesn't provide a reliable selector or the action fails again, resort to the coordinate-based tools (e.g., \`browser_mouse_click_xy\`).
* **User Reports Failure:** If the user states an action failed, **believe them**. Re-examine the available screenshot and page snapshot to identify the correct element and try using "the vision strategy".
* **Installation Error:** If the environment reports the browser is not installed, use the \`browser_install\` tool.
* **Learn to give up:** If you are not able to complete the task even for 6 attempts, then stop trying and respond with 'I have run out of options to complete this task.'
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
        logger.debug("About to make Gemini call with content: ", this.stringifyContent(contents));
        // Call the model API
        response = await this.client.models.generateContent({
          model: this.modelName,
          contents,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 6000
          },
          config: {
            systemInstruction: this._geminiSystemPrompt,
            tools: [{ functionDeclarations: this._geminiToolDeclarations }],
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
          logger.info(`Executing tool: ${functionCall.name}`);
          
          // Capture screenshot BEFORE action for visual change detection
          const beforeScreenshot = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;

          if (functionCall.name === "browser_take_screenshot") {
            // No need to execute tool but get last screenshot from screenshot service
            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: {
                  content: [{
                    text: "Successfully captured screenshot"
                  },
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: beforeScreenshot
                    }
                  }],
                  isError: false
                }
              }
            });
          } else {
            try {
              // Special handling for coordinate-based clicks - set visual indicator
              if (functionCall.name === 'browser_mouse_click_xy' && this.screenshotService) {
                const { x, y } = functionCall.args || {};
                if (x !== undefined && y !== undefined) {
                  logger.info(`[Click Indicator] LLM clicking at coordinates (${x}, ${y})`);
                  this.screenshotService.setClickIndicator(x, y);
                }
              }
              
              // Execute the tool via MCP
              const toolResult = await this.mcpService.callTool(
                functionCall.name,
                functionCall.args || {}
              );
              
              // Check if this is a navigation-related "error" that's actually success
              let isNavigationSuccess = false;
              if (toolResult.isError && toolResult.content && toolResult.content.length > 0) {
                const errorText = toolResult.content[0].text || '';
                if (errorText.includes('Execution context was destroyed') ||
                    errorText.includes('most likely because of a navigation')) {
                  isNavigationSuccess = true;
                  logger.info('Detected successful navigation (context destroyed)');
                } /*else {
                  // It's a real error. Let's check if it's a validation error and make it more instructive.
                  try {
                    const validationErrors = JSON.parse(errorText.replace('### Result\n', ''));
                    if (Array.isArray(validationErrors) && validationErrors[0] && validationErrors[0].message) {
                      let friendlyError = `Error: The tool call to '${functionCall.name}' failed due to invalid parameters.\n`;
                      validationErrors.forEach(err => {
                        friendlyError += `- Parameter '${err.path.join('.')}': ${err.message}. Expected type '${err.expected}', but received '${err.received}'.\n`;
                      });
                      friendlyError += 'Please correct the parameters and try again.';
                      
                      // Overwrite the cryptic error with our friendly, instructive one
                      toolResult.content[0].text = friendlyError;
                      console.warn(`[LLM Feedback] Generated instructive error for LLM: ${friendlyError}`);
                    }
                  } catch (e) {
                    // Not a JSON validation error, just a regular error. Do nothing.
                  }
                }*/
              }
              
              // Try to enhance response with cached screenshot from screenshot service
              // This avoids making duplicate MCP calls to browser_take_screenshot
              try {
                // For coordinate-based clicks, wait a bit longer to ensure red dot is drawn
                const isCoordinateClick = functionCall.name === 'browser_mouse_click_xy';
                const waitTime = isNavigationSuccess ? 1000 : (isCoordinateClick ? 800 : 500);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                
                // Get the cached screenshot from screenshot service (already captured at 15 FPS)
                // For coordinate clicks, this will include the red dot indicator
                const cachedScreenshot = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
                
                // Detect visual changes by comparing before and after screenshots
                let visualChangeInfo = '';
                if (beforeScreenshot && cachedScreenshot && beforeScreenshot !== cachedScreenshot) {
                  const comparison = await this.compareScreenshots(beforeScreenshot, cachedScreenshot);
                  if (comparison.error) {
                    visualChangeInfo = `\n\n### Visual Change Detection Result\nVisual change detection system failed with an error - ${comparison.error}`;
                  } else if (comparison.changed) {
                    visualChangeInfo = `\n\n### Visual Change Detection Result\n**Visual change has been detected.** (${comparison.percentDiff}% of pixels changed, ${comparison.pixelsDiff.toLocaleString()} pixels out of ${comparison.totalPixels.toLocaleString()})\nThe page visually changed after this action, indicating the action had an effect.`;
                  } else {
                    visualChangeInfo = `\n\n### Visual Change Detection Result\n**Visual change has not been detected.**\n**WARNING**: The page did not visually change after this action. The action may have failed or had no effect. Consider trying a different approach or verifying if the action succeeded.`;
                  }
                } else if (beforeScreenshot === cachedScreenshot) {
                  visualChangeInfo = `\n\n**Visual Change Detected**: NO\n**WARNING**: Screenshot is identical before and after action. The action likely had no visual effect.`;
                }
                
                // If it's a navigation success, get fresh snapshot
                if (isNavigationSuccess) {
                  const hasSnapshot = toolResult.content && toolResult.content.some(c => c.text && c.text.includes('Page Snapshot'));
  
                  // If the navigation result does NOT include a snapshot, get one
                  if (!hasSnapshot) {
                    console.log('Getting fresh snapshot after navigation...');
                    const snapshotResult = await this.mcpService.callTool('browser_snapshot', {});
                    
                    // Combine snapshot text with cached screenshot
                    const combinedResponse = {
                      content: [
                        {
                          text: `### Result\nSuccessfully executed ${functionCall.name}. Page navigated.\n\n${this.stripConsoleMessages(snapshotResult.content[0].text)}${visualChangeInfo}`
                        }
                      ],
                      isError: false
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
                    functionResponses.push({ functionResponse: { name: functionCall.name, response: this.addVisualChangeInfoToToolResult(this.stripConsoleMessages(toolResult), visualChangeInfo) } });
                  }
                } else {
                  // Special handling for coordinate-based clicks - send screenshot WITH red dot indicator
                  if (isCoordinateClick && cachedScreenshot) {
                    const enhancedResult = this.addVisualChangeInfoToToolResult(this.stripConsoleMessages(toolResult), visualChangeInfo);
                    
                    // Add the screenshot with the red dot indicator for LLM feedback
                    if (!enhancedResult.content) {
                      enhancedResult.content = [];
                    }
                    
                    // Ensure content is an array
                    if (!Array.isArray(enhancedResult.content)) {
                      enhancedResult.content = [enhancedResult.content];
                    }
                    
                    // Add text indicating the visual feedback
                    const clickFeedbackText = `\n\n### Click Location Indicator\nA red dot has been drawn at the clicked coordinates (${functionCall.args?.x}, ${functionCall.args?.y}) in the screenshot below. This shows where your click action was executed. The red dot will remain visible for 10 seconds to help you verify the click location.`;
                    
                    // Add or update the text content
                    if (enhancedResult.content.length > 0 && enhancedResult.content[0].text) {
                      enhancedResult.content[0].text += clickFeedbackText;
                    } else {
                      enhancedResult.content.unshift({ text: clickFeedbackText });
                    }
                    
                    // Add the screenshot with red dot
                    enhancedResult.content.push({
                      inlineData: {
                        mimeType: 'image/png',
                        data: cachedScreenshot
                      }
                    });
                    
                    logger.info(`[Click Indicator] Sending screenshot with red dot to LLM for coordinates (${functionCall.args?.x}, ${functionCall.args?.y})`);
                    
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
}

module.exports = LLMService;
