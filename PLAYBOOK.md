# Playbook Mode

The Conversational Playwright app now supports automated execution of browser automation steps from a markdown file.

## Usage

Start the app with the `-p` flag followed by the path to your markdown file:

```bash
npm start -- -p path/to/playbook.md
```

Or with the full command:

```bash
npx electron src/main.js -p path/to/playbook.md
```

## Markdown Format

The playbook parser supports two formats for defining steps:

### 1. Numbered Lists (Recommended)

```markdown
1. Navigate to https://www.google.com
2. Type "playwright" in the search box
3. Click the search button
```

### 2. Bullet Points

```markdown
- Navigate to https://www.example.com
- Click on the login button
- Enter username "test@example.com"
```

Both `-` and `*` bullet points are supported.

**Note**: Only numbered lists and bullet points are treated as steps. Plain text lines, headings, and descriptions are ignored. This prevents confusion from sending non-step content to the LLM.

## Features

- **Sequential Execution**: Each step is executed one at a time, waiting for the previous step to complete before proceeding
- **UI Integration**: All steps are displayed in the chat UI as if entered manually by the user
- **Visual Feedback**: You see the assistant's responses and tool execution tiles in real-time
- **Error Handling**: If a step fails, the playbook execution stops and displays an error message
- **Progress Tracking**: System messages show playbook progress (e.g., "Step 1/5 completed")

## Example Playbook

See `example-playbook.md` for a complete example.

## What Gets Ignored

The parser automatically ignores:
- Empty lines
- Markdown headings (lines starting with `#`)
- Horizontal rules (`---`, `***`, `___`)
- Plain text lines (descriptions, titles, etc.)
- Any line that isn't a numbered list item or bullet point

## Use Cases

- **Automated Testing**: Run the same test sequence repeatedly
- **Demos**: Prepare a demo script that executes automatically
- **Training**: Show new users how the automation works
- **Regression Testing**: Verify that key workflows still work after changes
- **Documentation**: Keep automation steps in version-controlled markdown files

## Technical Details

### How It Works

1. The app parses command line arguments for the `-p` flag
2. If present, a `PlaybookService` is created and initialized
3. After services are ready, the playbook is executed automatically
4. Each step is sent to the LLM service via `processMessage()`
5. The LLM service processes the step and executes all necessary tool calls
6. The playbook waits for complete execution:
   - Waits for `processMessage()` to resolve (includes all tool calls)
   - Polls `llmService.isExecuting` flag until it's false (ensures completion)
   - Waits additional 1 second for UI to fully update
7. The response is displayed in the UI via IPC events
8. Only then does the next step begin

### Implementation

- **Backend**: `src/services/playbookService.js` - Handles parsing and execution
- **Main Process**: `src/main.js` - Parses `-p` flag and triggers playbook execution
- **IPC**: `src/ipcManager.js` - Handles playbook status queries
- **Preload**: `src/preload.js` - Exposes playbook events to renderer
- **Frontend**: `src/renderer.js` - Listens for and displays playbook messages

### API

The playbook service exposes the following methods:

```javascript
// Execute a playbook from a file
await playbookService.executePlaybook(filePath);

// Get current execution status
const status = playbookService.getStatus();
// Returns: { isExecuting, currentStepIndex, totalSteps, currentStep }

// Parse a markdown file (without executing)
const steps = await playbookService.parseMarkdownFile(filePath);
```

## Limitations

- Playbook execution cannot be paused or resumed (only started and stopped)
- Steps must be simple text commands that the LLM can understand
- Complex multi-line steps are not supported (each line is a separate step)
- No conditional logic or loops (pure sequential execution)

## Future Enhancements

Possible improvements:
- Support for step-level timeouts
- Conditional execution based on previous step results
- Parallel step execution
- Playbook variables and templating
- Step-level error recovery strategies
- Export playbook execution results to a report
