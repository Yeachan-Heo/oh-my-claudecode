export type UltraworkSource = 'planner' | 'gpt' | 'gemini' | 'antigravity' | 'default';

function normalizeToken(value?: string): string {
  return value?.trim().toLowerCase() ?? '';
}

export function isPlannerAgent(agentName?: string): boolean {
  const normalized = normalizeToken(agentName).replace(/[_-]+/g, ' ');
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('prometheus') ||
    normalized.includes('planner') ||
    normalized.includes('planning') ||
    /\bplan\b/.test(normalized)
  );
}

export function isGptModel(modelId?: string): boolean {
  const normalized = normalizeToken(modelId);
  return (
    normalized.includes('gpt') ||
    normalized.includes('openai') ||
    normalized.includes('codex')
  );
}

export function isGeminiModel(modelId?: string): boolean {
  const normalized = normalizeToken(modelId);
  return (
    normalized.includes('gemini') ||
    normalized.includes('google')
  );
}

export function isAntigravityModel(modelId?: string): boolean {
  const normalized = normalizeToken(modelId);
  return (
    normalized.includes('antigravity') ||
    normalized.includes('agy')
  );
}

export function getUltraworkSource(
  agentName?: string,
  modelId?: string,
): UltraworkSource {
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
