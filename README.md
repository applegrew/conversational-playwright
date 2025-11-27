# ConversePlay | Conversational Playwright

A test automation application that combines conversational AI with browser automation using Playwright MCP (Model Context Protocol). Control a headless Chrome browser through natural language instructions and see the happening in real-time.

[![ConversePlay Demo](https://img.youtube.com/vi/9FDx_Yx-prQ/0.jpg)](https://www.youtube.com/watch?v=9FDx_Yx-prQ)
(Demo video on Youtube)

## Features

- 🤖 **Conversational AI Interface**: Chat with an AI assistant to control browser automation
- 🌐 **Playwright MCP Integration**: Uses official `@playwright/mcp` package for browser automation
- 📸 **Real-time Screenshot Streaming**: View browser activity in the canvas area
- 🎨 **Modern UI**: Beautiful dark-themed interface with chat on the left and browser view on the right
- ⚡ **Dual LLM Support**: Choose between Google's Gemini or Anthropic's Claude for intelligent command interpretation

## Prerequisites

- Node.js 18+ and npm
- API key for your chosen LLM provider:
  - **Gemini**: Get from [Google AI Studio](https://aistudio.google.com/app/apikey)
  - **Claude**: Get from [Anthropic Console](https://console.anthropic.com/)

### Note on models

- Although Claude is supported but it has not been tested for accuracy.
- Gemini 2.5 Flash Lite seems to provide good accurate results.
- Gemini 2.0 Flash Lite works too but is unable to handle login pages and sometimes fails in mysterious ways.

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd conversational-playwright
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file from the example:
```bash
cp .env.example .env
```

4. Edit `.env` and configure your LLM provider:

**For Claude:**
```bash
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=your_actual_api_key_here
```

**For Gemini (default):**
```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_actual_api_key_here
```

## Usage

1. Start the application:
```bash
npm start
```

2. The application will open with:
   - **Left Panel**: Chat interface for sending instructions
   - **Right Panel**: Browser canvas for viewing screenshots

3. Click "Start Stream" to begin capturing browser screenshots at 15 FPS

4. Type natural language commands in the chat, such as:
   - "Navigate to google.com"
   - "Click on the search button"
   - "Type 'hello world' in the search box"
   - "Take a screenshot"

## Playbook Mode

You can automate sequences of browser actions by providing a markdown file with steps:

```bash
npm run playbook example-playbook.md
```

Or with the full command:
```bash
npm start -- -p path/to/your-playbook.md
```

### Features
- **Sequential Execution**: Each step executes one at a time, waiting for completion
- **UI Integration**: Steps appear in the chat UI as if entered manually
- **Visual Feedback**: See real-time tool execution and responses
- **Error Handling**: Execution stops on errors with clear feedback

### Markdown Format

Supports two formats for defining steps:

**Numbered lists (recommended):**
```markdown
1. Navigate to https://www.google.com
2. Type "playwright" in the search box
3. Click the search button
```

**Bullet points:**
```markdown
- Navigate to https://www.example.com
- Click on the login button
- Enter username "test@example.com"
```

**Note**: Only numbered lists and bullet points are treated as steps. Plain text lines, headings, and descriptions are automatically ignored to prevent confusing the LLM.

See `example-playbook.md` for a complete example and `PLAYBOOK.md` for detailed documentation.

## Architecture

### Frontend (Renderer Process)
- **index.html**: Main UI structure
- **styles.css**: Modern dark-themed styling
- **renderer.js**: Frontend logic for chat and screenshot display
- **preload.js**: Secure bridge between renderer and main process

### Backend (Main Process)
- **main.js**: Electron main process and IPC handlers
- **services/mcpService.js**: MCP client for Playwright server communication
- **services/llmService.js**: Claude AI integration for command interpretation
- **services/screenshotService.js**: Screenshot capture at 15 FPS

## How It Works

1. **User Input**: You type a natural language instruction in the chat
2. **LLM Processing**: Claude AI interprets the instruction and determines which Playwright tools to use
3. **MCP Execution**: The appropriate Playwright MCP tools are called to perform browser actions
4. **Screenshot Streaming**: The browser state is continuously captured at 15 FPS
5. **Visual Feedback**: Screenshots are displayed in real-time on the canvas

## Available Playwright Tools

The `@playwright/mcp` server provides comprehensive browser automation tools:
- **Core automation**: navigate, click, type, fill forms, take screenshots, etc.
- **Element interaction**: hover, drag, select options, press keys
- **Page inspection**: snapshots, console messages, network requests
- **Browser management**: resize, close, handle dialogs
- **Advanced features**: file upload, JavaScript evaluation, waiting for elements

For a complete list of available tools, see the [@playwright/mcp documentation](https://github.com/microsoft/playwright/tree/main/packages/playwright-mcp).

## Development

Run in development mode with DevTools:
```bash
npm run dev
```

## Configuration

You can customize the application behavior in `.env`:

### MCP Server Configuration
```bash
MCP_SERVER_PORT=3000  # Port for MCP server (default: 3000)
```

The MCP server runs with SSE (Server-Sent Events) transport on HTTP. You can modify the startup arguments in `src/services/mcpService.js` to add [@playwright/mcp options](https://github.com/microsoft/playwright/tree/main/packages/playwright-mcp#configuration):
- `--browser chrome` - Use Chrome instead of Chromium
- `--viewport-size 1920x1080` - Set custom viewport size
- `--user-agent "Custom UA"` - Set custom user agent
- `--timeout-action 10000` - Set action timeout (default 5000ms)

### Logging Configuration
```bash
LOG_LEVEL=INFO  # Options: ERROR, WARN, INFO, DEBUG, VERBOSE
```

**Log Levels:**
- `ERROR` - Only errors
- `WARN` - Warnings and errors
- `INFO` - Important info + LLM tool calls (default, no streaming spam)
- `DEBUG` - Debug info + above
- `VERBOSE` - Everything including 15 FPS screenshot streaming

**Note:** Screenshot streaming logs (15 FPS) only appear at VERBOSE level to prevent log spam, but LLM-invoked screenshots always log at INFO level.

## Troubleshooting

### API Key Issues

**For Claude:**
- Make sure your `.env` file contains `LLM_PROVIDER=claude` and a valid `ANTHROPIC_API_KEY`
- The API key should start with `sk-ant-`

**For Gemini:**
- Make sure your `.env` file contains `LLM_PROVIDER=gemini` and a valid `GEMINI_API_KEY`
- Get your API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

### Rate Limit Errors
- If you see "429 Too Many Requests", you've exceeded your API quota
- Click the **↻ Retry** button after waiting the suggested time
- For Gemini free tier: 50 requests per day per model
- Consider upgrading your API plan for higher limits

### MCP Connection Issues
- The MCP server runs on port 3000 by default (configurable via `MCP_SERVER_PORT`)
- First run may take 30-90 seconds as the server initializes
- Check the console for MCP server logs
- If port 3000 is in use, the app will automatically kill the existing process
- The app uses SSE (Server-Sent Events) transport over HTTP

### Screenshot Not Showing
- Screenshot stream auto-starts when services are ready
- Make sure the browser has navigated to a page first
- Check that the MCP server is connected (status indicator shows "Connected")
- Screenshot streaming runs at 15 FPS

### Debugging
- Set `LOG_LEVEL=DEBUG` or `LOG_LEVEL=VERBOSE` in `.env` for detailed logs
- Open DevTools in development mode: `npm run dev`
- Check both main process console and renderer console logs

## Technologies Used

- **Electron**: Desktop application framework
- **Playwright**: Browser automation
- **Model Context Protocol (MCP)**: Standardized tool communication
- **Anthropic Claude / Google Gemini**: AI language models with function calling
- **Node.js**: Backend runtime

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.