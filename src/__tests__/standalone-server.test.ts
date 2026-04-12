import { describe, it, expect } from 'vitest';
import { lspTools } from '../tools/lsp-tools.js';
import { astTools } from '../tools/ast-tools.js';
import { pythonReplTool } from '../tools/python-repl/tool.js';
import { stateTools } from '../tools/state-tools.js';
import { notepadTools } from '../tools/notepad-tools.js';
import { memoryTools } from '../tools/memory-tools.js';
import { traceTools } from '../tools/trace-tools.js';
import { sharedMemoryTools } from '../tools/shared-memory-tools.js';
import { deepinitManifestTool } from '../tools/deepinit-manifest.js';
import { wikiTools } from '../tools/wiki-tools.js';
import { skillsTools } from '../tools/skills-tools.js';

describe('standalone-server tool composition', () => {
  // These are the raw tool arrays aggregated by tool-registry.ts into allTools.
  // This test validates per-array counts; for the live MCP surface use standalone-listtools.test.ts.

  const expectedTools = [
    ...lspTools,
    ...astTools,
    pythonReplTool,
    ...stateTools,
    ...notepadTools,
    ...memoryTools,
    ...traceTools,
    ...sharedMemoryTools,
    deepinitManifestTool,
    ...wikiTools,
    ...skillsTools,
  ];

  it('should have at least the expected total tool count', () => {
    // 12 LSP + 2 AST + 1 python + 5 state + 6 notepad + 4 memory + 3 trace
    // + 5 shared_memory + 1 deepinit + 7 wiki + 3 skills = 49 baseline.
    // Use ≥ so this guard doesn't break when new tools are legitimately added.
    expect(expectedTools.length).toBeGreaterThanOrEqual(49);
  });

  it('should include 3 trace tools', () => {
    expect(traceTools).toHaveLength(3);
  });

  it('should include trace_timeline tool', () => {
    const names = traceTools.map(t => t.name);
    expect(names).toContain('trace_timeline');
  });

  it('should include trace_summary tool', () => {
    const names = traceTools.map(t => t.name);
    expect(names).toContain('trace_summary');
  });

  it('should include session_search tool', () => {
    const names = traceTools.map(t => t.name);
    expect(names).toContain('session_search');
  });

  it('should include 7 wiki tools', () => {
    expect(wikiTools).toHaveLength(7);
  });

  it('should include wiki_ingest tool', () => {
    const names = wikiTools.map(t => t.name);
    expect(names).toContain('wiki_ingest');
  });

  it('should include wiki_query tool', () => {
    const names = wikiTools.map(t => t.name);
    expect(names).toContain('wiki_query');
  });

  it('should include 5 shared_memory tools', () => {
    expect(sharedMemoryTools).toHaveLength(5);
  });

  it('should include shared_memory_write tool', () => {
    const names = sharedMemoryTools.map(t => t.name);
    expect(names).toContain('shared_memory_write');
  });

  it('should include shared_memory_read tool', () => {
    const names = sharedMemoryTools.map(t => t.name);
    expect(names).toContain('shared_memory_read');
  });

  it('should include 3 skills tools', () => {
    expect(skillsTools).toHaveLength(3);
  });

  it('should include load_omc_skills_local tool', () => {
    const names = skillsTools.map(t => t.name);
    expect(names).toContain('load_omc_skills_local');
  });

  it('should include list_omc_skills tool', () => {
    const names = skillsTools.map(t => t.name);
    expect(names).toContain('list_omc_skills');
  });

  it('should include deepinit_manifest tool', () => {
    expect(deepinitManifestTool.name).toBe('deepinit_manifest');
  });

  it('should have no duplicate tool names', () => {
    const names = expectedTools.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tools should have required properties', () => {
    for (const tool of expectedTools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('schema');
      expect(tool).toHaveProperty('handler');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.handler).toBe('function');
    }
  });
});
