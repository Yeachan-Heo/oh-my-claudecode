export { isPlannerAgent, isGptModel, isGeminiModel, getUltraworkSource, } from './source-detector.js';
export { ULTRAWORK_DEFAULT_MESSAGE, getDefaultUltraworkMessage, } from './default.js';
export { ULTRAWORK_GPT_MESSAGE, getGptUltraworkMessage, } from './gpt.js';
export { ULTRAWORK_GEMINI_MESSAGE, getGeminiUltraworkMessage, } from './gemini.js';
export { ULTRAWORK_PLANNER_SECTION, getPlannerUltraworkMessage, } from './planner.js';
import { getDefaultUltraworkMessage } from './default.js';
import { getGeminiUltraworkMessage } from './gemini.js';
import { getGptUltraworkMessage } from './gpt.js';
import { getPlannerUltraworkMessage } from './planner.js';
import { getUltraworkSource } from './source-detector.js';
export function getUltraworkMessage(agentName, modelId) {
    switch (getUltraworkSource(agentName, modelId)) {
        case 'planner':
            return getPlannerUltraworkMessage();
        case 'gpt':
            return getGptUltraworkMessage();
        case 'gemini':
            return getGeminiUltraworkMessage();
        case 'default':
        default:
            return getDefaultUltraworkMessage();
    }
}
//# sourceMappingURL=index.js.map