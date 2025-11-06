# Conversational Playwright

An ElectronJS-based application that combines conversational AI with browser automation using Playwright MCP (Model Context Protocol). Control a headless Chrome browser through natural language instructions and see real-time screenshots at 15 FPS.

## Features

- 🤖 **Conversational AI Interface**: Chat with an AI assistant to control browser automation
- 🌐 **Playwright MCP Integration**: Uses official `@playwright/mcp` package for browser automation
- 📸 **Real-time Screenshot Streaming**: View browser activity at 15 FPS in the canvas area
- 🎨 **Modern UI**: Beautiful dark-themed interface with chat on the left and browser view on the right
- ⚡ **Dual LLM Support**: Choose between Anthropic's Claude or Google's Gemini for intelligent command interpretation

## Prerequisites

- Node.js 18+ and npm
- API key for your chosen LLM provider:
  - **Claude**: Get from [Anthropic Console](https://console.anthropic.com/)
  - **Gemini**: Get from [Google AI Studio](https://aistudio.google.com/app/apikey)

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

**For Claude (default):**
```bash
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=your_actual_api_key_here
```

**For Gemini:**
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
   - "Scroll down the page"

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

You can customize the MCP server configuration in `.env`:
```
MCP_SERVER_PATH=npx
MCP_SERVER_ARGS=@playwright/mcp@latest,--headless
```

You can add additional arguments from the [@playwright/mcp options](https://github.com/microsoft/playwright/tree/main/packages/playwright-mcp#configuration):
- `--browser chrome` - Use Chrome instead of Chromium
- `--viewport-size 1920x1080` - Set custom viewport size
- `--user-agent "Custom UA"` - Set custom user agent
- `--timeout-action 10000` - Set action timeout (default 5000ms)

## Troubleshooting

### API Key Issues

**For Claude:**
- Make sure your `.env` file contains `LLM_PROVIDER=claude` and a valid `ANTHROPIC_API_KEY`
- The API key should start with `sk-ant-`

**For Gemini:**
- Make sure your `.env` file contains `LLM_PROVIDER=gemini` and a valid `GEMINI_API_KEY`
- Get your API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

### MCP Connection Issues
- Ensure `@playwright/mcp` is accessible (it will be auto-installed via npx)
- Check the console for MCP server logs
- The first run may take longer as it downloads the Playwright browsers

### Screenshot Not Showing
- Click "Start Stream" to begin capturing
- Make sure the browser has navigated to a page first
- Check that Playwright is properly initialized

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