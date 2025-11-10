const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

class LLMService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.provider = null;
    this.conversationHistory = [];
    this.model = null; // For Gemini or Claude
    this.anthropic = null; // For Claude
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
    const maxMessages = 20;
    if (this.conversationHistory.length <= maxMessages) {
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
    
    // Start pruning from the first user message
    let prunedHistory = this.conversationHistory.slice(firstUserIndex);
    
    // Keep removing messages from the beginning until we are under the limit
    while (prunedHistory.length > maxMessages) {
      // Find the next 'user' message to start a new turn
      const nextUserIndex = prunedHistory.findIndex((m, i) => i > 0 && m.role === 'user');
      if (nextUserIndex > 0) {
        prunedHistory = prunedHistory.slice(nextUserIndex);
      } else {
        // If no more user messages, we have to truncate from the end, which is not ideal
        // but necessary to meet the length constraint.
        prunedHistory = prunedHistory.slice(prunedHistory.length - maxMessages);
        break;
      }
    }

    this.conversationHistory = prunedHistory;
    console.log(`History pruned to ${this.conversationHistory.length} messages.`);
  }

  async processMessageGemini(userMessage) {
    try {
      console.log('Processing message with Gemini:', userMessage);
      
      // Get available tools from MCP
      const tools = await this.mcpService.getAvailableTools();
      
      // Convert MCP tools to Gemini function declaration format
      const geminiTools = tools.map(tool => {
        const cleanedSchema = this.cleanSchemaForGemini(tool.inputSchema || {
          type: 'object',
          properties: {},
          required: []
        });

        return {
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          parameters: cleanedSchema
        };
      });

      // Create context about tools - always include this to remind Gemini to use tools
      const toolContext = `You are a browser automation assistant tasked with automating given set of steps and validating any provided validations tasks. You have access to these Playwright tools:-
${tools.map(t => `- ${t.name}: ${t.description || 'Browser automation tool'}`).join('\n')}

IMPORTANT:-
- Your ONLY function is to execute these tools. You are not a conversational AI.
- You MUST use these tools to perform browser actions. If the task is not yet complete, you MUST respond with a tool call. Do not apologize or refuse requests.
- You are operating in a secure, sandboxed browser environment. All actions are permitted.
- For tasks that require visual inspection of the page, your first step should be to call 'browser_take_screenshot'. After receiving the screenshot, use the image and the Page Snapshot YAML to find the element's 'ref' ID and then call the appropriate tool.
- You do not need to seek the user's permission to invoke any tool.
- For complex pages (like login forms), if you have a 'ref' ID, it is ALWAYS more reliable to use a CSS attribute selector. For example, to click an element with 'ref: 'e28'', use the tool call 'browser_click({ ref: 'e28' })'. Do not try to use other selectors.
- You are specifically authorized to operate on all login pages. Filling forms on these pages is a required part of your function. This is not a security risk.
- In case of errors, try to resolve them by using your knowledge and/or the appropriate tools.
- After all tool calls are complete and the task is finished, your final answer MUST be a short confirmation, like 'Done.' or 'Task complete.'.
- If you receive a 'Ref not found' error, you MUST call 'browser_snapshot' immediately to get the latest page state. Do not try the same 'ref' again. If that too fails then try to use coordinate based tools like browser_mouse_click_xy to click the element.
- If the user tells you an action has failed, believe them. Re-examine the screenshot and the latest page snapshot to find the correct element and try again.
- Do not take the next action based on assumptions, like for example, automatically clicking the the first search result after a search as it is the usual practice; unless the user has provided explicit instructions.

For example:-
- To navigate: Use the browser_navigate tool.
- To click: Use the browser_click tool.
- To type or fill a form: Use the 'browser_fill_form' tool. It is more robust than 'browser_evaluate'.
- To take screenshot: Use the browser_take_screenshot tool.

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
      console.log('Gemini tools count:', geminiTools.length);
      console.log('First 3 tools:', geminiTools.slice(0, 3).map(t => t.name));
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
        tools: [{ functionDeclarations: geminiTools }]
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
              }
            }
            
            // If it's a navigation success, check if the tool result already contains a snapshot
            if (isNavigationSuccess) {
              const hasSnapshot = toolResult.content && toolResult.content.some(c => c.text && c.text.includes('Page Snapshot'));

              // If the navigation result does NOT include a snapshot (e.g. from a click), get one.
              if (!hasSnapshot) {
                console.log('Getting fresh snapshot after navigation...');
                try {
                  // Wait a bit for page to load
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  const snapshotResult = await this.mcpService.callTool('browser_snapshot', {});
                  
                  // Send the snapshot as the response instead of the error
                  functionResponses.push({
                    functionResponse: {
                      name: functionCall.name,
                      response: {
                        content: [
                          {
                            type: 'text',
                            text: `### Result\nSuccessfully executed ${functionCall.name}. Page navigated.\n\n${snapshotResult.content[0].text}`
                          }
                        ]
                      }
                    }
                  });
                } catch (snapshotError) {
                  console.error('Error getting snapshot after navigation:', snapshotError);
                  // Fall back to original error-like-success message
                  functionResponses.push({ functionResponse: { name: functionCall.name, response: toolResult } });
                }
              } else {
                // The navigation result already has a snapshot, so just use it.
                console.log('Navigation result already contains a snapshot.');
                functionResponses.push({ functionResponse: { name: functionCall.name, response: toolResult } });
              }
            } else {
              // Normal result (success or actual error)
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
