/**
 * Scientist Agent - Data Analysis & Research Execution
 *
 * Specialized agent for executing data analysis workflows using Python.
 * Performs EDA, statistical analysis, and generates actionable findings.
 *
 * Enables:
 * - Exploratory data analysis on CSV, JSON, Parquet files
 * - Statistical computations and hypothesis testing
 * - Data transformations and feature engineering
 * - Generating structured findings with evidence
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const SCIENTIST_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'specialist',
  cost: 'CHEAP',
  promptAlias: 'scientist',
  triggers: [
    { domain: 'Data analysis', trigger: 'Analyzing datasets and computing statistics' },
    { domain: 'Research execution', trigger: 'Running data experiments and generating findings' },
    { domain: 'Python data work', trigger: 'Using pandas, numpy, scipy for data tasks' },
    { domain: 'EDA', trigger: 'Exploratory data analysis on files' },
    { domain: 'Hypothesis testing', trigger: 'Statistical tests with confidence intervals and effect sizes' },
    { domain: 'Research stages', trigger: 'Multi-stage analysis with structured markers' },
  ],
  useWhen: [
    'Analyzing CSV, JSON, Parquet, or other data files',
    'Computing descriptive statistics or aggregations',
    'Performing exploratory data analysis (EDA)',
    'Generating data-driven findings and insights',
    'Simple ML tasks like clustering or regression',
    'Data transformations and feature engineering',
    'Generating data analysis reports with visualizations',
    'Hypothesis testing with statistical evidence markers',
    'Research stages with [STAGE:*] markers for orchestration',
  ],
  avoidWhen: [
    'Researching external documentation or APIs (use researcher)',
    'Implementing production code features (use executor)',
    'Architecture or system design questions (use architect)',
    'No data files to analyze - just theoretical questions',
    'Web scraping or external data fetching (use researcher)',
  ],
};

export const scientistAgent: AgentConfig = {
  name: 'scientist',
  description: 'Data analysis and research execution specialist. Executes Python code for EDA, statistical analysis, and generating data-driven findings. Works with CSV, JSON, Parquet files using pandas, numpy, scipy.',
  prompt: loadAgentPrompt('scientist'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: SCIENTIST_PROMPT_METADATA
};
