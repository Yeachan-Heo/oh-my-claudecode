/**
 * Think Mode Types
 *
 * Type definitions for think mode state and configuration.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */

/**
 * State tracking for think mode in a session
 */
export interface ThinkModeState {
  /** Whether think mode was requested via keyword */
  requested: boolean;
  /** Whether model was switched to high variant */
  modelSwitched: boolean;
  /** Whether thinking config was injected */
  thinkingConfigInjected: boolean;
  /** Provider ID if known */
  providerId?: string;
  /** Model ID if known */
  modelId?: string;
}

/**
 * Model reference with provider and model ID
 */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/**
 * Message with optional model reference
 */
export interface MessageWithModel {
  model?: ModelRef;
}

/**
 * Input for think mode hook processing
 */
export interface ThinkModeInput {
  parts: Array<{ type: string; text?: string }>;
  message: MessageWithModel;
}

/**
 * Thinking configuration for Claude models
 */
export interface ClaudeThinkingConfig {
  thinking: {
    type: 'enabled' | 'disabled';
    budgetTokens: number;
  };
  maxTokens?: number;
}

/**
 * Provider-specific thinking configurations
 */
export type ThinkingConfig = Record<string, unknown>;
