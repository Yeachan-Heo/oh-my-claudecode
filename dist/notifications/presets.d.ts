/**
 * Custom Integration Presets
 *
 * Pre-configured templates for popular integrations like OpenClaw, n8n, etc.
 */
export interface PresetConfig {
    name: string;
    description: string;
    type: 'webhook' | 'cli';
    defaultConfig: {
        method?: string;
        headers?: Record<string, string>;
        bodyTemplate?: string;
        command?: string;
        args?: string[];
        timeout?: number;
    };
    suggestedEvents: string[];
    documentationUrl?: string;
}
/**
 * Built-in presets for popular integrations.
 */
export declare const CUSTOM_INTEGRATION_PRESETS: Record<string, PresetConfig>;
export type PresetName = keyof typeof CUSTOM_INTEGRATION_PRESETS;
/**
 * Get list of available presets for display in UI.
 */
export declare function getPresetList(): {
    id: string;
    name: string;
    description: string;
    type: string;
}[];
/**
 * Get preset by ID.
 */
export declare function getPreset(id: PresetName): PresetConfig | undefined;
/**
 * Check if a preset ID is valid.
 */
export declare function isValidPreset(id: string): id is PresetName;
//# sourceMappingURL=presets.d.ts.map