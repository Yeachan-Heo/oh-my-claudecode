export { isPlannerAgent, isGptModel, isGeminiModel, getUltraworkSource, } from './source-detector.js';
export type { UltraworkSource } from './source-detector.js';
export { ULTRAWORK_DEFAULT_MESSAGE, getDefaultUltraworkMessage, } from './default.js';
export { ULTRAWORK_GPT_MESSAGE, getGptUltraworkMessage, } from './gpt.js';
export { ULTRAWORK_GEMINI_MESSAGE, getGeminiUltraworkMessage, } from './gemini.js';
export { ULTRAWORK_PLANNER_SECTION, getPlannerUltraworkMessage, } from './planner.js';
export declare function getUltraworkMessage(agentName?: string, modelId?: string): string;
//# sourceMappingURL=index.d.ts.map