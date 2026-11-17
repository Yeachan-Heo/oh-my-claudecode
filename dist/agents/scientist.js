/**
 * Scientist Agent - Data Analysis & Research Execution
 *
 * Specialized agent for executing data analysis workflows using Python.
 * Performs EDA, statistical analysis, and generates actionable findings.
 *
 * Enables:
 * - Statistical analysis and hypothesis testing on in-memory data
 * - Descriptive statistics with Python built-in functions
 * - Generating structured findings with evidence markers
 */
import { loadAgentPrompt } from './utils.js';
export const SCIENTIST_PROMPT_METADATA = {
    category: 'specialist',
    cost: 'CHEAP',
    promptAlias: 'scientist',
    triggers: [
        { domain: 'Data analysis', trigger: 'Analyzing in-memory data and computing statistics' },
        { domain: 'Research execution', trigger: 'Running data experiments and generating findings' },
        { domain: 'Python data work', trigger: 'Computing statistics on in-memory data with built-in functions' },
        { domain: 'EDA', trigger: 'Exploratory data analysis on in-memory data' },
        { domain: 'Hypothesis testing', trigger: 'Statistical comparisons with built-in functions on in-memory data' },
        { domain: 'Research stages', trigger: 'Multi-stage analysis with structured markers' },
    ],
    useWhen: [
        'Analyzing in-memory data supplied in the task',
        'Computing descriptive statistics or aggregations with Python built-ins',
        'Performing exploratory data analysis (EDA) on in-memory data',
        'Generating data-driven findings and insights',
        'In-memory data transformations',
        'Hypothesis testing with statistical evidence markers',
        'Research stages with [STAGE:*] markers for orchestration',
    ],
    avoidWhen: [
        'Researching external documentation or APIs (use document-specialist)',
        'Implementing production code features (use executor)',
        'Architecture or system design questions (use architect)',
        'Reading files, importing third-party libraries, or plotting (imports, file I/O, and third-party packages are blocked in the python_repl sandbox)',
        'Web scraping or external data fetching (use document-specialist)',
    ],
};
export const scientistAgent = {
    name: 'scientist',
    description: 'Data analysis and research execution specialist. Executes sandboxed Python code for statistical analysis and generating data-driven findings using built-in functions on in-memory data.',
    prompt: loadAgentPrompt('scientist'),
    model: 'sonnet',
    defaultModel: 'sonnet',
    metadata: SCIENTIST_PROMPT_METADATA
};
//# sourceMappingURL=scientist.js.map