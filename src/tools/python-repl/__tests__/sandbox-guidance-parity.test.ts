import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { pythonReplTool } from '../tool.js';
import { pythonReplTool as pythonReplToolIndex } from '../index.js';
import { buildListToolsResponse } from '../../../mcp/tool-registry.js';
import { scientistAgent, SCIENTIST_PROMPT_METADATA } from '../../../agents/scientist.js';
import { loadAgentPrompt } from '../../../agents/utils.js';
import { extractPythonGuidance } from './guidance-sections.js';
import { toSdkToolFormat, type GenericToolDefinition } from '../../index.js';

// Every user-facing guidance surface for python_repl must match the bridge
// sandbox (bridge/gyoshu_bridge.py): imports, file I/O, dynamic code
// execution, and third-party libraries are blocked; only built-in functions
// and persistent variables are available (issue #3682). Surfaces below may
// NAME a blocked library to say it is blocked, but must never ADVERTISE or
// DIRECT imports, file I/O, library APIs, ML, or plotting workflows.

const THIRD_PARTY_LIBRARIES = [
  'pandas',
  'numpy',
  'scipy',
  'matplotlib',
  'plotly',
  'sklearn',
  'seaborn',
  'statsmodels',
];

const FILE_IO_DIRECTIVES = [
  'read_csv',
  'read_excel',
  'read_json',
  'read_parquet',
  'read_pickle',
  'to_csv',
  'to_pickle',
  'savefig',
  'os.walk',
  'np.load',
  'np.save',
  'memmap',
  'ctypeslib',
];

const LIBRARY_API_DIRECTIVES = [
  'dataframe',
  'plt.',
  '.head(',
  '.describe(',
  'value_counts',
  'agg backend',
  'pip install',
];

const IMPORT_DIRECTIVES = [
  'import pandas',
  'import numpy',
  'import matplotlib',
  'import os',
  'import json',
  'from pathlib',
];

const ML_DIRECTIVES = ['simple ml', 'clustering or regression', 'ml model training', 'ml/hypothesis', 'data science'];

const SCIENTIST_WORKFLOW_DIRECTIVES = [
  'data files',
  'load data',
  'read data',
  'visualizations',
  'figures/',
];

describe('python_repl sandbox guidance parity (#3682)', () => {
  const listToolsDescription = (() => {
    const { tools } = buildListToolsResponse('');
    const python = tools.find((t) => t.name === 'python_repl');
    if (!python) throw new Error('python_repl missing from standalone ListTools surface');
    return python.description;
  })();

  const toolSurfaces: [string, string][] = [
    ['tool.ts MCP-facing description', pythonReplTool.description],
    ['index.ts in-process server description', pythonReplToolIndex.description],
    ['standalone ListTools surface', listToolsDescription],
  ];

  const allToolTerms = [
    ...THIRD_PARTY_LIBRARIES,
    ...FILE_IO_DIRECTIVES,
    ...LIBRARY_API_DIRECTIVES,
    ...IMPORT_DIRECTIVES,
    ...ML_DIRECTIVES,
  ];

  for (const [name, text] of toolSurfaces) {
    it(`${name} does not advertise blocked libraries, file I/O, imports, or ML`, () => {
      const lower = text.toLowerCase();
      for (const term of allToolTerms) {
        expect(lower, `${name} must not contain "${term}"`).not.toContain(term);
      }
    });

    it(`${name} states the sandbox boundary`, () => {
      const lower = text.toLowerCase();
      expect(lower).toContain('imports');
      expect(lower).toContain('file i/o');
      expect(lower).toContain('blocked');
    });
  }

  describe('scientist agent guidance', () => {
    const scientistSurfaces: [string, string][] = [
      ['scientistAgent.description', scientistAgent.description],
      [
        'SCIENTIST_PROMPT_METADATA triggers/useWhen/avoidWhen',
        JSON.stringify([
          SCIENTIST_PROMPT_METADATA.triggers,
          SCIENTIST_PROMPT_METADATA.useWhen,
          SCIENTIST_PROMPT_METADATA.avoidWhen,
        ]),
      ],
      ['agents/scientist.md prompt', loadAgentPrompt('scientist')],
    ];

    const scientistTerms = [
      ...FILE_IO_DIRECTIVES,
      ...LIBRARY_API_DIRECTIVES,
      ...IMPORT_DIRECTIVES,
      ...ML_DIRECTIVES,
      ...SCIENTIST_WORKFLOW_DIRECTIVES,
    ];

    for (const [name, text] of scientistSurfaces) {
      it(`${name} does not direct file I/O, library APIs, imports, ML, or plotting workflows`, () => {
        const lower = text.toLowerCase();
        for (const term of scientistTerms) {
          expect(lower, `${name} must not direct "${term}"`).not.toContain(term);
        }
      });

      it(`${name} states the sandbox boundary and built-in-only computation`, () => {
        const lower = text.toLowerCase();
        expect(lower).toContain('sandbox');
        expect(lower).toContain('built-in');
      });
    }

    it('does not claim standard deviation needs a blocked library', () => {
      // `variance ** 0.5` runs in the sandbox (see python-sandbox.test.ts), so
      // calling standard deviation unavailable understates the tool.
      const prompt = loadAgentPrompt('scientist');
      expect(prompt).toContain('variance ** 0.5');
      expect(prompt).not.toMatch(
        /standard deviations?[^.]{0,120}(require|blocked|unavailable|cannot)/i,
      );
      expect(prompt).not.toMatch(
        /(require|blocked|unavailable|cannot)[^.]{0,120}standard deviations?/i,
      );
    });

  });

  describe('serialized inputSchema surfaces', () => {
    // Both real serializers: the standalone MCP ListTools payload and the
    // Agent SDK tool format. Either one is what a client actually reads.
    const schemas: [string, { properties: Record<string, unknown> }][] = [
      [
        'standalone ListTools inputSchema',
        (() => {
          const { tools } = buildListToolsResponse('');
          const python = tools.find((t) => t.name === 'python_repl');
          if (!python) throw new Error('python_repl missing from standalone ListTools surface');
          return python.inputSchema;
        })(),
      ],
      [
        'Agent SDK toSdkToolFormat inputSchema',
        toSdkToolFormat(pythonReplToolIndex as unknown as GenericToolDefinition).inputSchema,
      ],
    ];

    for (const [name, schema] of schemas) {
      it(`${name} serves parameter descriptions, so schema text is user-facing guidance`, () => {
        const label = schema.properties.executionLabel as { description?: string };
        expect(label?.description).toContain('Human-readable label');
      });

      it(`${name} does not illustrate parameters with workflows the sandbox blocks`, () => {
        const lower = JSON.stringify(schema).toLowerCase();
        for (const term of [
          ...allToolTerms,
          'load dataset',
          'train model',
          'generate plot',
          'save figure',
        ]) {
          expect(lower, `${name} must not contain "${term}"`).not.toContain(term);
        }
      });
    }
  });

  describe('repo documentation surfaces', () => {
    const readDoc = (relative: string) =>
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');

    // Only the python_repl / scientist guidance inside each document is under
    // this contract; unrelated sections may legitimately mention other tools'
    // libraries or APIs.
    const docSurfaces: [string, string, string[]][] = [
      [
        'src/agents/AGENTS.md',
        extractPythonGuidance(readDoc('../../../agents/AGENTS.md')),
        ['ml/hypothesis', ...THIRD_PARTY_LIBRARIES],
      ],
      [
        'docs/shared/agent-tiers.md',
        extractPythonGuidance(readDoc('../../../../docs/shared/agent-tiers.md')),
        ['ml/hypothesis', ...THIRD_PARTY_LIBRARIES],
      ],
      [
        'docs/TOOLS.md',
        extractPythonGuidance(readDoc('../../../../docs/TOOLS.md')),
        [...THIRD_PARTY_LIBRARIES, ...FILE_IO_DIRECTIVES, 'dataframe', 'plt.'],
      ],
      [
        'docs/REFERENCE.md',
        extractPythonGuidance(readDoc('../../../../docs/REFERENCE.md')),
        ['ml/hypothesis', ...THIRD_PARTY_LIBRARIES],
      ],
    ];

    for (const [name, guidance, terms] of docSurfaces) {
      it(`${name} exposes python_repl/scientist guidance to check`, () => {
        expect(guidance.toLowerCase()).toMatch(/python_repl|scientist/);
      });

      it(`${name} python_repl/scientist guidance does not advertise blocked libraries or directives`, () => {
        const lower = guidance.toLowerCase();
        for (const term of terms) {
          expect(lower, `${name} guidance must not contain "${term}"`).not.toContain(term);
        }
      });
    }

    it('docs/TOOLS.md guidance keeps the whole Python REPL section, examples included', () => {
      const guidance = extractPythonGuidance(readDoc('../../../../docs/TOOLS.md'));
      expect(guidance).toContain('## Python REPL');
      expect(guidance).toContain('### Features');
      expect(guidance.toLowerCase()).toContain('imports, file i/o, and dynamic code execution are blocked');
      // Neighbouring tool sections stay out of scope.
      expect(guidance).not.toContain('## Session Search');
      expect(guidance).not.toContain('shared_memory_write');
    });

    it('docs/REFERENCE.md guidance keeps scientist rows without unrelated agent rows', () => {
      const guidance = extractPythonGuidance(readDoc('../../../../docs/REFERENCE.md'));
      expect(guidance).toContain('`scientist-high`');
      expect(guidance).not.toContain('`git-master`');
    });
  });
});

describe('extractPythonGuidance', () => {
  const doc = [
    '# Doc',
    '',
    '## Data Frames Tool',
    '',
    'Reads spreadsheets with pandas.read_excel and writes to_csv output.',
    '',
    '```python',
    'df = pandas.read_csv("a.csv")',
    '```',
    '',
    '## Python REPL',
    '',
    'Sandboxed: imports are blocked.',
    '',
    '### Features',
    '',
    '```python',
    'python_repl(code="print(sum(data) / len(data))")',
    '```',
    '',
    '## Agents',
    '',
    '| Agent | Tools |',
    '| --- | --- |',
    '| scientist | python_repl |',
    '| notebook-runner | pandas, matplotlib |',
    '',
  ].join('\n');

  const guidance = extractPythonGuidance(doc);

  it('keeps a relevant section including nested subsections and code blocks', () => {
    expect(guidance).toContain('## Python REPL');
    expect(guidance).toContain('Sandboxed: imports are blocked.');
    expect(guidance).toContain('### Features');
    expect(guidance).toContain('python_repl(code="print(sum(data) / len(data))")');
  });

  it('drops unrelated sections and their code blocks', () => {
    expect(guidance).not.toContain('## Data Frames Tool');
    expect(guidance).not.toContain('read_excel');
    expect(guidance).not.toContain('pandas.read_csv');
  });

  it('keeps only the relevant rows of an unrelated section table', () => {
    expect(guidance).toContain('| scientist | python_repl |');
    expect(guidance).not.toContain('notebook-runner');
  });

  it('flags a blocked-library claim inside the relevant section', () => {
    const polluted = doc.replace(
      'Sandboxed: imports are blocked.',
      'Sandboxed: use pandas dataframes for analysis.',
    );
    expect(extractPythonGuidance(polluted).toLowerCase()).toContain('pandas');
  });
});
