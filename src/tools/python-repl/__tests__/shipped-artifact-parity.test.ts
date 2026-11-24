import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { pythonReplSchema } from '../tool.js';
import { PYTHON_REPL_SANDBOX_BOUNDARY } from '../sandbox.js';

// A git/plugin install runs the COMMITTED artifacts, not src/: `.mcp.json`
// starts bridge/mcp-server.cjs and the CLI ships bridge/cli.cjs plus the dist
// modules. Those artifacts kept advertising pandas/numpy/matplotlib long after
// src stopped (issue #3682), so this gate binds each committed runtime artifact
// to the current source guidance and fails when one goes stale.

const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf-8');

// Contiguous fragments of the canonical source strings. Bundlers concatenate the
// source's split literals, so these fragments survive every build shape.
const BOUNDARY_FRAGMENT = PYTHON_REPL_SANDBOX_BOUNDARY.split('; ')[0]!;
const LABEL_EXAMPLES_FRAGMENT = (() => {
  const description = pythonReplSchema.shape.executionLabel.description;
  if (!description) throw new Error('executionLabel lost its description');
  const [, examples] = description.split('Examples: ');
  if (!examples) throw new Error('executionLabel description lost its examples');
  return examples;
})();

const FORBIDDEN = [
  'scientific computing with pandas',
  'Load dataset',
  'Train model',
  'Generate plot',
  'pip install pandas',
];

// Artifacts that carry the tool schema text. The bundles inline the boundary
// constant; the dist module keeps importing it from dist/.../sandbox.js, which
// is gated separately below.
const PYTHON_REPL_ARTIFACTS = [
  'bridge/mcp-server.cjs',
  'bridge/cli.cjs',
  'dist/tools/python-repl/tool.js',
];

const BOUNDARY_BEARING_ARTIFACTS = [
  'bridge/mcp-server.cjs',
  'bridge/cli.cjs',
  'dist/tools/python-repl/sandbox.js',
];

describe('committed shipping-surface parity (#3682)', () => {
  it('.mcp.json loads the gated bridge server', () => {
    const mcpConfig = JSON.parse(repoFile('.mcp.json')) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    const args = Object.values(mcpConfig.mcpServers).flatMap((server) => server.args ?? []);
    expect(args.some((arg) => arg.endsWith('/bridge/mcp-server.cjs'))).toBe(true);
  });

  for (const artifact of PYTHON_REPL_ARTIFACTS) {
    it(`${artifact} ships the current executionLabel examples`, () => {
      expect(repoFile(artifact), `${artifact} is stale: rebuild it`).toContain(
        LABEL_EXAMPLES_FRAGMENT,
      );
    });

    it(`${artifact} no longer advertises blocked libraries or workflows`, () => {
      const content = repoFile(artifact);
      for (const phrase of FORBIDDEN) {
        expect(content, `${artifact} must not contain "${phrase}"`).not.toContain(phrase);
      }
    });
  }

  it('dist/agents/scientist.js ships sandbox-truthful agent metadata', () => {
    const content = repoFile('dist/agents/scientist.js').toLowerCase();
    expect(content).toContain('sandbox');
    for (const phrase of ['ml/hypothesis', 'pandas', 'numpy', 'matplotlib', 'scipy']) {
      expect(content, `dist/agents/scientist.js must not contain "${phrase}"`).not.toContain(
        phrase,
      );
    }
  });

  for (const artifact of BOUNDARY_BEARING_ARTIFACTS) {
    it(`${artifact} ships the canonical sandbox boundary`, () => {
      expect(repoFile(artifact), `${artifact} is stale: rebuild it`).toContain(BOUNDARY_FRAGMENT);
    });
  }
});
