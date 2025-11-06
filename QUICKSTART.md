# Quick Start Guide

## Setup (One-time)

1. **Install dependencies** (if not already done):
   ```bash
   npm install
   ```

2. **Configure your LLM provider** in `.env`:
   
   **Option A: Use Claude (default)**
   ```bash
   LLM_PROVIDER=claude
   ANTHROPIC_API_KEY=sk-ant-your_actual_key_here
   ```
   Get your API key from: https://console.anthropic.com/
   
   **Option B: Use Gemini**
   ```bash
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=your_actual_key_here
   ```
   Get your API key from: https://aistudio.google.com/app/apikey

## Running the Application

```bash
npm start
```

Or for development mode with DevTools:
```bash
npm run dev
```

## Using the Application

1. **Start Screenshot Stream**
   - Click the "Start Stream" button in the top-right of the canvas panel
   - This will begin capturing browser screenshots at 15 FPS

2. **Send Commands**
   - Type natural language instructions in the chat input
   - Press Enter or click Send

3. **Example Commands**
   ```
   Navigate to google.com
   Click on the search box
   Type "hello world" in the search box
   Press Enter
   Take a screenshot
   Scroll down the page
   Go back to the previous page
   Fill in the form with test data
   ```

## Project Structure

```
conversational-playwright/
├── src/
│   ├── main.js              # Electron main process
│   ├── preload.js           # IPC bridge
│   ├── index.html           # UI structure
│   ├── styles.css           # Styling
│   ├── renderer.js          # Frontend logic
│   └── services/
│       ├── mcpService.js    # Playwright MCP client
│       ├── llmService.js    # Claude AI integration
│       └── screenshotService.js  # Screenshot streaming
├── package.json
├── .env                     # Your configuration
└── README.md               # Full documentation
```

## Troubleshooting

### "API key not found"
- Make sure you've created a `.env` file (copy from `.env.example`)
- Set `LLM_PROVIDER` to either `claude` or `gemini`
- Add the corresponding API key (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`)

### "Browser not installed"
- The first run will automatically download Playwright browsers
- This may take a few minutes

### Screenshot not showing
- Make sure you've clicked "Start Stream"
- Try navigating to a webpage first (e.g., "Navigate to google.com")
- Check the console for any errors

### Connection issues
- The MCP server starts automatically when you launch the app
- Check the status indicator in the top-left (should show "Connected")
- Look at the Electron console for detailed logs

## Tips

- Use Shift+Enter in the chat input to add a new line without sending
- The FPS counter shows the actual screenshot capture rate
- Screenshots are captured from the headless browser, not your screen
- You can customize MCP server options in the `.env` file

## Need Help?

Check the full [README.md](README.md) for detailed documentation and configuration options.
