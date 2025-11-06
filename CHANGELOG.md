# Changelog

## Version 1.1.0 - Stability and UX Improvements (2025-11-06)

### Major Improvements

#### MCP Server Connection
- ✅ **Fixed MCP server connection** - Now uses SSE (Server-Sent Events) transport over HTTP
- ✅ **HTTP endpoint detection** - Actively polls server endpoint to detect readiness
- ✅ **Port conflict resolution** - Automatically kills existing processes on port 3000
- ✅ **Proper cleanup** - Server process cleanup on app exit and force-quit
- ✅ **Configurable port** - Set `MCP_SERVER_PORT` in `.env`

#### Logging System
- ✅ **Configurable log levels** - 5 levels: ERROR, WARN, INFO, DEBUG, VERBOSE
- ✅ **Smart log filtering** - Screenshot streaming (15 FPS) only logs at VERBOSE level
- ✅ **Reduced noise** - LLM tool calls log at INFO, streaming at VERBOSE
- ✅ **Environment control** - Set `LOG_LEVEL` in `.env`
- ✅ **Logger utility** - Centralized logging via `src/utils/logger.js`

#### Error Handling
- ✅ **User-friendly error messages** - No more raw JSON dumps in chat
- ✅ **Retry button** - Click ↻ Retry to resend failed messages
- ✅ **Error parsing** - Extracts status codes (429, 401, etc.) from errors
- ✅ **Beautiful error UI** - Red-tinted messages with clear formatting
- ✅ **Rate limit guidance** - Helpful messages for API quota errors

#### Service Initialization
- ✅ **Race condition fix** - Renderer waits for services-ready event
- ✅ **Proper sequencing** - Services initialize before UI tries to use them
- ✅ **Status indicator** - Shows "Connected" only when LLM service is ready
- ✅ **Auto-start stream** - Screenshot stream starts automatically when ready

#### Gemini API Fixes
- ✅ **Schema cleaning** - Filters unsupported JSON Schema fields for Gemini
- ✅ **Function response format** - Correct format: `{ functionResponse: { name, response } }`
- ✅ **Function calls extraction** - Fixed getter function call
- ✅ **System prompt handling** - Prepends to first message instead of using systemInstruction

### Bug Fixes
- 🐛 Fixed error messages being returned as successful responses
- 🐛 Fixed retry button calling wrong function name
- 🐛 Fixed status showing "Connected" before services ready
- 🐛 Fixed screenshot service race condition
- 🐛 Fixed MCP server port conflicts on restart
- 🐛 Fixed DevTools opening in production mode

### Technical Changes
- Changed from StdioClientTransport to SSEClientTransport
- Added HTTP endpoint polling for server readiness detection
- Added signal handlers (SIGINT, SIGTERM) for cleanup
- LLM service now throws errors instead of returning error strings
- Added error object with status/statusText to IPC responses
- Improved error parsing in renderer with regex extraction

## Version 1.0.0 - Initial Release (2025-11-05)

### Features

#### Core Application
- ✅ ElectronJS-based desktop application
- ✅ Modern dark-themed UI with split-panel layout
- ✅ Chat interface on the left for conversational AI interaction
- ✅ Canvas panel on the right for real-time browser screenshots
- ✅ 15 FPS screenshot streaming from headless browser

#### LLM Integration
- ✅ **Dual LLM Support**: Choose between Claude or Gemini
  - Anthropic Claude 3.5 Sonnet with function calling
  - Google Gemini 2.0 Flash with function calling
- ✅ Automatic tool/function calling for browser automation
- ✅ Conversation history management
- ✅ Visual indicator showing active LLM provider

#### Browser Automation
- ✅ Integration with official `@playwright/mcp` package
- ✅ Headless Chrome browser automation
- ✅ Full access to Playwright MCP tools:
  - Navigation (goto, back, forward)
  - Element interaction (click, type, fill forms)
  - Screenshots and page snapshots
  - Console messages and network requests
  - Dialog handling
  - File uploads
  - JavaScript evaluation
  - And more...

#### User Experience
- ✅ Real-time status indicators
- ✅ FPS counter for screenshot stream
- ✅ Loading animations for AI responses
- ✅ Message timestamps
- ✅ Smooth animations and transitions
- ✅ Keyboard shortcuts (Enter to send, Shift+Enter for new line)

### Project Structure
```
conversational-playwright/
├── src/
│   ├── main.js                   # Electron main process
│   ├── preload.js                # IPC bridge
│   ├── index.html                # UI structure
│   ├── styles.css                # Styling
│   ├── renderer.js               # Frontend logic
│   └── services/
│       ├── mcpService.js         # Playwright MCP client
│       ├── llmService.js         # LLM integration (Claude/Gemini)
│       └── screenshotService.js  # Screenshot streaming
├── package.json
├── .env.example
├── README.md
├── QUICKSTART.md
└── CHANGELOG.md
```

### Configuration Options

#### LLM Provider Selection
- Set `LLM_PROVIDER=claude` for Anthropic Claude
- Set `LLM_PROVIDER=gemini` for Google Gemini

#### MCP Server Options
- Customizable via `MCP_SERVER_ARGS` in `.env`
- Supports all `@playwright/mcp` command-line options
- Default: headless mode

### Dependencies
- `electron` ^27.0.0
- `@anthropic-ai/sdk` ^0.27.0
- `@google/generative-ai` ^0.21.0
- `@playwright/mcp` latest
- `@modelcontextprotocol/sdk` ^0.5.0
- `dotenv` ^16.3.1

### Known Limitations
- Screenshot streaming requires browser to be navigated to a page
- First run may take longer as Playwright downloads browsers
- Network connectivity required for LLM API calls

### Future Enhancements (Potential)
- [ ] Support for additional LLM providers (OpenAI, etc.)
- [ ] Adjustable screenshot FPS
- [ ] Session recording and playback
- [ ] Multiple browser tabs support
- [ ] Custom browser profiles
- [ ] Screenshot annotation tools
- [ ] Export conversation history
- [ ] Dark/Light theme toggle
