/**
 * Tests for Project Memory Formatter
 */

import { describe, it, expect } from 'vitest';
import { formatContextSummary, formatFullContext } from '../formatter.js';
import { ProjectMemory } from '../types.js';
import { SCHEMA_VERSION } from '../constants.js';

// Helper to create base memory with all required fields
const createBaseMemory = (overrides: Partial<ProjectMemory> = {}): ProjectMemory => ({
  version: SCHEMA_VERSION,
  lastScanned: Date.now(),
  projectRoot: '/test',
  techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
  build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
  conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
  structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
  customNotes: [],
  directoryMap: {},
  hotPaths: [],
  userDirectives: [],
  ...overrides,
});

describe('Project Memory Formatter', () => {
  describe('formatContextSummary', () => {
    it('should format TypeScript/React project summary', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [
            { name: 'TypeScript', version: '5.0.0', confidence: 'high', markers: ['tsconfig.json'] },
          ],
          frameworks: [
            { name: 'react', version: '18.2.0', category: 'frontend' },
            { name: 'vite', version: '5.0.0', category: 'build' },
          ],
          packageManager: 'pnpm',
          runtime: 'Node.js 20.0.0',
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      const summary = formatContextSummary(memory);

      expect(summary).toContain('TypeScript');
      expect(summary).toContain('react');
      expect(summary).toContain('pnpm');
      expect(summary).toContain('Build: pnpm build');
      expect(summary).toContain('Test: pnpm test');
      expect(summary.length).toBeLessThan(300);
    });

    it('should prioritize fullstack frameworks over frontend', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [{ name: 'TypeScript', version: null, confidence: 'high', markers: ['tsconfig.json'] }],
          frameworks: [
            { name: 'react', version: '18.2.0', category: 'frontend' },
            { name: 'next', version: '14.0.0', category: 'fullstack' },
          ],
          packageManager: 'npm',
          runtime: null,
        },
        build: {
          buildCommand: 'npm run build',
          testCommand: null,
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      const summary = formatContextSummary(memory);

      expect(summary).toContain('next');
      expect(summary).not.toContain('react');
    });

    it('should handle minimal project with no frameworks', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [{ name: 'Rust', version: null, confidence: 'high', markers: ['Cargo.toml'] }],
          frameworks: [],
          packageManager: 'cargo',
          runtime: null,
        },
        build: {
          buildCommand: 'cargo build',
          testCommand: 'cargo test',
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      const summary = formatContextSummary(memory);

      expect(summary).toContain('Rust');
      expect(summary).toContain('cargo');
      expect(summary).toContain('Build: cargo build');
    });

    it('should truncate long summaries', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [{ name: 'TypeScript', version: '5.0.0', confidence: 'high', markers: ['tsconfig.json'] }],
          frameworks: [
            { name: 'react', version: '18.2.0', category: 'frontend' },
            { name: 'vite', version: '5.0.0', category: 'build' },
            { name: 'vitest', version: '1.0.0', category: 'testing' },
          ],
          packageManager: 'pnpm',
          runtime: 'Node.js 20.0.0',
        },
        build: {
          buildCommand: 'pnpm build --mode production --minify',
          testCommand: 'pnpm test --coverage --verbose',
          lintCommand: 'pnpm lint --fix',
          devCommand: 'pnpm dev --host 0.0.0.0',
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      const summary = formatContextSummary(memory);

      expect(summary.length).toBeLessThan(300);
      expect(summary).toContain('[Project Environment]');
    });
  });

  describe('formatFullContext', () => {
    it('should format complete project details', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [
            { name: 'TypeScript', version: '5.0.0', confidence: 'high', markers: ['tsconfig.json'] },
          ],
          frameworks: [
            { name: 'react', version: '18.2.0', category: 'frontend' },
          ],
          packageManager: 'pnpm',
          runtime: 'Node.js 20.0.0',
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          lintCommand: 'pnpm lint',
          devCommand: 'pnpm dev',
          scripts: {},
        },
        conventions: {
          namingStyle: 'camelCase',
          importStyle: 'ES modules',
          testPattern: '*.test.ts',
          fileOrganization: 'feature-based',
        },
        structure: {
          isMonorepo: true,
          workspaces: ['packages/*'],
          mainDirectories: ['src', 'tests'],
          gitBranches: { defaultBranch: 'main', branchingStrategy: null },
        },
        customNotes: [
          { timestamp: Date.now(), source: 'learned', category: 'env', content: 'Requires NODE_ENV' },
        ],
      });

      const full = formatFullContext(memory);

      expect(full).toContain('<project-memory>');
      expect(full).toContain('## Project Environment');
      expect(full).toContain('**Languages:**');
      expect(full).toContain('TypeScript (5.0.0)');
      expect(full).toContain('**Frameworks:**');
      expect(full).toContain('react (18.2.0) [frontend]');
      expect(full).toContain('**Commands:**');
      expect(full).toContain('Build: `pnpm build`');
      expect(full).toContain('**Code Style:** camelCase');
      expect(full).toContain('**Structure:** Monorepo');
      expect(full).toContain('**Custom Notes:**');
      expect(full).toContain('[env] Requires NODE_ENV');
      expect(full).toContain('</project-memory>');
    });

    it('should handle empty sections gracefully', () => {
      const memory = createBaseMemory({
        techStack: {
          languages: [],
          frameworks: [],
          packageManager: null,
          runtime: null,
        },
        build: {
          buildCommand: null,
          testCommand: null,
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      const full = formatFullContext(memory);

      expect(full).toContain('<project-memory>');
      expect(full).not.toContain('**Languages:**');
      expect(full).not.toContain('**Frameworks:**');
      expect(full).not.toContain('**Commands:**');
    });
  });
});
