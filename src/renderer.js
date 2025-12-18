// DOM Elements
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const downloadScriptButton = document.getElementById('downloadScriptButton');
const screenshotImage = document.getElementById('screenshotImage');
const canvasContent = document.getElementById('canvasContent');
const urlDisplay = document.getElementById('urlDisplay');
const canvasBrowser = document.querySelector('.canvas-browser');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fpsCounter = document.getElementById('fpsCounter');
const llmBadge = document.getElementById('llmBadge');
const streamStatus = document.getElementById('streamStatus');
const streamStatusDot = document.getElementById('streamStatusDot');

// State
let messageHistory = [];
let currentPageUrl = '';
let urlUpdateInterval = null;
let activeToolTiles = new Map(); // Track active tool execution tiles
let isExecuting = false; // Track if LLM is currently executing
let shouldCancelExecution = false; // Flag to signal cancellation

// FPS calculation state
const fpsBuffer = [];
const fpsBufferSize = 30; // Average over 30 frames

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await initializeApp();
    setupEventListeners();
});

async function initializeApp() {
    console.log('[Renderer] Initializing app, waiting for services-ready event...');
    updateStatus('initializing', 'Connecting...');

    window.electronAPI.onServicesReady(async () => {
        try {
            console.log('[Renderer] Services are ready. Initializing UI features...');

            // 1. Get LLM Provider
            const providerResult = await window.electronAPI.getLLMProvider();
            if (providerResult.success) {
                const provider = providerResult.provider;
                // Set badge text based on provider
                if (provider === 'gemini') {
                    llmBadge.textContent = 'Gemini';
                    llmBadge.classList.add('gemini');
                } else if (provider === 'fara') {
                    llmBadge.textContent = 'Fara';
                    llmBadge.classList.add('fara');
                } else {
                    llmBadge.textContent = 'Claude';
                }
                console.log('[Renderer] Using LLM provider:', provider);
            } else {
                console.error('[Renderer] Failed to get LLM provider:', providerResult.error);
            }

            // 2. Check for MCP Tools
            const toolsResult = await window.electronAPI.getMCPTools();
            if (toolsResult.success) {
                console.log('[Renderer] Available MCP tools:', toolsResult.tools.length);
            } else {
                console.error('[Renderer] Failed to get MCP tools:', toolsResult.error);
                updateStatus('error', 'MCP Error');
                return; // Stop initialization if MCP tools fail
            }

            // 3. Update status to Connected
            updateStatus('connected', 'Connected');

            // 4. Auto-start screenshot stream
            console.log('[Renderer] Auto-starting screenshot stream...');
            await startStream();
            console.log('[Renderer] Screenshot stream start completed');

            // 5. Start periodic URL updates
            startUrlUpdates();

        } catch (error) {
            updateStatus('error', 'Initialization Failed');
            console.error('[Renderer] Error during service-ready initialization:', error);
        }
    });
}

function setupEventListeners() {
    // Send or cancel message based on execution state
    sendButton.addEventListener('click', () => {
        if (isExecuting) {
            handleCancelExecution();
        } else {
            handleSendMessage();
        }
    });
    
    // Download Playwright script on button click
    downloadScriptButton.addEventListener('click', handleDownloadScript);
    
    // Send message on Enter (Shift+Enter for new line)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isExecuting) {
                handleSendMessage();
            }
        }
    });
    
    // Listen for screenshot updates
    window.electronAPI.onScreenshotUpdate((screenshot) => {
        updateScreenshot(screenshot);
        updateFPS();
        updateStreamStatus('live');
    });

    // Listen for stream stop events
    window.electronAPI.onStreamStopped(() => {
        console.log('[Renderer] Screenshot stream stopped');
        showPlaceholder();
        updateStreamStatus('stopped', 'Stopped');
    });

    // Listen for stream start events
    window.electronAPI.onStreamStarted(() => {
        console.log('[Renderer] Screenshot stream started');
        updateStreamStatus('live', 'Live');
        // Resume URL updates when stream starts
        if (!urlUpdateInterval) {
            startUrlUpdates();
        }
    });

    // Listen for assistant messages from the main process (llmService)
    window.electronAPI.onShowAssistantMessage((message) => {
        showAssisstantMessage(message);
    });

    // Listen for tool execution events
    window.electronAPI.onToolExecutionStart((data) => {
        console.log('[Renderer] Tool execution started:', data);
        createToolTile(data);
    });

    window.electronAPI.onToolExecutionSuccess((data) => {
        console.log('[Renderer] Tool execution success:', data);
        updateToolTile(data.toolId, 'success', data);
    });

    window.electronAPI.onToolExecutionError((data) => {
        console.log('[Renderer] Tool execution error:', data);
        updateToolTile(data.toolId, 'error', data);
    });
    
    // Listen for playbook messages
    window.electronAPI.onPlaybookMessage((data) => {
        console.log('[Renderer] Playbook message:', data);
        const { role, message } = data;
        
        if (role === 'user') {
            // Display as user message
            addMessage('user', message);
        } else if (role === 'assistant') {
            // Display as assistant message
            addMessage('assistant', message);
        } else if (role === 'system') {
            // Display as system message
            addMessage('system', message);
        }
    });
    
    // Listen for playbook execution start
    window.electronAPI.onPlaybookStarted(() => {
        console.log('[Renderer] Playbook execution started - disabling input');
        chatInput.disabled = true;
        chatInput.classList.add('chat-input-readonly');
        chatInput.placeholder = 'Playbook running...';
        sendButton.disabled = true;
    });
    
    // Listen for playbook execution completion
    window.electronAPI.onPlaybookCompleted((data) => {
        console.log('[Renderer] Playbook execution completed:', data);
        
        // Display validation results if any
        if (data.validationResults && data.validationResults.length > 0) {
            displayValidationSummary(data.validationResults);
        }
        
        chatInput.disabled = false;
        chatInput.classList.remove('chat-input-readonly');
        chatInput.placeholder = 'Type your message here...';
        sendButton.disabled = false;
        chatInput.focus();
    });
}

/**
 * Switch send button to cancel button (red square)
 */
function showCancelButton() {
    isExecuting = true;
    sendButton.className = 'cancel-button';
    sendButton.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="2"/>
        </svg>
        Stop
    `;
    chatInput.readOnly = true;
    chatInput.classList.add('chat-input-readonly');
}

/**
 * Switch cancel button back to send button
 */
function showSendButton() {
    isExecuting = false;
    shouldCancelExecution = false;
    sendButton.className = 'send-button';
    sendButton.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Send
    `;
    chatInput.readOnly = false;
    chatInput.classList.remove('chat-input-readonly');
}

/**
 * Handle cancel execution
 */
function handleCancelExecution() {
    console.log('[Renderer] Cancelling execution...');
    shouldCancelExecution = true;
    
    // Send cancel request to backend
    window.electronAPI.cancelExecution().catch(err => {
        console.error('[Renderer] Error cancelling execution:', err);
    });
    
    // Update UI to show cancellation in progress
    sendButton.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="2"/>
        </svg>
        Cancelling...
    `;
    sendButton.disabled = true;
}

async function handleSendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;
    
    // Add user message to chat
    addMessage('user', message);
    chatInput.value = '';
    
    // Send to backend
    await sendMessageToBackend(message);
}

async function handleDownloadScript() {
    // Disable button while generating
    downloadScriptButton.disabled = true;
    downloadScriptButton.textContent = 'Generating...';
    
    try {
        // Show status message
        addMessage('system', '🔄 Generating Playwright test script from action log...');
        
        // Get action log first to check if there are any actions
        const actionLogResult = await window.electronAPI.getActionLog();
        
        if (!actionLogResult.success) {
            throw new Error(actionLogResult.error || 'Failed to retrieve action log');
        }
        
        if (!actionLogResult.actionLog || actionLogResult.actionLog.length === 0) {
            addMessage('system', '⚠️ No actions recorded yet. Please perform some browser automation first.');
            return;
        }
        
        console.info('[Renderer] Action log:', JSON.stringify(actionLogResult.actionLog, null, 2));
        
        // Generate script
        const result = await window.electronAPI.generatePlaywrightScript();
        
        if (result.success) {
            // Create a blob from the script
            const blob = new Blob([result.script], { type: 'text/typescript' });
            const url = URL.createObjectURL(blob);
            
            // Create download link
            const a = document.createElement('a');
            a.href = url;
            a.download = `playwright-test-${Date.now()}.spec.ts`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            addMessage('system', `✅ Playwright test script downloaded successfully! (${actionLogResult.actionLog.length} actions recorded)`);
            console.log('[Renderer] Script generated:', result.script);
        } else {
            throw new Error(result.error || 'Failed to generate script');
        }
    } catch (error) {
        console.error('[Renderer] Error downloading script:', error);
        addMessage('system', `❌ Error: ${error.message}`);
    } finally {
        // Re-enable button
        downloadScriptButton.disabled = false;
        downloadScriptButton.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Download Script
        `;
    }
}

async function showAssisstantMessage(message) {
    message = message.trim();
    if (!message) return;
    addMessage('assistant', message);
}

async function sendMessageToBackend(message) {
    // Reset cancellation flag
    shouldCancelExecution = false;
    
    // Show cancel button and make input readonly
    showCancelButton();
    
    // Show loading indicator
    const loadingId = addLoadingMessage();
    
    try {
        // Send message to backend
        const result = await window.electronAPI.sendMessage(message);
        
        // Remove loading indicator
        removeLoadingMessage(loadingId);
        
        // Check if execution was cancelled
        if (shouldCancelExecution) {
            addMessage('system', '🛑 Execution cancelled by user');
        } else if (result.success) {
            addMessage('assistant', result.response);
        } else {
            // Show user-friendly error with retry button
            addErrorMessage(result.error, message);
        }
    } catch (error) {
        removeLoadingMessage(loadingId);
        
        // Check if this was a cancellation
        if (shouldCancelExecution) {
            addMessage('system', '🛑 Execution cancelled by user');
        } else {
            // Show user-friendly error with retry button
            addErrorMessage(error, message);
        }
    } finally {
        // Restore send button and enable input
        showSendButton();
        sendButton.disabled = false;
        chatInput.disabled = false;
        chatInput.focus();
    }
}

async function startStream() {
    const result = await window.electronAPI.startScreenshotStream();
    if (result.success) {
        const placeholder = document.querySelector('.canvas-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        screenshotImage.style.display = 'block';
        updateStreamStatus('live');
    } else {
        console.error('[Renderer] Failed to start screenshot stream:', result.error);
        updateStreamStatus('stopped', 'Error');
    }
}

function addMessage(role, content) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message message-${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = content;
    
    const timestamp = document.createElement('div');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = new Date().toLocaleTimeString();
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timestamp);
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    messageHistory.push({ role, content, timestamp: Date.now() });
}

function addErrorMessage(errorInfo, originalMessage) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message message-assistant message-error';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // Create error message
    const errorText = document.createElement('div');
    errorText.className = 'error-text';
    
    // Parse error info
    let statusText = 'Error';
    let errorMessage = 'An error occurred';
    
    if (typeof errorInfo === 'object' && errorInfo !== null) {
        // Handle errors with status code
        if (errorInfo.status && errorInfo.statusText) {
            statusText = `${errorInfo.status} ${errorInfo.statusText}`;
            errorMessage = errorInfo.statusText;
            
            // Add more context from message if available
            if (errorInfo.message && errorInfo.message !== errorInfo.statusText) {
                // Extract meaningful part from error message
                const msg = errorInfo.message;
                if (msg.includes('429')) {
                    errorMessage = 'Rate limit exceeded. Please wait a moment before retrying.';
                } else if (msg.includes('quota')) {
                    errorMessage = 'API quota exceeded. Please check your usage limits.';
                } else {
                    errorMessage = errorInfo.statusText;
                }
            }
        } else if (errorInfo.message) {
            // Handle errors with just a message
            errorMessage = errorInfo.message;
            
            // Try to extract status from message
            const statusMatch = errorMessage.match(/(\d{3})\s+([A-Za-z\s]+)/);
            if (statusMatch) {
                statusText = `${statusMatch[1]} ${statusMatch[2]}`;
                // Clean up the error message
                if (errorMessage.includes('429')) {
                    errorMessage = 'Rate limit exceeded. Please wait before retrying.';
                } else if (errorMessage.includes('quota')) {
                    errorMessage = 'API quota exceeded. Check your usage limits.';
                }
            }
        }
    } else if (typeof errorInfo === 'string') {
        errorMessage = errorInfo;
        
        // Try to extract status from string
        const statusMatch = errorMessage.match(/(\d{3})\s+([A-Za-z\s]+)/);
        if (statusMatch) {
            statusText = `${statusMatch[1]} ${statusMatch[2]}`;
        }
    }
    
    errorText.innerHTML = `<strong>${statusText}</strong><br>${errorMessage}`;
    contentDiv.appendChild(errorText);
    
    // Create retry button
    const retryButton = document.createElement('button');
    retryButton.className = 'retry-button';
    retryButton.textContent = '↻ Retry';
    retryButton.onclick = () => {
        // Remove error message
        messageDiv.remove();
        // Resend the original message without adding it to UI again
        if (originalMessage) {
            sendMessageToBackend(originalMessage);
        }
    };
    contentDiv.appendChild(retryButton);
    
    const timestamp = document.createElement('div');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = new Date().toLocaleTimeString();
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timestamp);
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Display validation results summary in a formatted card
 */
function displayValidationSummary(validationResults) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message message-system validation-summary';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // Create header
    const header = document.createElement('div');
    header.className = 'validation-summary-header';
    
    const passCount = validationResults.filter(v => v.result === 'pass').length;
    const failCount = validationResults.filter(v => v.result === 'fail').length;
    const totalCount = validationResults.length;
    
    header.innerHTML = `
        <h3>📊 Validation Summary</h3>
        <div class="validation-stats">
            <span class="validation-stat-pass">✅ ${passCount} Passed</span>
            <span class="validation-stat-fail">❌ ${failCount} Failed</span>
            <span class="validation-stat-total">📋 ${totalCount} Total</span>
        </div>
    `;
    contentDiv.appendChild(header);
    
    // Create table
    const table = document.createElement('table');
    table.className = 'validation-table';
    
    // Table header
    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>Result</th>
            <th>Scenario</th>
            <th>Reason</th>
            <th>Time</th>
        </tr>
    `;
    table.appendChild(thead);
    
    // Table body
    const tbody = document.createElement('tbody');
    validationResults.forEach(validation => {
        const row = document.createElement('tr');
        row.className = `validation-row-${validation.result}`;
        
        const resultIcon = validation.result === 'pass' ? '✅' : '❌';
        const resultClass = validation.result === 'pass' ? 'validation-pass' : 'validation-fail';
        
        const failReasonText = validation.failReason || '-';
        const timeStr = new Date(validation.timestamp).toLocaleTimeString();
        
        row.innerHTML = `
            <td class="${resultClass}">${resultIcon}</td>
            <td class="validation-scenario">${escapeHtml(validation.scenario)}</td>
            <td class="validation-reason">${escapeHtml(failReasonText)}</td>
            <td class="validation-time">${timeStr}</td>
        `;
        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    
    contentDiv.appendChild(table);
    
    const timestamp = document.createElement('div');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = new Date().toLocaleTimeString();
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timestamp);
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addLoadingMessage() {
    const loadingDiv = document.createElement('div');
    const loadingId = `loading-${Date.now()}`;
    loadingDiv.id = loadingId;
    loadingDiv.className = 'message message-assistant';
    
    const loadingContent = document.createElement('div');
    loadingContent.className = 'message-loading';
    loadingContent.innerHTML = '<span></span><span></span><span></span>';
    
    loadingDiv.appendChild(loadingContent);
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    return loadingId;
}

function removeLoadingMessage(loadingId) {
    const loadingDiv = document.getElementById(loadingId);
    if (loadingDiv) {
        loadingDiv.remove();
    }
}

function updateScreenshot(screenshot) {
    // Note: Removed verbose logging - runs at 15 FPS
    if (screenshot) {
        screenshotImage.src = `data:image/png;base64,${screenshot}`;
        // Show screenshot, hide placeholder
        screenshotImage.style.display = 'block';
        if (canvasBrowser) {
            canvasBrowser.classList.add('visible');
        }
        const placeholder = canvasContent.querySelector('.canvas-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
        // Update URL display
        updateUrlDisplay();
    }
}

function updateUrlDisplay() {
    // Hide URL display only if we're on about:blank or if URL is empty
    // Don't hide if URL is empty - it might just be loading
    if (currentPageUrl && (currentPageUrl === 'about:blank' || currentPageUrl.includes('/blank.html'))) {
        urlDisplay.style.display = 'none';
    } else if (currentPageUrl) {
        urlDisplay.textContent = currentPageUrl;
        urlDisplay.style.display = 'block';
    }
    // If currentPageUrl is empty, don't change display state
}

function setCurrentUrl(url) {
    currentPageUrl = url;
    updateUrlDisplay();
}

function showPlaceholder() {
    // Hide screenshot, show placeholder
    screenshotImage.style.display = 'none';
    urlDisplay.style.display = 'none';
    if (canvasBrowser) {
        canvasBrowser.classList.remove('visible');
    }
    const placeholder = canvasContent.querySelector('.canvas-placeholder');
    if (placeholder) {
        placeholder.style.display = 'flex';
    }
    // Stop URL updates when showing placeholder
    stopUrlUpdates();
}

function startUrlUpdates() {
    // Update URL immediately
    updateCurrentUrl();
    // Then update every 2 seconds
    if (!urlUpdateInterval) {
        urlUpdateInterval = setInterval(updateCurrentUrl, 2000);
    }
}

function stopUrlUpdates() {
    if (urlUpdateInterval) {
        clearInterval(urlUpdateInterval);
        urlUpdateInterval = null;
    }
}

async function updateCurrentUrl() {
    try {
        const result = await window.electronAPI.getCurrentUrl();
        if (result.success && result.url) {
            // Only log if URL actually changed to avoid spam
            if (result.url !== currentPageUrl) {
                console.log('[Renderer] URL changed to:', result.url);
            }
            setCurrentUrl(result.url);
        }
    } catch (error) {
        console.error('[Renderer] Error fetching current URL:', error);
    }
}

function updateFPS() {
    const now = Date.now();
    fpsBuffer.push(now);
    if (fpsBuffer.length > fpsBufferSize) {
        fpsBuffer.shift();
    }
    
    if (fpsBuffer.length < 2) {
        return;
    }
    
    const elapsed = now - fpsBuffer[0];
    const fps = Math.round((fpsBuffer.length / elapsed) * 1000);
    fpsCounter.textContent = `${fps} FPS`;
}

function updateStreamStatus(status, text) {
    streamStatusDot.className = `status-dot-small ${status}`;
    streamStatus.textContent = text || (status.charAt(0).toUpperCase() + status.slice(1));
}

function updateStatus(status, text) {
    statusDot.className = `status-dot ${status}`;
    statusText.textContent = text;
}

function createToolTile(data) {
    const { toolId, toolName, args } = data;
    
    // Create tile container
    const tile = document.createElement('div');
    tile.id = `tool-tile-${toolId}`;
    tile.className = 'tool-tile executing';
    
    // Create tile header with status indicator
    const header = document.createElement('div');
    header.className = 'tool-tile-header';
    
    const statusIndicator = document.createElement('span');
    statusIndicator.className = 'tool-status-indicator executing';
    statusIndicator.id = `tool-status-${toolId}`;
    
    const toolTitle = document.createElement('span');
    toolTitle.className = 'tool-title';
    toolTitle.textContent = formatToolName(toolName);
    
    header.appendChild(statusIndicator);
    header.appendChild(toolTitle);
    
    // Create tile body with args
    const body = document.createElement('div');
    body.className = 'tool-tile-body';
    body.id = `tool-body-${toolId}`;
    
    const argsDiv = document.createElement('div');
    argsDiv.className = 'tool-args';
    argsDiv.textContent = formatToolArgs(args);
    
    body.appendChild(argsDiv);
    
    // Create tile footer (initially hidden, shown on completion)
    const footer = document.createElement('div');
    footer.className = 'tool-tile-footer';
    footer.id = `tool-footer-${toolId}`;
    footer.style.display = 'none';
    
    tile.appendChild(header);
    tile.appendChild(body);
    tile.appendChild(footer);
    
    // Add to chat messages
    chatMessages.appendChild(tile);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Store reference
    activeToolTiles.set(toolId, tile);
}

function updateToolTile(toolId, status, data) {
    const tile = activeToolTiles.get(toolId);
    if (!tile) {
        console.warn('[Renderer] Tool tile not found:', toolId);
        return;
    }
    
    // Update tile class
    tile.className = `tool-tile ${status}`;
    
    // Update status indicator
    const statusIndicator = document.getElementById(`tool-status-${toolId}`);
    if (statusIndicator) {
        statusIndicator.className = `tool-status-indicator ${status}`;
    }
    
    // Update footer with result/error
    const footer = document.getElementById(`tool-footer-${toolId}`);
    if (footer) {
        footer.style.display = 'block';
        
        if (status === 'success') {
            const duration = data.duration ? ` (${data.duration}ms)` : '';
            footer.innerHTML = `<span class="tool-result-success">✓ Completed${duration}</span>`;
            
            // Add visual change info if available
            if (data.visualChange !== undefined) {
                const changeInfo = document.createElement('div');
                changeInfo.className = 'tool-visual-change';
                if (data.visualChange) {
                    changeInfo.innerHTML = `<span class="visual-change-yes">✓ Visual change detected (${data.changePercent}%)</span>`;
                } else {
                    changeInfo.innerHTML = `<span class="visual-change-no">⚠ No visual change detected</span>`;
                }
                footer.appendChild(changeInfo);
            }
        } else if (status === 'error') {
            footer.innerHTML = `<span class="tool-result-error">✗ Error: ${formatError(data.error)}</span>`;
        }
    }
    
    // Keep tiles visible permanently to provide complete execution history
    // Tiles will only be removed when page is refreshed
    // (Auto-removal disabled to prevent tiles from disappearing too quickly)
}

function formatToolName(toolName) {
    // Convert snake_case or camelCase to Title Case
    return toolName
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
        .trim();
}

function formatToolArgs(args) {
    if (!args || Object.keys(args).length === 0) {
        return 'No arguments';
    }
    
    // Format args for human readability
    const formatted = Object.entries(args)
        .filter(([key, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
            const formattedKey = key.replace(/_/g, ' ');
            let formattedValue = value;
            
            // Truncate long strings
            if (typeof value === 'string' && value.length > 100) {
                formattedValue = value.substring(0, 100) + '...';
            }
            
            // Format objects
            if (typeof value === 'object') {
                formattedValue = JSON.stringify(value, null, 2);
                if (formattedValue.length > 100) {
                    formattedValue = formattedValue.substring(0, 100) + '...';
                }
            }
            
            return `${formattedKey}: ${formattedValue}`;
        })
        .join(', ');
    
    return formatted || 'No arguments';
}

function formatError(error) {
    if (typeof error === 'string') {
        // Truncate long error messages
        return error.length > 200 ? error.substring(0, 200) + '...' : error;
    }
    
    if (error && error.message) {
        return error.message.length > 200 ? error.message.substring(0, 200) + '...' : error.message;
    }
    
    return 'Unknown error';
}
