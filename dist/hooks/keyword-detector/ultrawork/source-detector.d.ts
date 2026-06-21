export type UltraworkSource = 'planner' | 'gpt' | 'gemini' | 'antigravity' | 'default';
export declare function isPlannerAgent(agentName?: string): boolean;
export declare function isGptModel(modelId?: string): boolean;
export declare function isGeminiModel(modelId?: string): boolean;
export declare function isAntigravityModel(modelId?: string): boolean;
/**
 * Antigravity provider identity by agent name. This is the authoritative signal:
 * Antigravity (`agy`) exposes Gemini-family models, so its default model display
 * name ("Gemini 3.1 Pro (High)") is indistinguishable from real Gemini by the
 * model string alone. The agent/worker name carries provider identity, so resolve
 * antigravity from it before falling back to model-string heuristics.
 */
export declare function isAntigravityAgent(agentName?: string): boolean;
export declare function getUltraworkSource(agentName?: string, modelId?: string): UltraworkSource;
//# sourceMappingURL=source-detector.d.ts.map