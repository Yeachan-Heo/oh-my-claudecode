import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getServerForFile, resolveTypescriptServer } from '../servers.js';

// Builds a fake project tree with a node_modules/typescript install.
function makeProject(kind: 'native' | 'classic'): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-ts-'));
  const tsDir = join(root, 'node_modules', 'typescript');
  mkdirSync(join(tsDir, 'lib'), { recursive: true });
  mkdirSync(join(tsDir, 'bin'), { recursive: true });
  writeFileSync(join(tsDir, 'package.json'), '{"name":"typescript"}');
  writeFileSync(join(tsDir, 'bin', 'tsc'), '#!/usr/bin/env node\n');
  // Classic (<=6) ships lib/tsserver.js; native (7+/typescript-go) does not.
  if (kind === 'classic') writeFileSync(join(tsDir, 'lib', 'tsserver.js'), '');
  return root;
}

describe('resolveTypescriptServer', () => {
  let nativeRoot: string;
  let classicRoot: string;

  beforeAll(() => {
    nativeRoot = makeProject('native');
    classicRoot = makeProject('classic');
  });

  afterAll(() => {
    rmSync(nativeRoot, { recursive: true, force: true });
    rmSync(classicRoot, { recursive: true, force: true });
  });

  it('launches the native tsc LSP for a TypeScript 7 (typescript-go) project', () => {
    const config = resolveTypescriptServer(join(nativeRoot, 'src', 'index.ts'));
    expect(config.command).toBe(process.execPath);
    expect(config.args).toEqual([
      join(nativeRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--lsp',
      '--stdio',
    ]);
  });

  it('uses typescript-language-server for a classic (<=6) project', () => {
    const config = resolveTypescriptServer(join(classicRoot, 'src', 'index.ts'));
    expect(config.command).toBe('typescript-language-server');
    expect(config.args).toEqual(['--stdio']);
  });

  it('falls back to typescript-language-server when no local typescript is found', () => {
    const config = resolveTypescriptServer(join(tmpdir(), 'no-such-project', 'index.ts'));
    expect(config.command).toBe('typescript-language-server');
  });

  it('getServerForFile routes .ts through the native resolver', () => {
    const config = getServerForFile(join(nativeRoot, 'a.ts'));
    expect(config?.name).toBe('TypeScript Native LSP (typescript-go)');
  });
});
