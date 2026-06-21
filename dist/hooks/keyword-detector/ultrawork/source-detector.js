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
export function isAntigravityModel(modelId) {
    const normalized = normalizeToken(modelId);
    return (normalized.includes('antigravity') ||
        normalized.includes('agy'));
}
export function getUltraworkSource(agentName, modelId) {
    if (isPlannerAgent(agentName)) {
        return 'planner';
    }
    if (isGptModel(modelId)) {
        return 'gpt';
    }
    // Antigravity is checked before gemini: the antigravity default model display
    // name contains "Gemini", so a plain gemini match would shadow it. The
    // antigravity check keys on the antigravity/agy provider identity.
    if (isAntigravityModel(modelId)) {
        return 'antigravity';
    }
    if (isGeminiModel(modelId)) {
        return 'gemini';
    }
    return 'default';
}
//# sourceMappingURL=source-detector.js.map