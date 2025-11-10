// DOM Elements
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const screenshotImage = document.getElementById('screenshotImage');
const canvasContent = document.getElementById('canvasContent');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fpsCounter = document.getElementById('fpsCounter');
const llmBadge = document.getElementById('llmBadge');
const streamStatus = document.getElementById('streamStatus');
const streamStatusDot = document.getElementById('streamStatusDot');

// State
let messageHistory = [];

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
                llmBadge.textContent = provider === 'gemini' ? 'Gemini' : 'Claude';
                if (provider === 'gemini') {
                    llmBadge.classList.add('gemini');
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

        } catch (error) {
            updateStatus('error', 'Initialization Failed');
            console.error('[Renderer] Error during service-ready initialization:', error);
        }
    });
}

function setupEventListeners() {
    // Send message on button click
    sendButton.addEventListener('click', handleSendMessage);
    
    // Send message on Enter (Shift+Enter for new line)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
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
    });
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

async function sendMessageToBackend(message) {
    // Disable input while processing
    chatInput.disabled = true;
    sendButton.disabled = true;
    
    // Show loading indicator
    const loadingId = addLoadingMessage();
    
    try {
        // Send message to backend
        const result = await window.electronAPI.sendMessage(message);
        
        // Remove loading indicator
        removeLoadingMessage(loadingId);
        
        if (result.success) {
            addMessage('assistant', result.response);
        } else {
            // Show user-friendly error with retry button
            addErrorMessage(result.error, message);
        }
    } catch (error) {
        removeLoadingMessage(loadingId);
        // Show user-friendly error with retry button
        addErrorMessage(error, message);
    } finally {
        // Re-enable input
        chatInput.disabled = false;
        sendButton.disabled = false;
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
    if (screenshot) {
        screenshotImage.src = `data:image/png;base64,${screenshot}`;
        // Show screenshot, hide placeholder
        screenshotImage.style.display = 'block';
        const placeholder = canvasContent.querySelector('.canvas-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
    }
}

function showPlaceholder() {
    // Hide screenshot, show placeholder
    screenshotImage.style.display = 'none';
    const placeholder = canvasContent.querySelector('.canvas-placeholder');
    if (placeholder) {
        placeholder.style.display = 'flex';
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
