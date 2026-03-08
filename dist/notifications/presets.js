/**
 * Custom Integration Presets
 *
 * Pre-configured templates for popular integrations like OpenClaw, n8n, etc.
 */
/**
 * Built-in presets for popular integrations.
 */
export const CUSTOM_INTEGRATION_PRESETS = {
    openclaw: {
        name: 'OpenClaw Gateway',
        description: 'Wake external automations and AI agents on hook events',
        type: 'webhook',
        defaultConfig: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyTemplate: JSON.stringify({
                event: '{{event}}',
                instruction: 'Session {{sessionId}} {{event}} for project {{projectName}}',
                timestamp: '{{timestamp}}',
                context: {
                    projectPath: '{{projectPath}}',
                    projectName: '{{projectName}}',
                    sessionId: '{{sessionId}}'
                }
            }, null, 2),
            timeout: 10000
        },
        suggestedEvents: ['session-start', 'session-end', 'stop'],
        documentationUrl: 'https://github.com/your-org/openclaw'
    },
    n8n: {
        name: 'n8n Webhook',
        description: 'Trigger n8n workflows on OMC events',
        type: 'webhook',
        defaultConfig: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyTemplate: JSON.stringify({
                event: '{{event}}',
                sessionId: '{{sessionId}}',
                projectName: '{{projectName}}',
                projectPath: '{{projectPath}}',
                timestamp: '{{timestamp}}',
                tmuxSession: '{{tmuxSession}}'
            }, null, 2),
            timeout: 10000
        },
        suggestedEvents: ['session-end', 'ask-user-question'],
        documentationUrl: 'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/'
    },
    clawdbot: {
        name: 'ClawdBot',
        description: 'Send notifications to ClawdBot webhook',
        type: 'webhook',
        defaultConfig: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyTemplate: JSON.stringify({
                type: '{{event}}',
                session: '{{sessionId}}',
                project: '{{projectName}}',
                timestamp: '{{timestamp}}'
            }, null, 2),
            timeout: 5000
        },
        suggestedEvents: ['session-end', 'session-start'],
        documentationUrl: 'https://github.com/your-org/clawdbot'
    },
    'generic-webhook': {
        name: 'Generic Webhook',
        description: 'Custom webhook integration',
        type: 'webhook',
        defaultConfig: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyTemplate: JSON.stringify({
                event: '{{event}}',
                sessionId: '{{sessionId}}',
                projectName: '{{projectName}}',
                timestamp: '{{timestamp}}'
            }, null, 2),
            timeout: 10000
        },
        suggestedEvents: ['session-end']
    },
    'generic-cli': {
        name: 'Generic CLI Command',
        description: 'Execute custom command on events',
        type: 'cli',
        defaultConfig: {
            command: 'curl',
            args: ['-X', 'POST', '-d', 'event={{event}}&session={{sessionId}}', 'https://example.com/webhook'],
            timeout: 5000
        },
        suggestedEvents: ['session-end']
    }
};
/**
 * Get list of available presets for display in UI.
 */
export function getPresetList() {
    return Object.entries(CUSTOM_INTEGRATION_PRESETS).map(([id, preset]) => ({
        id,
        name: preset.name,
        description: preset.description,
        type: preset.type
    }));
}
/**
 * Get preset by ID.
 */
export function getPreset(id) {
    return CUSTOM_INTEGRATION_PRESETS[id];
}
/**
 * Check if a preset ID is valid.
 */
export function isValidPreset(id) {
    return id in CUSTOM_INTEGRATION_PRESETS;
}
//# sourceMappingURL=presets.js.map