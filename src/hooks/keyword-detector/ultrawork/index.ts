export {
  isPlannerAgent,
  isGptModel,
  isGeminiModel,
  isAntigravityModel,
  getUltraworkSource,
} from './source-detector.js';
export type { UltraworkSource } from './source-detector.js';
export {
  ULTRAWORK_DEFAULT_MESSAGE,
  getDefaultUltraworkMessage,
} from './default.js';
export {
  ULTRAWORK_GPT_MESSAGE,
  getGptUltraworkMessage,
} from './gpt.js';
export {
  ULTRAWORK_GEMINI_MESSAGE,
  getGeminiUltraworkMessage,
} from './gemini.js';
export {
  ULTRAWORK_ANTIGRAVITY_MESSAGE,
  getAntigravityUltraworkMessage,
} from './antigravity.js';
export {
  ULTRAWORK_PLANNER_SECTION,
  getPlannerUltraworkMessage,
} from './planner.js';

import { getDefaultUltraworkMessage } from './default.js';
import { getGeminiUltraworkMessage } from './gemini.js';
import { getAntigravityUltraworkMessage } from './antigravity.js';
import { getGptUltraworkMessage } from './gpt.js';
import { getPlannerUltraworkMessage } from './planner.js';
import { getUltraworkSource } from './source-detector.js';

export function getUltraworkMessage(
  agentName?: string,
  modelId?: string,
): string {
  switch (getUltraworkSource(agentName, modelId)) {
    case 'planner':
      return getPlannerUltraworkMessage();
    case 'gpt':
      return getGptUltraworkMessage();
    case 'gemini':
      return getGeminiUltraworkMessage();
    case 'antigravity':
      return getAntigravityUltraworkMessage();
    case 'default':
    default:
      return getDefaultUltraworkMessage();
  }
}
