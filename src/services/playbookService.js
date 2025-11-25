const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

/**
 * PlaybookService - Executes automation steps from a markdown file
 * Each step in the markdown is sent to the LLM service sequentially
 */
class PlaybookService {
  constructor(llmService, mainWindow) {
    this.llmService = llmService;
    this.mainWindow = mainWindow;
    this.isExecuting = false;
    this.currentStepIndex = 0;
    this.steps = [];
  }

  /**
   * Parse markdown file and extract steps
   * Steps can be:
   * - Each line (non-empty, non-heading)
   * - Numbered list items (1. Step)
   * - Bullet points (- Step or * Step)
   */
  async parseMarkdownFile(filePath) {
    logger.info(`[Playbook] Parsing markdown file: ${filePath}`);
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const steps = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines
      if (!trimmed) continue;
      
      // Skip markdown headings
      if (trimmed.startsWith('#')) continue;
      
      // Skip horizontal rules
      if (/^[-*_]{3,}$/.test(trimmed)) continue;
      
      // Parse numbered list items (1. Step, 2. Step, etc.)
      const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (numberedMatch) {
        steps.push(numberedMatch[1].trim());
        continue;
      }
      
      // Parse bullet points (- Step or * Step)
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) {
        steps.push(bulletMatch[1].trim());
        continue;
      }
      
      // Skip any other text (descriptions, titles, etc.)
      // Only numbered lists and bullet points are treated as steps
    }

    logger.info(`[Playbook] Parsed ${steps.length} steps from markdown file`);
    return steps;
    
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Playbook file not found: ${filePath}`);
      }
      throw error;
    }
  }

  /**
   * Execute the playbook - send each step to LLM service sequentially
   */
  async executePlaybook(filePath) {
    if (this.isExecuting) {
      throw new Error('Playbook is already executing');
    }

    try {
      this.isExecuting = true;
      this.currentStepIndex = 0;
      
      // Validate file path
      if (!filePath) {
        throw new Error('No playbook file path provided');
      }
      
      // Parse the markdown file
      this.steps = await this.parseMarkdownFile(filePath);
      
      if (this.steps.length === 0) {
        throw new Error('No valid steps found in markdown file. Make sure to use numbered lists (1. Step), bullet points (- Step), or plain text lines.');
      }

      // Notify UI that playbook execution is starting
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('playbook-started');
      }
      
      // Send initial message to UI
      this.sendToUI('system', `📋 Starting playbook execution: ${path.basename(filePath)}`);
      this.sendToUI('system', `Found ${this.steps.length} steps to execute`);
      
      // Execute each step sequentially
      for (let i = 0; i < this.steps.length; i++) {
        this.currentStepIndex = i;
        const step = this.steps[i];
        
        logger.info(`[Playbook] Executing step ${i + 1}/${this.steps.length}: ${step}`);
        
        // Send step to UI as user message
        this.sendToUI('user', step);
        
        // Wait a moment for UI to update
        await this.sleep(300);
        
        try {
          // Execute the step via LLM service
          // This will wait for LLM to complete all tool calls
          logger.info(`[Playbook] Sending step ${i + 1} to LLM service...`);
          await this.executeStep(step);
          
          logger.info(`[Playbook] Step ${i + 1}/${this.steps.length} LLM processing completed`);
          
          // Wait for LLM service to completely finish (in case of async operations)
          await this.waitForLLMCompletion();
          
          // Additional delay for UI to fully update and allow time for
          // page state to stabilize (especially after navigation/login)
          logger.info(`[Playbook] Waiting for UI and page state to fully settle after step ${i + 1}...`);
          await this.sleep(3000); // Increased from 1s to 3s for complex operations
          
          logger.info(`[Playbook] Step ${i + 1}/${this.steps.length} fully completed, ready for next step`);
          
        } catch (error) {
          logger.error(`[Playbook] Step ${i + 1}/${this.steps.length} failed:`, error);
          this.sendToUI('system', `❌ Step ${i + 1} failed: ${error.message}`);
          
          // Stop execution on error
          throw new Error(`Playbook execution stopped at step ${i + 1}: ${error.message}`);
        }
      }
      
      // All steps completed
      this.sendToUI('system', `✅ Playbook execution completed successfully (${this.steps.length}/${this.steps.length} steps)`);
      logger.info('[Playbook] Playbook execution completed successfully');
      
      // Get validation results
      const validationResults = this.llmService.getValidationResults();
      
      // Log validation summary
      if (validationResults.length > 0) {
        logger.info(`[Playbook] ${validationResults.length} validation(s) recorded during playbook execution`);
        const passCount = validationResults.filter(v => v.result === 'pass').length;
        const failCount = validationResults.filter(v => v.result === 'fail').length;
        logger.info(`[Playbook] Validation summary: ${passCount} passed, ${failCount} failed`);
      }
      
      // Notify UI that playbook execution is complete with validation results
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('playbook-completed', { 
          success: true, 
          validationResults 
        });
      }
      
    } catch (error) {
      logger.error('[Playbook] Playbook execution failed:', error);
      this.sendToUI('system', `❌ Playbook execution failed: ${error.message}`);
      
      // Notify UI that playbook execution failed
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('playbook-completed', { success: false, error: error.message });
      }
      
      throw error;
      
    } finally {
      this.isExecuting = false;
      this.currentStepIndex = 0;
      this.steps = [];
    }
  }

  /**
   * Execute a single step by sending it to the LLM service
   */
  async executeStep(step) {
    try {
      // Send the step to LLM service and wait for response
      const response = await this.llmService.processMessage(step);
      
      // Display the response in the UI
      if (response) {
        this.sendToUI('assistant', response);
      }
      
      return response;
      
    } catch (error) {
      logger.error('[Playbook] Error executing step:', error);
      throw error;
    }
  }

  /**
   * Send a message to the renderer UI
   */
  sendToUI(role, message) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('playbook-message', { role, message });
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Wait for LLM service to finish executing
   * Polls the isExecuting flag every 100ms until it's false
   */
  async waitForLLMCompletion() {
    const maxWaitTime = 300000; // 5 minutes max wait
    const pollInterval = 100; // Check every 100ms
    let totalWaitTime = 0;
    
    logger.info('[Playbook] Waiting for LLM service to complete execution...');
    
    while (this.llmService.isExecuting && totalWaitTime < maxWaitTime) {
      await this.sleep(pollInterval);
      totalWaitTime += pollInterval;
      
      // Log progress every 5 seconds
      if (totalWaitTime % 5000 === 0) {
        logger.info(`[Playbook] Still waiting for LLM completion (${totalWaitTime / 1000}s)...`);
      }
    }
    
    if (totalWaitTime >= maxWaitTime) {
      logger.warn('[Playbook] LLM execution wait timeout reached');
      throw new Error('LLM execution timeout - step took too long to complete');
    }
    
    logger.info(`[Playbook] LLM service completed execution (waited ${totalWaitTime}ms)`);
  }

  /**
   * Get current execution status
   */
  getStatus() {
    return {
      isExecuting: this.isExecuting,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.steps.length,
      currentStep: this.steps[this.currentStepIndex] || null
    };
  }
}

module.exports = PlaybookService;
