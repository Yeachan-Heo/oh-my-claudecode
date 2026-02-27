/**
 * QA Stage Adapter
 *
 * Wraps the existing UltraQA module into the pipeline stage adapter interface.
 *
 * The QA stage runs build/lint/test cycling until all checks pass
 * or the maximum number of cycles is reached.
 */

import type { PipelineStageAdapter, PipelineConfig, PipelineContext } from '../pipeline-types.js';
import { getQAPrompt } from '../prompts.js';

export const QA_COMPLETION_SIGNAL = 'PIPELINE_QA_COMPLETE';

export const qaAdapter: PipelineStageAdapter = {
  id: 'qa',
  name: 'Quality Assurance',
  completionSignal: QA_COMPLETION_SIGNAL,

  shouldSkip(config: PipelineConfig): boolean {
    return !config.qa;
  },

  getPrompt(_context: PipelineContext): string {
    return `## PIPELINE STAGE: QA (Quality Assurance)

Run build/lint/test cycling until all checks pass.

${getQAPrompt()}

### Completion

When all QA checks pass:

Signal: ${QA_COMPLETION_SIGNAL}
`;
  },
};
