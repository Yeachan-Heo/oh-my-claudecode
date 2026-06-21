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

/**
 * Antigravity provider identity by agent name. This is the authoritative signal:
 * Antigravity (`agy`) exposes Gemini-family models, so its default model display
 * name ("Gemini 3.1 Pro (High)") is indistinguishable from real Gemini by the
 * model string alone. The agent/worker name carries provider identity, so resolve
 * antigravity from it before falling back to model-string heuristics.
 */
export function isAntigravityAgent(agentName?: string): boolean {
  const normalized = normalizeToken(agentName).replace(/[_-]+/g, ' ');
  if (!normalized) {
    return false;
  }
  return /\b(antigravity|agy)\b/.test(normalized);
}

export function getUltraworkSource(
  agentName?: string,
  modelId?: string,
): UltraworkSource {
  if (isPlannerAgent(agentName)) {
    return 'planner';
  }

  // Provider identity (agent name) is authoritative over the model string: an
  // Antigravity worker runs Gemini-family models, so the model string cannot
  // distinguish it from real Gemini. Resolve antigravity by agent identity first.
  if (isAntigravityAgent(agentName)) {
    return 'antigravity';
  }

  if (isGptModel(modelId)) {
    return 'gpt';
  }

  // Model-string fallback when no provider identity is available. Only explicit
  // antigravity/agy model strings resolve to 'antigravity'; a plain Gemini model
  // string (including the antigravity default display name) resolves to 'gemini'
  // here — the honest result when provider identity is absent.
  if (isAntigravityModel(modelId)) {
    return 'antigravity';
  }

  if (isGeminiModel(modelId)) {
    return 'gemini';
  }

  return 'default';
}
