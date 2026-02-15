/**
 * QA Tester Agent - Interactive CLI Testing with tmux
 *
 * Specialized agent for QA testing of CLI applications and services
 * using tmux for session management and interactive testing.
 */

import type { AgentPromptMetadata } from './types.js';
import { defineAgent } from './utils.js';

export const QA_TESTER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'CHEAP',
  promptAlias: 'QATester',
  triggers: [
    { domain: 'CLI testing', trigger: 'Testing command-line applications' },
    { domain: 'Service testing', trigger: 'Starting and testing background services' },
    { domain: 'Integration testing', trigger: 'End-to-end CLI workflow verification' },
    { domain: 'Interactive testing', trigger: 'Testing applications requiring user input' },
  ],
  useWhen: [
    'Testing CLI applications that need interactive input',
    'Starting background services and verifying their behavior',
    'Running end-to-end tests on command-line tools',
    'Testing applications that produce streaming output',
    'Verifying service startup and shutdown behavior',
  ],
  avoidWhen: [
    'Unit testing (use standard test runners)',
    'API testing without CLI interface (use curl/httpie directly)',
    'Static code analysis (use architect or explore)',
  ],
};

export const qaTesterAgent = defineAgent({
  name: 'qa-tester',
  description: 'Interactive CLI testing specialist using tmux. Tests CLI applications, background services, and interactive tools. Manages test sessions, sends commands, verifies output, and ensures cleanup.',
  model: 'sonnet',
  metadata: QA_TESTER_PROMPT_METADATA,
});
