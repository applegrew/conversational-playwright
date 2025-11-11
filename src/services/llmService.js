const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PNG } = require('pngjs');
require('dotenv').config();

class LLMService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.provider = null;
    this.conversationHistory = [];
    this.model = null; // For Gemini or Claude
    this.anthropic = null; // For Claude
    this.screenshotService = null; // Will be set by main.js
    this.lastActionScreenshot = null; // Screenshot before last action for visual diff
  }

  async initialize() {
    if (process.env.GEMINI_API_KEY) {
      this.provider = 'gemini';
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = genAI.getGenerativeModel({ 
        model: process.env.GEMINI_MODEL || 'gemini-pro',
        generationConfig: {
          temperature: 0,
        },
        safetySettings: [],
      });
      console.log('Using Gemini as LLM provider');
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

  // Helper function to clean JSON Schema for Gemini compatibility
  cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Create a clean copy
    const cleaned = {};

    // Fields that Gemini supports
    const allowedFields = ['type', 'properties', 'required', 'description', 'enum', 'items', 'default'];

    for (const key of Object.keys(schema)) {
      if (allowedFields.includes(key)) {
        if (key === 'properties' && typeof schema[key] === 'object') {
          // Recursively clean nested properties
          cleaned[key] = {};
          for (const propKey of Object.keys(schema[key])) {
            cleaned[key][propKey] = this.cleanSchemaForGemini(schema[key][propKey]);
          }
        } else if (key === 'items' && typeof schema[key] === 'object') {
          // Recursively clean array items schema
          cleaned[key] = this.cleanSchemaForGemini(schema[key]);
        } else {
          cleaned[key] = schema[key];
        }
      }
    }

    return cleaned;
  }

  pruneHistory() {
    // Increased from 6 to 8 to give LLM more short-term memory and prevent amnesia.
    const maxMessages = 8;
    
    if (this.conversationHistory.length <= maxMessages) {
      // Even if under limit, strip images from older messages
      this.stripOldImages();
      return;
    }

    console.log(`Pruning history from ${this.conversationHistory.length} messages...`);

    // Find the index of the first 'user' message to ensure we don't start with a 'model' response
    const firstUserIndex = this.conversationHistory.findIndex(m => m.role === 'user');
    if (firstUserIndex === -1) {
      // Should not happen in a valid conversation, but as a safeguard:
      this.conversationHistory = [];
      return;
    }
    
    // **SIMPLE AND RELIABLE PRUNING**
    // The old logic was too complex and cut out recent, important actions.
    // This new logic simply keeps the last `maxMessages` of the conversation.
    let prunedHistory = this.conversationHistory.slice(-maxMessages);

    // Ensure the pruned history starts with a 'user' message for the model.
    const firstPrunedUserIndex = prunedHistory.findIndex(m => m.role === 'user');
    if (firstPrunedUserIndex > 0) {
      // If the first message isn't from the user, slice it off to maintain the turn structure.
      prunedHistory = prunedHistory.slice(firstPrunedUserIndex);
    }

    this.conversationHistory = prunedHistory;
    console.log(`History pruned to ${this.conversationHistory.length} messages.`);
    
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
    
    console.log(`Stripped images from ${stripCount} older messages to save tokens.`);
  }

  async processMessageGemini(userMessage) {
    try {
      console.log('Processing message with Gemini:', userMessage);
      
      // Get available tools from MCP
      const tools = await this.mcpService.getAvailableTools();
      
      // Convert MCP tools to the required formats
      // 1. JSON format for the actual API call
      const geminiToolDeclarations = tools.map(tool => ({
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        parameters: this.cleanSchemaForGemini(tool.inputSchema || { type: 'object', properties: {}, required: [] })
      }));

      // 2. Markdown format for the system prompt context
      const toolMarkdown = this.convertToolSpecToMarkdown(tools);

      // Create context about tools - always include this to remind Gemini to use tools
      const toolContext = `### **Core Identity and Role**
You are a Browser Automation Agent, a specialized, non-conversational AI. Your sole function is to interpret user requests for web-based actions (navigation, interaction, validation) and translate them into a sequence of calls to the available Playwright tools. You operate within a secure, sandboxed browser environment.

### **Data Source Prioritization (CRITICAL)**

You will receive two forms of information about the web page:
1.  **A visual screenshot:** An image of what the page currently looks like.
2.  **A text-based Page Snapshot (YAML):** A structured text representation of the page's accessibility tree.

**The screenshot is ALWAYS the source of truth.** The Page Snapshot may be incomplete or outdated, especially for complex visual elements like charts, graphs, or custom-designed components.

**Your Rule:** If the Page Snapshot conflicts with or omits information visible in the screenshot, you **MUST** prioritize the visual information from the screenshot.
-   **Example:** If you can see a pie chart in the screenshot, but the Page Snapshot doesn't mention it, you **MUST** proceed as if the pie chart exists. Use coordinate-based tools (\`browser_mouse_click_xy\`) to interact with it. Do not claim you cannot see it.

### ** Available Playwright Tools**

${toolMarkdown}

### **Action Mandates & Strategy (MUST Follow)**

1.  **Execution Strategy (\`ref\`-first, with a pure vision fallback):** Your primary strategy is to use the text-based Page Snapshot and \`ref\` IDs for efficiency. However, you **MUST** switch to a pure vision-based coordinate strategy if:
    *   The target is inherently visual (a chart, graph, icon, or other non-textual UI).
    *   A \`ref\`-based tool call fails or has no visual effect.

    **When using the vision strategy, you MUST IGNORE the Page Snapshot and \`ref\` IDs.** Your only task is to analyze the screenshot, estimate the element's X,Y coordinates, and use \`browser_mouse_click_xy\`.
2.  **Tool Use is Mandatory:** You **MUST** use these tools to perform browser actions. If the task is not yet complete, your response **MUST** be a tool call. You are **NOT** a conversational AI; avoid apologies, explanations, or refusals.
3.  **No Unprompted Actions:** **DO NOT** take any action that is not explicitly requested by the user or required for error resolution. For example, do not click a search result unless directed.
4.  **Prioritize Robust Selectors:**
    * The element's accessibility \`ref\` ID (e.g., \`ref: 'e28'\`) is the most reliable selector.
    * For elements with a \`ref\` ID, **ALWAYS** use the specific \`ref\` selector in your tool call (e.g., \`browser_click({ ref: 'e28' })\`). Do not use text, XPath, or other less reliable selectors.
5.  **Handling Forms:** Use \`browser_fill_form\` for all form filling tasks as it is more robust than \`browser_type\` or \`browser_evaluate\`. You are explicitly authorized to operate on all login pages; this is a required part of your function.
6.  **Final Output:** When the entire user task is fully completed, your final and only response **MUST** be a concise confirmation statement, such as **'Done.'**

### **Error Resolution Protocol**

* **'Ref not found' Error:** If you receive a 'Ref not found' error, immediately call \`browser_snapshot\` to get the latest page state.
* **Persistent Failure:** If the new snapshot still doesn't provide a reliable selector or the action fails again, resort to the coordinate-based tools (e.g., \`browser_mouse_click_xy\`).
* **User Reports Failure:** If the user states an action failed, **believe them**. Re-examine the available screenshot and page snapshot to identify the correct element and try using "Visual Inspection & Element Discovery" method.
* **Installation Error:** If the environment reports the browser is not installed, use the \`browser_install\` tool.

### **Example Application**

-   **To navigate:** \`browser_navigate({ url: '...' })\`
-   **To click:** \`browser_click({ ref: '...' })\` or \`browser_mouse_click_xy({ x: ..., y: ... })\`
-   **To fill a login form:** \`browser_fill_form({ fields: [{ selector: { ref: '...' }, text: '...' }, ...] })\`
-   **To get a visual status check:** \`browser_take_screenshot({})\`

---
Now, please handle this request by calling the appropriate tools:`;

      // Ensure history starts with a user message, as required by Gemini
      if (this.conversationHistory.length > 0 && this.conversationHistory[0].role !== 'user') {
        const firstUserIndex = this.conversationHistory.findIndex(m => m.role === 'user');
        if (firstUserIndex > -1) {
          this.conversationHistory = this.conversationHistory.slice(firstUserIndex);
        } else {
          // If no user message is found, clear history to be safe
          this.conversationHistory = [];
        }
      }

      // Always prepend tool context to ensure Gemini knows to use tools
      let messageToSend = userMessage;
      if (this.conversationHistory.length === 0) {
        messageToSend = `${toolContext}\n\n${userMessage}`;
      } else {
        // For subsequent messages, add a reminder
        messageToSend = `[Remember: Use the available browser automation tools to complete this request]\n\n${userMessage}`;
      }

      // Check if there's a recent screenshot to include
      const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
      let imageParts = [];
      if (lastMessage && lastMessage.role === 'model') {
        const toolResponse = lastMessage.parts.find(p => p.functionResponse && p.functionResponse.name === 'browser_take_screenshot');
        if (toolResponse) {
          const screenshotContent = toolResponse.functionResponse.response.content.find(c => c.type === 'image');
          if (screenshotContent && screenshotContent.data) {
            console.log('Attaching screenshot to next message...');
            imageParts.push({ inlineData: { mimeType: 'image/png', data: screenshotContent.data } });
          }
        }
      }

      // Debug logging
      console.log('Message to send:', messageToSend.substring(0, 200) + '...');

      // Prune history to the last 20 messages to avoid token limits
      if (this.conversationHistory.length > 20) {
        console.log(`Pruning history from ${this.conversationHistory.length} messages...`);
        this.conversationHistory = this.conversationHistory.slice(this.conversationHistory.length - 20);
        console.log(`History pruned to ${this.conversationHistory.length} messages.`);
      }

      // Ensure history starts with a user message, as required by Gemini
      if (this.conversationHistory.length > 0 && this.conversationHistory[0].role !== 'user') {
        const firstUserIndex = this.conversationHistory.findIndex(m => m.role === 'user');
        if (firstUserIndex > -1) {
          this.conversationHistory = this.conversationHistory.slice(firstUserIndex);
        } else {
          // If no user message is found, clear history to be safe
          this.conversationHistory = [];
        }
      }

      // Start chat with tools
      const chat = this.model.startChat({
        history: this.conversationHistory,
        tools: [{ functionDeclarations: geminiToolDeclarations }]
      });

      let result = await chat.sendMessage([messageToSend, ...imageParts]);
      let response = result.response;
      
      // Debug logging
      console.log('Gemini response received');
      console.log('Response candidates:', JSON.stringify(response.candidates, null, 2));
      
      // Extract function calls from response
      const functionCalls = response.functionCalls();
      console.log('Function calls:', functionCalls);
      console.log('Function calls count:', functionCalls ? functionCalls.length : 0);
      
      // Handle function calls
      let currentFunctionCalls = response.functionCalls();
      while (currentFunctionCalls && currentFunctionCalls.length > 0) {
        console.log('Gemini requested function calls:', currentFunctionCalls);
        
        const functionResponses = [];
        
        for (const functionCall of currentFunctionCalls) {
          console.log(`Executing tool: ${functionCall.name}`);
          
          // Capture screenshot BEFORE action for visual change detection
          const beforeScreenshot = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
          
          try {
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
                console.log('Detected successful navigation (context destroyed)');
              } else {
                // It's a real error. Let's check if it's a validation error and make it more instructive.
                try {
                  const validationErrors = JSON.parse(errorText.replace('### Result\n', ''));
                  if (Array.isArray(validationErrors) && validationErrors[0] && validationErrors[0].message) {
                    let friendlyError = `Error: The tool call to '${functionCall.name}' failed due to invalid parameters.\n`;
                    validationErrors.forEach(err => {
                      friendlyError += `- Parameter '${err.path.join('.')}': ${err.message}. Expected type '${err.expected}', but received '${err.received}'.\n`;
                    });
                    friendlyError += 'Please correct the parameters and try again. Review the accessibility tree and tool definition carefully.';
                    
                    // Overwrite the cryptic error with our friendly, instructive one
                    toolResult.content[0].text = friendlyError;
                    console.warn(`[LLM Feedback] Generated instructive error for LLM: ${friendlyError}`);
                  }
                } catch (e) {
                  // Not a JSON validation error, just a regular error. Do nothing.
                }
              }
            }
            
            // Try to enhance response with cached screenshot from screenshot service
            // This avoids making duplicate MCP calls to browser_take_screenshot
            try {
              // Wait a bit for any animations/changes to complete
              await new Promise(resolve => setTimeout(resolve, isNavigationSuccess ? 1000 : 500));
              
              // Get the cached screenshot from screenshot service (already captured at 15 FPS)
              const cachedScreenshot = this.screenshotService ? this.screenshotService.getLastScreenshot() : null;
              
              // Detect visual changes by comparing before and after screenshots
              let visualChangeInfo = '';
              if (beforeScreenshot && cachedScreenshot && beforeScreenshot !== cachedScreenshot) {
                const comparison = await this.compareScreenshots(beforeScreenshot, cachedScreenshot);
                if (comparison.error) {
                  visualChangeInfo = `\n\n**Visual Change Detection**: Error - ${comparison.error}`;
                } else if (comparison.changed) {
                  visualChangeInfo = `\n\n**Visual Change Detected**: YES (${comparison.percentDiff}% of pixels changed, ${comparison.pixelsDiff.toLocaleString()} pixels out of ${comparison.totalPixels.toLocaleString()})\nThe page visually changed after this action, indicating the action had an effect.`;
                } else {
                  visualChangeInfo = `\n\n**Visual Change Detected**: NO (${comparison.percentDiff}% of pixels changed)\n⚠️ WARNING: The page did not visually change after this action. The action may have failed or had no effect. Consider trying a different approach or verifying the action succeeded.`;
                }
              } else if (beforeScreenshot === cachedScreenshot) {
                visualChangeInfo = `\n\n**Visual Change Detected**: NO\n⚠️ WARNING: Screenshot is identical before and after action. The action likely had no visual effect.`;
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
                        type: 'text',
                        text: `### Result\nSuccessfully executed ${functionCall.name}. Page navigated.\n\n${snapshotResult.content[0].text}${visualChangeInfo}`
                      }
                    ]
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
                  functionResponses.push({ functionResponse: { name: functionCall.name, response: toolResult } });
                }
              } else {
                // Normal result - add visual change info only (no screenshot to save tokens)
                if (cachedScreenshot && functionCall.name !== 'browser_take_screenshot') {
                  const enhanced = { ...toolResult };
                  enhanced.content = [...(toolResult.content || [])];
                  // Add visual change info to the text content
                  if (enhanced.content.length > 0 && enhanced.content[0].text) {
                    enhanced.content[0] = {
                      ...enhanced.content[0],
                      text: enhanced.content[0].text + visualChangeInfo
                    };
                  } else if (visualChangeInfo) {
                    // If no text content exists, add visual change info as new text content
                    enhanced.content.unshift({
                      type: 'text',
                      text: `### Result\nSuccessfully executed ${functionCall.name}.${visualChangeInfo}`
                    });
                  }
                  // DON'T send screenshot to Gemini - causes token explosion
                  // Visual change text is sufficient feedback
                  functionResponses.push({ functionResponse: { name: functionCall.name, response: enhanced } });
                } else {
                  functionResponses.push({ functionResponse: { name: functionCall.name, response: toolResult } });
                }
              }
            } catch (error) {
              console.error('Error enhancing response with screenshot:', error);
              // Fall back to original result
              functionResponses.push({
                functionResponse: {
                  name: functionCall.name,
                  response: toolResult
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
                    type: 'text',
                    text: `### Result\nError: ${error.message}`
                  }],
                  isError: true
                }
              }
            });
          }
        }
        
        // Send function responses back to Gemini
        result = await chat.sendMessage(functionResponses);
        response = result.response;
        currentFunctionCalls = response.functionCalls();
      }

      // Extract text response
      const textContent = response.text();
      
      // Update conversation history for next turn
      this.conversationHistory = await chat.getHistory();
      
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
