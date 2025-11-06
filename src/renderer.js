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

// State
let isStreaming = false;
let messageHistory = [];
let fpsFrames = [];
let lastFrameTime = Date.now();

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await initializeApp();
    setupEventListeners();
});

async function initializeApp() {
    try {
        console.log('[Renderer] Initializing app...');
        
        // Check if MCP tools are available
        console.log('[Renderer] Checking MCP tools...');
        const result = await window.electronAPI.getMCPTools();
        if (result.success) {
            updateStatus('connected', 'Connected');
            console.log('[Renderer] Available MCP tools:', result.tools.length);
            
            // Wait for services to be ready before getting provider and starting screenshot stream
            console.log('[Renderer] Waiting for services to be ready...');
            window.electronAPI.onServicesReady(async () => {
                console.log('[Renderer] Services ready!');
                
                // Get LLM provider now that services are initialized
                const providerResult = await window.electronAPI.getLLMProvider();
                if (providerResult.success) {
                    const provider = providerResult.provider;
                    llmBadge.textContent = provider === 'gemini' ? 'Gemini' : 'Claude';
                    if (provider === 'gemini') {
                        llmBadge.classList.add('gemini');
                    }
                    console.log('[Renderer] Using LLM provider:', provider);
                }
                
                // Auto-start screenshot stream
                console.log('[Renderer] Auto-starting screenshot stream...');
                await startStream();
                console.log('[Renderer] Screenshot stream start completed');
            });
        } else {
            updateStatus('error', 'Connection Error');
            console.error('[Renderer] Failed to get MCP tools:', result.error);
        }
    } catch (error) {
        updateStatus('error', 'Initialization Failed');
        console.error('[Renderer] Initialization error:', error);
    }
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
    
    // Screenshot stream is auto-started in initializeApp
    
    // Listen for screenshot updates
    window.electronAPI.onScreenshotUpdate((screenshot) => {
        updateScreenshot(screenshot);
        updateFPS();
    });
}

async function handleSendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;
    
    // Disable input while processing
    chatInput.disabled = true;
    sendButton.disabled = true;
    
    // Add user message to chat
    addMessage('user', message);
    chatInput.value = '';
    
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
    console.log('[Renderer] startStream called, isStreaming:', isStreaming);
    if (isStreaming) {
        console.log('[Renderer] Already streaming, returning');
        return;
    }
    
    // Start streaming
    console.log('[Renderer] Calling startScreenshotStream...');
    const result = await window.electronAPI.startScreenshotStream();
    console.log('[Renderer] startScreenshotStream result:', result);
    if (result.success) {
        isStreaming = true;
        const placeholder = document.querySelector('.canvas-placeholder');
        if (placeholder) {
            console.log('[Renderer] Hiding placeholder');
            placeholder.style.display = 'none';
        }
        screenshotImage.style.display = 'block';
        console.log('[Renderer] Screenshot stream started successfully');
    } else {
        console.error('[Renderer] Failed to start screenshot stream:', result.error);
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
        if (errorInfo.status && errorInfo.statusText) {
            statusText = `${errorInfo.status} ${errorInfo.statusText}`;
            errorMessage = errorInfo.statusText;
        } else if (errorInfo.message) {
            errorMessage = errorInfo.message;
        } else if (typeof errorInfo === 'string') {
            errorMessage = errorInfo;
        }
    } else if (typeof errorInfo === 'string') {
        errorMessage = errorInfo;
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
        // Resend the original message
        if (originalMessage) {
            chatInput.value = originalMessage;
            sendMessage();
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
    }
}

function updateFPS() {
    const now = Date.now();
    fpsFrames.push(now);
    
    // Keep only frames from the last second
    fpsFrames = fpsFrames.filter(time => now - time < 1000);
    
    const fps = fpsFrames.length;
    fpsCounter.textContent = `${fps} FPS`;
}

function updateStatus(status, text) {
    statusDot.className = `status-dot ${status}`;
    statusText.textContent = text;
}
