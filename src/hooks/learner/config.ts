/**
 * Learner Configuration
 *
 * Handles configuration loading and validation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DEBUG_ENABLED } from './constants.js';

export interface LearnerConfig {
  /** Feature enabled/disabled */
  enabled: boolean;
  /** Detection configuration */
  detection: {
    /** Enable auto-detection */
    enabled: boolean;
    /** Confidence threshold for prompting (0-100) */
    promptThreshold: number;
    /** Cooldown between prompts (messages) */
    promptCooldown: number;
  };
  /** Quality gate configuration */
  quality: {
    /** Minimum score to accept (0-100) */
    minScore: number;
    /** Minimum problem length */
    minProblemLength: number;
    /** Minimum solution length */
    minSolutionLength: number;
  };
  /** Storage configuration */
  storage: {
    /** Maximum skills per scope */
    maxSkillsPerScope: number;
    /** Auto-prune old skills */
    autoPrune: boolean;
    /** Days before auto-prune (if enabled) */
    pruneDays: number;
  };
}

const DEFAULT_CONFIG: LearnerConfig = {
  enabled: true,
  detection: {
    enabled: true,
    promptThreshold: 60,
    promptCooldown: 5,
  },
  quality: {
    minScore: 50,
    minProblemLength: 10,
    minSolutionLength: 20,
  },
  storage: {
    maxSkillsPerScope: 100,
    autoPrune: false,
    pruneDays: 90,
  },
};

const CONFIG_PATH = join(homedir(), '.claude', 'omc', 'learner.json');

/**
 * Load configuration from disk.
 */
export function loadConfig(): LearnerConfig {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const loaded = JSON.parse(content);
    return mergeConfig(DEFAULT_CONFIG, loaded);
  } catch (error) {
    if (DEBUG_ENABLED) {
      console.error('[learner] Error loading config:', error);
    }
    return DEFAULT_CONFIG;
  }
}

/**
 * Save configuration to disk.
 */
export function saveConfig(config: Partial<LearnerConfig>): boolean {
  const merged = mergeConfig(DEFAULT_CONFIG, config);

  try {
    const dir = join(homedir(), '.claude', 'omc');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    return true;
  } catch (error) {
    if (DEBUG_ENABLED) {
      console.error('[learner] Error saving config:', error);
    }
    return false;
  }
}

/**
 * Merge partial config with defaults.
 */
function mergeConfig(
  defaults: LearnerConfig,
  partial: Partial<LearnerConfig>
): LearnerConfig {
  return {
    enabled: partial.enabled ?? defaults.enabled,
    detection: {
      ...defaults.detection,
      ...partial.detection,
    },
    quality: {
      ...defaults.quality,
      ...partial.quality,
    },
    storage: {
      ...defaults.storage,
      ...partial.storage,
    },
  };
}

/**
 * Get a specific config value.
 */
export function getConfigValue<K extends keyof LearnerConfig>(
  key: K
): LearnerConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Update a specific config value.
 */
export function setConfigValue<K extends keyof LearnerConfig>(
  key: K,
  value: LearnerConfig[K]
): boolean {
  const config = loadConfig();
  config[key] = value;
  return saveConfig(config);
}
