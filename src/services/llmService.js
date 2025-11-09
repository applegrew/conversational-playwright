const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

class LLMService {
  constructor(mcpService) {
    this.mcpService = mcpService;
    this.provider = process.env.LLM_PROVIDER || 'gemini';
    this.conversationHistory = [];
    
    // Initialize the appropriate LLM client
    if (this.provider === 'gemini') {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = this.genAI.getGenerativeModel({ 
        model: process.env.GEMINI_MODEL,
        generationConfig: {
          temperature: 0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        }
      });
      console.log('Using Gemini as LLM provider');
    } else {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      console.log('Using Claude as LLM provider');
    }
  }

  async processMessage(userMessage) {
    if (this.provider === 'gemini') {
      return await this.processMessageGemini(userMessage);
    } else {
      return await this.processMessageClaude(userMessage);
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
      const toolContext = `You are a browser automation assistant with access to these Playwright tools:
${tools.map(t => `- ${t.name}: ${t.description || 'Browser automation tool'}`).join('\n')}

IMPORTANT: You MUST use these tools to perform browser actions. Do not just describe what you would do - actually call the appropriate tools.

For example:
- To navigate: Use browser_navigate tool
- To click: Use browser_click tool
- To type: Use browser_type tool
- To take screenshot: Use browser_take_screenshot tool

Now, please handle this request by calling the appropriate tools:`;

      // Always prepend tool context to ensure Gemini knows to use tools
      let messageToSend = userMessage;
      if (this.conversationHistory.length === 0) {
        messageToSend = `${toolContext}\n\n${userMessage}`;
      } else {
        // For subsequent messages, add a reminder
        messageToSend = `[Remember: Use the available browser automation tools to complete this request]\n\n${userMessage}`;
      }

      // Debug logging
      console.log('Gemini tools count:', geminiTools.length);
      console.log('First 3 tools:', geminiTools.slice(0, 3).map(t => t.name));
      console.log('Message to send:', messageToSend.substring(0, 200) + '...');

      // Start chat with tools
      const chat = this.model.startChat({
        history: this.conversationHistory,
        tools: [{ functionDeclarations: geminiTools }]
      });

      let result = await chat.sendMessage(messageToSend);
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
