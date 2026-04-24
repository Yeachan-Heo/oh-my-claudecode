export type UltraworkSource = 'planner' | 'gpt' | 'gemini' | 'default';
export declare function isPlannerAgent(agentName?: string): boolean;
export declare function isGptModel(modelId?: string): boolean;
export declare function isGeminiModel(modelId?: string): boolean;
export declare function getUltraworkSource(agentName?: string, modelId?: string): UltraworkSource;
//# sourceMappingURL=source-detector.d.ts.map