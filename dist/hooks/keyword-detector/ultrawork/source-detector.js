function normalizeToken(value) {
    return value?.trim().toLowerCase() ?? '';
}
export function isPlannerAgent(agentName) {
    const normalized = normalizeToken(agentName).replace(/[_-]+/g, ' ');
    if (!normalized) {
        return false;
    }
    return (normalized.includes('prometheus') ||
        normalized.includes('planner') ||
        normalized.includes('planning') ||
        /\bplan\b/.test(normalized));
}
export function isGptModel(modelId) {
    const normalized = normalizeToken(modelId);
    return (normalized.includes('gpt') ||
        normalized.includes('openai') ||
        normalized.includes('codex'));
}
export function isGeminiModel(modelId) {
    const normalized = normalizeToken(modelId);
    return (normalized.includes('gemini') ||
        normalized.includes('google'));
}
export function getUltraworkSource(agentName, modelId) {
    if (isPlannerAgent(agentName)) {
        return 'planner';
    }
    if (isGptModel(modelId)) {
        return 'gpt';
    }
    if (isGeminiModel(modelId)) {
        return 'gemini';
    }
    return 'default';
}
//# sourceMappingURL=source-detector.js.map