import { describe, expect, it } from 'vitest';

import { adaptPromptForTier } from '../prompts/index.js';
import { routeWithEscalation } from '../router.js';
import { routeAndAdaptTask } from '../index.js';

describe('routeAndAdaptTask', () => {
  it('matches the composed routing and prompt adaptation behavior', () => {
    const taskPrompt = 'Find where authentication is implemented';
    const agentType = 'explore';
    const previousFailures = 1;

    const decision = routeWithEscalation({
      taskPrompt,
      agentType,
      previousFailures,
    });

    expect(routeAndAdaptTask(taskPrompt, agentType, previousFailures)).toEqual({
      decision,
      adaptedPrompt: adaptPromptForTier(taskPrompt, decision.tier),
    });
  });
});
