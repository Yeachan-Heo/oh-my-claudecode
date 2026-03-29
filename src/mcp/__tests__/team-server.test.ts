import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('team-server CJS safety', () => {
  const sourcePath = join(__dirname, '..', 'team-server.ts');
  const source = readFileSync(sourcePath, 'utf-8');

  it('uses __ownDir instead of bare __dirname for CJS compatibility', () => {
    expect(source).toContain('__ownDir');
    expect(source).not.toMatch(/^const __dirname = fileURLToPath/m);
  });

  it('checks typeof __dirname before using import.meta.url', () => {
    const ownDirBlock = source.match(/const __ownDir[\s\S]*?\)\(\)/);
    expect(ownDirBlock).toBeTruthy();
    const block = ownDirBlock![0];
    const dirnameCheckIdx = block.indexOf("typeof __dirname");
    const importMetaIdx = block.indexOf("import.meta.url");
    expect(dirnameCheckIdx).toBeLessThan(importMetaIdx);
  });

  it('has process.cwd() as last-resort fallback', () => {
    const ownDirBlock = source.match(/const __ownDir[\s\S]*?\)\(\)/);
    expect(ownDirBlock![0]).toContain('process.cwd()');
  });

  it('uses __ownDir for runtimeCliPath join', () => {
    expect(source).toContain("join(__ownDir, 'runtime-cli.cjs')");
  });

  it('wraps import.meta.url in try/catch for CJS safety', () => {
    const ownDirBlock = source.match(/const __ownDir[\s\S]*?\)\(\)/);
    expect(ownDirBlock![0]).toContain('try {');
    expect(ownDirBlock![0]).toContain('catch');
  });
});
