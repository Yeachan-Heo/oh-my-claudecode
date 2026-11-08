/**
 * Think Mode Hook
 *
 * Activates extended thinking/reasoning mode when users include
 * think keywords in their prompts.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */

import { detectThinkKeyword, extractPromptText, detectUltrathinkKeyword } from './detector.js';
import { getHighVariant, isAlreadyHighVariant, getThinkingConfig, getClaudeThinkingConfig } from './switcher.js';
import type { ThinkModeState, ThinkModeInput } from './types.js';

// Re-export all submodules
export * from './detector.js';
export * from './switcher.js';
export * from './types.js';

/** Session state storage for think mode */
const thinkModeState = new Map<string, ThinkModeState>();

/**
 * Clear think mode state for a session.
 */
export function clearThinkModeState(sessionId: string): void {
  thinkModeState.delete(sessionId);
}

/**
 * Get the current think mode state for a session.
 */
export function getThinkModeState(sessionId: string): ThinkModeState | undefined {
  return thinkModeState.get(sessionId);
}

/**
 * Check if think mode is active for a session.
 */
export function isThinkModeActive(sessionId: string): boolean {
  const state = thinkModeState.get(sessionId);
  return state?.requested ?? false;
}

/**
 * Process a prompt for think mode keywords.
 * Returns the detected state.
 */
export function processThinkMode(
  sessionId: string,
  promptText: string
): ThinkModeState {
  const state: ThinkModeState = {
    requested: false,
    modelSwitched: false,
    thinkingConfigInjected: false,
  };

  if (!detectThinkKeyword(promptText)) {
    thinkModeState.set(sessionId, state);
    return state;
  }

  state.requested = true;
  thinkModeState.set(sessionId, state);
  return state;
}

/**
 * Create the think mode hook for Claude Code integration.
 */
export function createThinkModeHook() {
  return {
    /**
     * Process chat parameters and detect think mode.
     */
    processChatParams: (
      sessionId: string,
      input: ThinkModeInput
    ): ThinkModeState => {
      const promptText = extractPromptText(input.parts);

      const state: ThinkModeState = {
        requested: false,
        modelSwitched: false,
        thinkingConfigInjected: false,
      };

      if (!detectThinkKeyword(promptText)) {
        thinkModeState.set(sessionId, state);
        return state;
      }

      state.requested = true;

      const currentModel = input.message.model;
      if (!currentModel) {
        thinkModeState.set(sessionId, state);
        return state;
      }

      state.providerId = currentModel.providerId;
      state.modelId = currentModel.modelId;

      if (isAlreadyHighVariant(currentModel.modelId)) {
        thinkModeState.set(sessionId, state);
        return state;
      }

      const highVariant = getHighVariant(currentModel.modelId);
      const thinkingConfig = getThinkingConfig(currentModel.providerId, currentModel.modelId);

      if (highVariant) {
        input.message.model = {
          providerId: currentModel.providerId,
          modelId: highVariant,
        };
        state.modelSwitched = true;
      }

      if (thinkingConfig) {
        Object.assign(input.message, thinkingConfig);
        state.thinkingConfigInjected = true;
      }

      thinkModeState.set(sessionId, state);
      return state;
    },

    /**
     * Handle session deletion events.
     */
    onSessionDeleted: (sessionId: string): void => {
      thinkModeState.delete(sessionId);
    },

    /**
     * Check if think mode was requested.
     */
    isRequested: (sessionId: string): boolean => {
      const state = thinkModeState.get(sessionId);
      return state?.requested ?? false;
    },

    /**
     * Get the current state.
     */
    getState: (sessionId: string): ThinkModeState | undefined => {
      return thinkModeState.get(sessionId);
    },

    /**
     * Clear state for a session.
     */
    clear: clearThinkModeState,
  };
}

/**
 * Simplified function to check if a prompt requests think mode.
 * For direct use without hook context.
 */
export function shouldActivateThinkMode(prompt: string): boolean {
  return detectThinkKeyword(prompt);
}

/**
 * Check if ultrathink (highest reasoning) was requested.
 */
export function shouldActivateUltrathink(prompt: string): boolean {
  return detectUltrathinkKeyword(prompt);
}

/**
 * Get Claude thinking configuration for extended thinking.
 * For direct use when manually configuring Claude API calls.
 */
export { getClaudeThinkingConfig };
