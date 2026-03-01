import { describe, it, expect } from 'vitest';
import { deepMerge, mergeProjectMemory } from '../lib/project-memory-merge.js';
import type { ProjectMemory } from '../hooks/project-memory/types.js';

// ---------------------------------------------------------------------------
// Helper: minimal valid ProjectMemory for tests
// ---------------------------------------------------------------------------

function makeMemory(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    version: '1.0.0',
    lastScanned: 1000,
    projectRoot: '/test',
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
    directoryMap: {},
    hotPaths: [],
    userDirectives: [],
    ...overrides,
  };
}

// ===========================================================================
// deepMerge - generic
// ===========================================================================

describe('deepMerge', () => {
  it('should add new keys from incoming', () => {
    const base = { a: 1 };
    const incoming = { b: 2 };
    expect(deepMerge(base, incoming)).toEqual({ a: 1, b: 2 });
  });

  it('should override scalar values with incoming', () => {
    const base = { a: 1, b: 'old' };
    const incoming = { b: 'new' };
    expect(deepMerge(base, incoming)).toEqual({ a: 1, b: 'new' });
  });

  it('should deep-merge nested objects', () => {
    const base = { nested: { x: 1, y: 2 } };
    const incoming = { nested: { y: 3, z: 4 } };
    expect(deepMerge(base, incoming)).toEqual({ nested: { x: 1, y: 3, z: 4 } });
  });

  it('should not mutate base or incoming', () => {
    const base = { nested: { x: 1 } };
    const incoming = { nested: { y: 2 } };
    const baseCopy = JSON.parse(JSON.stringify(base));
    const incomingCopy = JSON.parse(JSON.stringify(incoming));

    deepMerge(base, incoming);

    expect(base).toEqual(baseCopy);
    expect(incoming).toEqual(incomingCopy);
  });

  it('should handle null incoming values (intentional clear)', () => {
    const base = { a: 1, b: 'keep' };
    const incoming = { a: null };
    expect(deepMerge(base, incoming as any)).toEqual({ a: null, b: 'keep' });
  });

  it('should handle type mismatch (object vs scalar) with incoming winning', () => {
    const base = { a: { nested: true } };
    const incoming = { a: 'replaced' };
    expect(deepMerge(base, incoming as any)).toEqual({ a: 'replaced' });
  });

  it('should merge scalar arrays by union', () => {
    const base = { workspaces: ['pkg-a', 'pkg-b'] };
    const incoming = { workspaces: ['pkg-b', 'pkg-c'] };
    expect(deepMerge(base, incoming)).toEqual({
      workspaces: ['pkg-a', 'pkg-b', 'pkg-c'],
    });
  });
});

// ===========================================================================
// mergeProjectMemory - field-specific strategies
// ===========================================================================

describe('mergeProjectMemory', () => {
  it('should preserve base fields not present in incoming', () => {
    const base = makeMemory({
      techStack: {
        languages: [{ name: 'TypeScript', version: '5.0', confidence: 'high', markers: ['tsconfig.json'] }],
        frameworks: [],
        packageManager: 'pnpm',
        runtime: 'node',
      },
    });

    const incoming: Partial<ProjectMemory> = {
      build: {
        buildCommand: 'pnpm build',
        testCommand: 'pnpm test',
        lintCommand: null,
        devCommand: null,
        scripts: {},
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    // techStack preserved from base
    expect(merged.techStack.packageManager).toBe('pnpm');
    expect(merged.techStack.languages).toHaveLength(1);
    expect(merged.techStack.languages[0].name).toBe('TypeScript');

    // build updated from incoming
    expect(merged.build.buildCommand).toBe('pnpm build');
    expect(merged.build.testCommand).toBe('pnpm test');
  });

  it('should deep-merge nested techStack without losing existing languages', () => {
    const base = makeMemory({
      techStack: {
        languages: [{ name: 'TypeScript', version: '5.0', confidence: 'high', markers: ['tsconfig.json'] }],
        frameworks: [{ name: 'vitest', version: '1.0', category: 'testing' }],
        packageManager: 'pnpm',
        runtime: 'node',
      },
    });

    const incoming: Partial<ProjectMemory> = {
      techStack: {
        languages: [
          { name: 'TypeScript', version: '5.3', confidence: 'high', markers: ['tsconfig.json'] },
          { name: 'JavaScript', version: null, confidence: 'medium', markers: ['*.js'] },
        ],
        frameworks: [{ name: 'vitest', version: '2.0', category: 'testing' }],
        packageManager: 'pnpm',
        runtime: 'node',
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    // TypeScript updated to incoming version, JavaScript added
    expect(merged.techStack.languages).toHaveLength(2);
    expect(merged.techStack.languages.find(l => l.name === 'TypeScript')?.version).toBe('5.3');
    expect(merged.techStack.languages.find(l => l.name === 'JavaScript')).toBeDefined();

    // vitest updated
    expect(merged.techStack.frameworks).toHaveLength(1);
    expect(merged.techStack.frameworks[0].version).toBe('2.0');
  });

  it('should deduplicate customNotes by category+content, keeping newer', () => {
    const base = makeMemory({
      customNotes: [
        { timestamp: 1000, source: 'learned', category: 'runtime', content: 'Node.js v18' },
        { timestamp: 1000, source: 'manual', category: 'build', content: 'Use pnpm' },
      ],
    });

    const incoming: Partial<ProjectMemory> = {
      customNotes: [
        { timestamp: 2000, source: 'learned', category: 'runtime', content: 'Node.js v18' },
        { timestamp: 2000, source: 'learned', category: 'env', content: 'Requires CI=true' },
      ],
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.customNotes).toHaveLength(3);

    const nodeNote = merged.customNotes.find(n => n.content === 'Node.js v18');
    expect(nodeNote?.timestamp).toBe(2000);

    expect(merged.customNotes.find(n => n.content === 'Use pnpm')).toBeDefined();
    expect(merged.customNotes.find(n => n.content === 'Requires CI=true')).toBeDefined();
  });

  it('should deduplicate userDirectives by directive text, keeping newer', () => {
    const base = makeMemory({
      userDirectives: [
        { timestamp: 1000, directive: 'Always use strict mode', context: '', source: 'explicit', priority: 'high' },
        { timestamp: 1000, directive: 'Use bun', context: '', source: 'explicit', priority: 'normal' },
      ],
    });

    const incoming: Partial<ProjectMemory> = {
      userDirectives: [
        { timestamp: 2000, directive: 'Use bun', context: 'for speed', source: 'explicit', priority: 'high' },
        { timestamp: 2000, directive: 'Never auto-commit', context: '', source: 'explicit', priority: 'normal' },
      ],
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.userDirectives).toHaveLength(3);

    const bunDirective = merged.userDirectives.find(d => d.directive === 'Use bun');
    expect(bunDirective?.timestamp).toBe(2000);
    expect(bunDirective?.priority).toBe('high');
    expect(bunDirective?.context).toBe('for speed');

    expect(merged.userDirectives.find(d => d.directive === 'Never auto-commit')).toBeDefined();
  });

  it('should merge hotPaths by path, taking max accessCount and lastAccessed', () => {
    const base = makeMemory({
      hotPaths: [
        { path: 'src/index.ts', accessCount: 5, lastAccessed: 1000, type: 'file' },
        { path: 'src/lib/', accessCount: 3, lastAccessed: 900, type: 'directory' },
      ],
    });

    const incoming: Partial<ProjectMemory> = {
      hotPaths: [
        { path: 'src/index.ts', accessCount: 8, lastAccessed: 2000, type: 'file' },
        { path: 'src/utils.ts', accessCount: 2, lastAccessed: 1500, type: 'file' },
      ],
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.hotPaths).toHaveLength(3);

    const indexPath = merged.hotPaths.find(hp => hp.path === 'src/index.ts');
    expect(indexPath?.accessCount).toBe(8);
    expect(indexPath?.lastAccessed).toBe(2000);

    expect(merged.hotPaths.find(hp => hp.path === 'src/lib/')).toBeDefined();
    expect(merged.hotPaths.find(hp => hp.path === 'src/utils.ts')).toBeDefined();
  });

  it('should merge directoryMap objects', () => {
    const base = makeMemory({
      directoryMap: {
        'src': { path: 'src', purpose: 'source', fileCount: 10, lastAccessed: 1000, keyFiles: ['index.ts'] },
      },
    });

    const incoming: Partial<ProjectMemory> = {
      directoryMap: {
        'src': { path: 'src', purpose: 'source code', fileCount: 12, lastAccessed: 2000, keyFiles: ['index.ts', 'main.ts'] },
        'tests': { path: 'tests', purpose: 'test files', fileCount: 5, lastAccessed: 2000, keyFiles: ['setup.ts'] },
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.directoryMap['src'].fileCount).toBe(12);
    expect(merged.directoryMap['src'].purpose).toBe('source code');
    expect(merged.directoryMap['src'].keyFiles).toEqual(['index.ts', 'main.ts']);

    expect(merged.directoryMap['tests']).toBeDefined();
    expect(merged.directoryMap['tests'].fileCount).toBe(5);
  });

  it('should merge build.scripts object field-by-field', () => {
    const base = makeMemory({
      build: {
        buildCommand: 'pnpm build',
        testCommand: 'pnpm test',
        lintCommand: null,
        devCommand: null,
        scripts: { build: 'tsc', test: 'vitest' },
      },
    });

    const incoming: Partial<ProjectMemory> = {
      build: {
        buildCommand: 'pnpm build',
        testCommand: 'pnpm test',
        lintCommand: 'eslint src',
        devCommand: null,
        scripts: { test: 'vitest run', lint: 'eslint src' },
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.build.lintCommand).toBe('eslint src');
    expect(merged.build.scripts.build).toBe('tsc');
    expect(merged.build.scripts.test).toBe('vitest run');
    expect(merged.build.scripts.lint).toBe('eslint src');
  });

  it('should merge workspaces and mainDirectories as scalar arrays', () => {
    const base = makeMemory({
      structure: {
        isMonorepo: true,
        workspaces: ['packages/a', 'packages/b'],
        mainDirectories: ['src', 'lib'],
        gitBranches: { defaultBranch: 'main', branchingStrategy: null },
      },
    });

    const incoming: Partial<ProjectMemory> = {
      structure: {
        isMonorepo: true,
        workspaces: ['packages/b', 'packages/c'],
        mainDirectories: ['src', 'tests'],
        gitBranches: { defaultBranch: 'main', branchingStrategy: null },
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    expect(merged.structure.workspaces).toEqual(['packages/a', 'packages/b', 'packages/c']);
    expect(merged.structure.mainDirectories).toEqual(['src', 'lib', 'tests']);
  });

  it('should use incoming lastScanned when provided', () => {
    const base = makeMemory({ lastScanned: 1000 });
    const incoming: Partial<ProjectMemory> = { lastScanned: 2000 };

    const merged = mergeProjectMemory(base, incoming);
    expect(merged.lastScanned).toBe(2000);
  });

  it('should keep base lastScanned when incoming omits it', () => {
    const base = makeMemory({ lastScanned: 1000 });
    const incoming: Partial<ProjectMemory> = {
      build: {
        buildCommand: 'npm run build',
        testCommand: null,
        lintCommand: null,
        devCommand: null,
        scripts: {},
      },
    };

    const merged = mergeProjectMemory(base, incoming);
    expect(merged.lastScanned).toBe(1000);
  });

  it('should handle empty incoming gracefully (return base)', () => {
    const base = makeMemory({
      techStack: {
        languages: [{ name: 'Go', version: '1.21', confidence: 'high', markers: ['go.mod'] }],
        frameworks: [],
        packageManager: 'go',
        runtime: null,
      },
    });

    const merged = mergeProjectMemory(base, {});

    expect(merged).toEqual(base);
  });

  // Regression: the old shallow spread would lose techStack.languages
  // when incoming only updated build info
  it('regression: partial update should not wipe unrelated nested fields', () => {
    const base = makeMemory({
      techStack: {
        languages: [{ name: 'Python', version: '3.11', confidence: 'high', markers: ['pyproject.toml'] }],
        frameworks: [{ name: 'fastapi', version: '0.100', category: 'backend' }],
        packageManager: 'poetry',
        runtime: 'python',
      },
      customNotes: [
        { timestamp: 1000, source: 'manual', category: 'deploy', content: 'Use Docker' },
      ],
      userDirectives: [
        { timestamp: 1000, directive: 'Use black formatter', context: '', source: 'explicit', priority: 'normal' },
      ],
    });

    const incoming: Partial<ProjectMemory> = {
      build: {
        buildCommand: 'poetry build',
        testCommand: 'pytest',
        lintCommand: 'ruff check .',
        devCommand: 'uvicorn main:app --reload',
        scripts: {},
      },
    };

    const merged = mergeProjectMemory(base, incoming);

    // These must all survive
    expect(merged.techStack.languages).toHaveLength(1);
    expect(merged.techStack.languages[0].name).toBe('Python');
    expect(merged.techStack.frameworks).toHaveLength(1);
    expect(merged.customNotes).toHaveLength(1);
    expect(merged.userDirectives).toHaveLength(1);

    // Build updated
    expect(merged.build.buildCommand).toBe('poetry build');
    expect(merged.build.lintCommand).toBe('ruff check .');
  });
});
