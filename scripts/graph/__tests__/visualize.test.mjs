import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderAsciiGraph, renderHeader, topologicalOrder } from '../visualize.mjs';

const descriptorPath = fileURLToPath(
  new URL('../../../examples/graph/auth-feature-descriptor.json', import.meta.url),
);
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));

describe('topologicalOrder', () => {
  it('orders nodes by DFS, excluding back-edges', () => {
    expect(topologicalOrder(descriptor)).toEqual(['explore', 'plan', 'implement', 'test']);
  });
});

describe('renderAsciiGraph', () => {
  const nodeStatus = new Map([
    ['explore', 'completed'],
    ['plan', 'completed'],
    ['implement', 'running'],
    ['test', 'ready'],
  ]);
  const output = renderAsciiGraph(descriptor, nodeStatus, 'running');

  it('renders every node id and title', () => {
    expect(output).toContain('explore');
    expect(output).toContain('Codebase Exploration');
    expect(output).toContain('plan');
    expect(output).toContain('Implementation Plan');
    expect(output).toContain('implement');
    expect(output).toContain('Implementation');
    expect(output).toContain('test');
    expect(output).toContain('Test & Verify');
  });

  it('uses box-drawing chars and downward arrows', () => {
    expect(output).toContain('┌');
    expect(output).toContain('└');
    expect(output).toContain('│');
    expect(output).toContain('▼');
  });

  it('marks each status with its emoji', () => {
    expect(output).toContain('✅');
    expect(output).toContain('▶️');
    expect(output).toContain('⏳');
  });

  it('renders a top progress line listing completed nodes', () => {
    expect(output).toContain('Progress: 2/4 done');
    expect(output).toContain('[explore✅]');
    expect(output).toContain('[plan✅]');
    expect(output).toContain('implement▶️');
    expect(output).toContain('test⏳');
  });

  it('labels the conditional edge route', () => {
    expect(output).toContain('done');
  });

  it('renders the back-edge as a labeled side-note', () => {
    expect(output).toContain('retry');
    expect(output).toContain('max 3');
    expect(output).toContain('-> implement');
  });

  it('does not emit mermaid', () => {
    expect(output).not.toContain('mermaid');
    expect(output).not.toContain('flowchart');
    expect(output).not.toContain('classDef');
  });
});

describe('renderHeader', () => {
  const state = {
    status: 'running',
    active_revision_id: 'rev-1',
    active_revision_hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    revisions: { 'rev-1': { descriptor } },
  };
  const output = renderHeader(state, descriptor);

  it('includes goal, run status, hash, entry, terminal, concurrency', () => {
    expect(output).toContain('Goal:');
    expect(output).toContain('Run: running');
    expect(output).toContain('#a1b2c3d4');
    expect(output).toContain('Entry: explore');
    expect(output).toContain('Terminal: test');
    expect(output).toContain('Concurrency: 1');
  });
});

describe('terminal-control sanitization', () => {
  // Newlines are renderer-owned line separators; reject all controls that can
  // originate in a hostile descriptor or state value.
  const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
  const hostileDescriptor = {
    goal: 'ship\x1b]8;;https://example.invalid\x07click\x1b]8;;\x07',
    entry_node_ids: ['entry\x9b2J'],
    terminal_verification_node_id: 'verify\x1b[2J',
    concurrency_limit: '1\x1b[?25l',
    nodes: [
      { id: 'entry\x1b[2J', title: 'Title\x1b]52;c;payload\x07', kind: 'agent' },
      { id: 'verify\x9b2J', title: 'Verify\x00done\x1b]0;unterminated', kind: 'agent' },
    ],
    edges: [
      { from: 'entry\x1b[2J', to: 'verify\x9b2J', route: 'route\x1b]0;owned\x07' },
      { from: 'verify\x9b2J', to: 'entry\x1b[2J', kind: 'back_edge', route: 'retry\x1b[31m' },
    ],
  };

  it('removes C0/C1, CSI, and OSC controls from graph output', () => {
    const graph = renderAsciiGraph(
      hostileDescriptor,
      new Map([['entry\x1b[2J', 'running\x1b[31m']]),
      'running\x1b]0;owned\x07',
    );
    const header = renderHeader({ active_revision_hash: 'deadbeef\x1b[2J', status: 'running\x9b2J' }, hostileDescriptor);

    expect(graph).not.toMatch(controls);
    expect(header).not.toMatch(controls);
    expect(graph).toContain('entry');
    expect(graph).toContain('route');
    expect(graph).not.toContain('owned');
    expect(graph).not.toContain('unterminated');
    expect(header).toContain('Goal: shipclick');
  });
});
