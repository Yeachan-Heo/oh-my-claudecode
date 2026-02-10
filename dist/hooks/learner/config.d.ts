/**
 * Learner Configuration
 *
 * Handles configuration loading and validation.
 */
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
/**
 * Load configuration from disk.
 */
export declare function loadConfig(): LearnerConfig;
/**
 * Save configuration to disk.
 */
export declare function saveConfig(config: Partial<LearnerConfig>): boolean;
/**
 * Get a specific config value.
 */
export declare function getConfigValue<K extends keyof LearnerConfig>(key: K): LearnerConfig[K];
/**
 * Update a specific config value.
 */
export declare function setConfigValue<K extends keyof LearnerConfig>(key: K, value: LearnerConfig[K]): boolean;
//# sourceMappingURL=config.d.ts.map