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
