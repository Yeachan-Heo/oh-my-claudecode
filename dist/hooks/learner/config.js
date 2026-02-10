/**
 * Learner Configuration
 *
 * Handles configuration loading and validation.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DEBUG_ENABLED } from './constants.js';
const DEFAULT_CONFIG = {
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
export function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        return DEFAULT_CONFIG;
    }
    try {
        const content = readFileSync(CONFIG_PATH, 'utf-8');
        const loaded = JSON.parse(content);
        return mergeConfig(DEFAULT_CONFIG, loaded);
    }
    catch (error) {
        if (DEBUG_ENABLED) {
            console.error('[learner] Error loading config:', error);
        }
        return DEFAULT_CONFIG;
    }
}
/**
 * Save configuration to disk.
 */
export function saveConfig(config) {
    const merged = mergeConfig(DEFAULT_CONFIG, config);
    try {
        const dir = join(homedir(), '.claude', 'omc');
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
        return true;
    }
    catch (error) {
        if (DEBUG_ENABLED) {
            console.error('[learner] Error saving config:', error);
        }
        return false;
    }
}
/**
 * Merge partial config with defaults.
 */
function mergeConfig(defaults, partial) {
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
export function getConfigValue(key) {
    const config = loadConfig();
    return config[key];
}
/**
 * Update a specific config value.
 */
export function setConfigValue(key, value) {
    const config = loadConfig();
    config[key] = value;
    return saveConfig(config);
}
//# sourceMappingURL=config.js.map