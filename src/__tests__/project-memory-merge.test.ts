import { describe, it, expect } from 'vitest';
import { deepMerge, mergeProjectMemory } from '../lib/project-memory-merge.js';
import type { ProjectMemory } from '../hooks/project-memory/types.js';

// ---------------------------------------------------------------------------
// Helper: minimal valid ProjectMemory
// ---------------------------------------------------------------------------

function baseMemory(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    version: '1.0.0',
    lastScanned: 1000,
    projectRoot: '/project',
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
// deepMerge generic tests
// ===========================================================================

describe('deepMerge', () => {
  it('should merge flat objects without loss', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should recursively merge nested objects', () => {
    const base = { nested: { x: 1, y: 2 } };
    const incoming = { nested: { y: 3, z: 4 } };
    const result = deepMerge(base, incoming);
    expect(result).toEqual({ nested: { x: 1, y: 3, z: 4 } });
  });

  it('should not mutate inputs', () => {
    const base = { a: 1, nested: { x: 10 } };
    const incoming = { nested: { y: 20 } };
    const baseCopy = JSON.parse(JSON.stringify(base));
    const incomingCopy = JSON.parse(JSON.stringify(incoming));

    deepMerge(base, incoming);

    expect(base).toEqual(baseCopy);
    expect(incoming).toEqual(incomingCopy);
  });

  it('should handle incoming null (intentional clear)', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: null as unknown as number });
    expect(result).toEqual({ a: 1, b: null });
  });

  it('should handle incoming undefined', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: undefined as unknown as number });
    expect(result).toEqual({ a: 1, b: undefined });
  });

  it('should handle type mismatch (incoming wins)', () => {
    const result = deepMerge(
      { a: { nested: true } } as Record<string, unknown>,
      { a: 'scalar' },
    );
    expect(result).toEqual({ a: 'scalar' });
  });

  it('should merge scalar arrays by union', () => {
    const result = deepMerge(
      { items: [1, 2, 3] } as Record<string, unknown>,
      { items: [3, 4, 5] },
    );
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
  });
});

// ===========================================================================
// mergeProjectMemory
// ===========================================================================

describe('mergeProjectMemory', () => {
  // -------------------------------------------------------------------------
  // Scalar / metadata fields
  // -------------------------------------------------------------------------

  it('should preserve base fields not present in incoming', () => {
    const existing = baseMemory({
      conventions: { namingStyle: 'camelCase', importStyle: 'esm', testPattern: null, fileOrganization: null },
    });
    const incoming: Partial<ProjectMemory> = {
      conventions: { namingStyle: 'snake_case', importStyle: null, testPattern: null, fileOrganization: null },
    };

    const merged = mergeProjectMemory(existing, incoming);
    // incoming explicitly set importStyle to null, so it should be null
    expect(merged.conventions.namingStyle).toBe('snake_case');
    expect(merged.conventions.importStyle).toBeNull();
  });

  it('should take incoming lastScanned', () => {
    const existing = baseMemory({ lastScanned: 1000 });
    const merged = mergeProjectMemory(existing, { lastScanned: 2000 });
    expect(merged.lastScanned).toBe(2000);
  });

  it('should keep existing lastScanned when incoming omits it', () => {
    const existing = baseMemory({ lastScanned: 1000 });
    const merged = mergeProjectMemory(existing, { version: '2.0.0' });
    expect(merged.lastScanned).toBe(1000);
  });

  // -------------------------------------------------------------------------
  // Nested object merge (techStack, build, etc.)
  // -------------------------------------------------------------------------

  it('should deep merge techStack without losing sibling fields', () => {
    const existing = baseMemory({
      techStack: { languages: [], frameworks: [], packageManager: 'npm', runtime: 'node' },
    });

    const merged = mergeProjectMemory(existing, {
      techStack: { languages: [], frameworks: [], packageManager: 'bun', runtime: null },
    } as Partial<ProjectMemory>);

    expect(merged.techStack.packageManager).toBe('bun');
    expect(merged.techStack.runtime).toBeNull();
  });

  it('should deep merge build.scripts without losing existing keys', () => {
    const existing = baseMemory({
      build: {
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        lintCommand: null,
        devCommand: null,
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
      },
    });

    const merged = mergeProjectMemory(existing, {
      build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: { dev: 'vite', test: 'vitest run' } },
    } as Partial<ProjectMemory>);

    expect(merged.build.scripts).toEqual({
      build: 'tsc',
      test: 'vitest run',  // incoming wins
      lint: 'eslint .',    // preserved from base
      dev: 'vite',         // new from incoming
    });
  });

  // -------------------------------------------------------------------------
  // customNotes merge
  // -------------------------------------------------------------------------

  it('should merge customNotes by category+content identity', () => {
    const existing = baseMemory({
      customNotes: [
        { timestamp: 100, source: 'manual', category: 'build', content: 'uses webpack' },
        { timestamp: 100, source: 'manual', category: 'test', content: 'uses jest' },
      ],
    });

    const merged = mergeProjectMemory(existing, {
      customNotes: [
        { timestamp: 200, source: 'learned', category: 'build', content: 'uses webpack' }, // same identity, newer
        { timestamp: 200, source: 'manual', category: 'deploy', content: 'uses docker' }, // new
      ],
    } as Partial<ProjectMemory>);

    expect(merged.customNotes).toHaveLength(3);
    // The 'build::uses webpack' note should be the newer one
    const buildNote = merged.customNotes.find(n => n.category === 'build');
    expect(buildNote!.timestamp).toBe(200);
    expect(buildNote!.source).toBe('learned');
    // Original 'test' note preserved
    expect(merged.customNotes.find(n => n.category === 'test')).toBeTruthy();
    // New 'deploy' note added
    expect(merged.customNotes.find(n => n.category === 'deploy')).toBeTruthy();
  });

  it('should keep older customNote when incoming has older timestamp', () => {
    const existing = baseMemory({
      customNotes: [
        { timestamp: 300, source: 'manual', category: 'build', content: 'note A' },
      ],
    });

    const merged = mergeProjectMemory(existing, {
      customNotes: [
        { timestamp: 100, source: 'manual', category: 'build', content: 'note A' },
      ],
    } as Partial<ProjectMemory>);

    expect(merged.customNotes[0].timestamp).toBe(300);
  });

  // -------------------------------------------------------------------------
  // userDirectives merge
  // -------------------------------------------------------------------------

  it('should merge userDirectives by directive text', () => {
    const existing = baseMemory({
      userDirectives: [
        { timestamp: 100, directive: 'use strict mode', context: '', source: 'explicit', priority: 'high' },
        { timestamp: 100, directive: 'prefer async/await', context: '', source: 'explicit', priority: 'normal' },
      ],
    });

    const merged = mergeProjectMemory(existing, {
      userDirectives: [
        { timestamp: 200, directive: 'use strict mode', context: 'updated', source: 'explicit', priority: 'high' },
        { timestamp: 200, directive: 'use bun', context: '', source: 'explicit', priority: 'normal' },
      ],
    } as Partial<ProjectMemory>);

    expect(merged.userDirectives).toHaveLength(3);
    const strictMode = merged.userDirectives.find(d => d.directive === 'use strict mode');
    expect(strictMode!.timestamp).toBe(200);
    expect(strictMode!.context).toBe('updated');
    expect(merged.userDirectives.find(d => d.directive === 'prefer async/await')).toBeTruthy();
    expect(merged.userDirectives.find(d => d.directive === 'use bun')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // hotPaths merge
  // -------------------------------------------------------------------------

  it('should merge hotPaths by path, taking max accessCount and lastAccessed', () => {
    const existing = baseMemory({
      hotPaths: [
        { path: 'src/index.ts', accessCount: 10, lastAccessed: 100, type: 'file' },
        { path: 'src/lib/', accessCount: 5, lastAccessed: 50, type: 'directory' },
      ],
    });

    const merged = mergeProjectMemory(existing, {
      hotPaths: [
        { path: 'src/index.ts', accessCount: 3, lastAccessed: 200, type: 'file' }, // lower count, newer access
        { path: 'src/utils/', accessCount: 7, lastAccessed: 150, type: 'directory' }, // new
      ],
    } as Partial<ProjectMemory>);

    expect(merged.hotPaths).toHaveLength(3);
    const indexPath = merged.hotPaths.find(h => h.path === 'src/index.ts');
    expect(indexPath!.accessCount).toBe(10); // max
    expect(indexPath!.lastAccessed).toBe(200); // max
    expect(merged.hotPaths.find(h => h.path === 'src/lib/')).toBeTruthy();
    expect(merged.hotPaths.find(h => h.path === 'src/utils/')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // languages / frameworks merge
  // -------------------------------------------------------------------------

  it('should merge languages by name, incoming wins on conflict', () => {
    const existing = baseMemory({
      techStack: {
        languages: [
          { name: 'TypeScript', version: '5.0', confidence: 'high', markers: ['tsconfig.json'] },
          { name: 'Python', version: '3.11', confidence: 'medium', markers: ['pyproject.toml'] },
        ],
        frameworks: [],
        packageManager: null,
        runtime: null,
      },
    });

    const merged = mergeProjectMemory(existing, {
      techStack: {
        languages: [
          { name: 'TypeScript', version: '5.5', confidence: 'high', markers: ['tsconfig.json'] },
          { name: 'Rust', version: '1.75', confidence: 'low', markers: ['Cargo.toml'] },
        ],
        frameworks: [],
        packageManager: null,
        runtime: null,
      },
    } as Partial<ProjectMemory>);

    expect(merged.techStack.languages).toHaveLength(3);
    const ts = merged.techStack.languages.find(l => l.name === 'TypeScript');
    expect(ts!.version).toBe('5.5'); // incoming wins
    expect(merged.techStack.languages.find(l => l.name === 'Python')).toBeTruthy();
    expect(merged.techStack.languages.find(l => l.name === 'Rust')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // String array union (workspaces, mainDirectories)
  // -------------------------------------------------------------------------

  it('should union workspaces without duplicates', () => {
    const existing = baseMemory({
      structure: {
        isMonorepo: true,
        workspaces: ['packages/core', 'packages/cli'],
        mainDirectories: ['src'],
        gitBranches: null,
      },
    });

    const merged = mergeProjectMemory(existing, {
      structure: {
        isMonorepo: true,
        workspaces: ['packages/cli', 'packages/web'],
        mainDirectories: ['src', 'lib'],
        gitBranches: null,
      },
    } as Partial<ProjectMemory>);

    expect(merged.structure.workspaces).toEqual(['packages/core', 'packages/cli', 'packages/web']);
    expect(merged.structure.mainDirectories).toEqual(['src', 'lib']);
  });

  // -------------------------------------------------------------------------
  // directoryMap merge
  // -------------------------------------------------------------------------

  it('should deep merge directoryMap entries', () => {
    const existing = baseMemory({
      directoryMap: {
        'src/lib': { path: 'src/lib', purpose: 'utilities', fileCount: 10, lastAccessed: 100, keyFiles: ['index.ts'] },
        'src/hooks': { path: 'src/hooks', purpose: 'hooks', fileCount: 5, lastAccessed: 50, keyFiles: [] },
      },
    });

    const merged = mergeProjectMemory(existing, {
      directoryMap: {
        'src/lib': { path: 'src/lib', purpose: 'shared utilities', fileCount: 12, lastAccessed: 200, keyFiles: ['index.ts', 'merge.ts'] },
        'src/tools': { path: 'src/tools', purpose: 'MCP tools', fileCount: 3, lastAccessed: 200, keyFiles: [] },
      },
    } as Partial<ProjectMemory>);

    expect(Object.keys(merged.directoryMap)).toHaveLength(3);
    expect(merged.directoryMap['src/lib'].purpose).toBe('shared utilities');
    expect(merged.directoryMap['src/lib'].fileCount).toBe(12);
    expect(merged.directoryMap['src/lib'].keyFiles).toEqual(['index.ts', 'merge.ts']);
    expect(merged.directoryMap['src/hooks']).toBeTruthy();
    expect(merged.directoryMap['src/tools']).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Cross-session scenario (the original bug)
  // -------------------------------------------------------------------------

  it('should not lose session A keys when session B writes different keys', () => {
    const sessionA = baseMemory({
      techStack: {
        languages: [{ name: 'TypeScript', version: '5.0', confidence: 'high', markers: [] }],
        frameworks: [{ name: 'React', version: '18', category: 'frontend' }],
        packageManager: 'npm',
        runtime: 'node',
      },
      customNotes: [{ timestamp: 100, source: 'manual', category: 'arch', content: 'monorepo' }],
    });

    // Session B only writes build info — should NOT lose techStack or notes
    const sessionBUpdate: Partial<ProjectMemory> = {
      build: {
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        lintCommand: 'npm run lint',
        devCommand: 'npm run dev',
        scripts: { build: 'tsc', test: 'vitest' },
      },
    };

    const merged = mergeProjectMemory(sessionA, sessionBUpdate);

    // Session A's data preserved
    expect(merged.techStack.languages).toHaveLength(1);
    expect(merged.techStack.frameworks).toHaveLength(1);
    expect(merged.techStack.packageManager).toBe('npm');
    expect(merged.customNotes).toHaveLength(1);
    // Session B's data applied
    expect(merged.build.buildCommand).toBe('npm run build');
    expect(merged.build.scripts.build).toBe('tsc');
  });
});
