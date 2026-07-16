import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { executeClaudeMdTransaction, isStrictChildPath, type ClaudeMdTransactionFs } from '../claude-md-transaction.js';
import { CLAUDE_MD_COORDINATOR_SCHEMA_VERSION, runClaudeMdCoordinator, runClaudeMdCoordinatorHandshake } from '../../cli/claude-md-coordinator.js';
import corpus from './fixtures/legacy-guides.json' with { type: 'json' };

const roots: string[] = [];
function fixture(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'omc-claude-md-transaction-'));
  roots.push(root);
  const plugin = join(root, 'plugin');
  mkdirSync(plugin);
  const source = join(plugin, 'CLAUDE.md');
  writeFileSync(source, '<!-- OMC:START -->\n# canonical\n<!-- OMC:END -->\n');
  return { root, source };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CLAUDE.md transactions', () => {
  it('overwrites main and deletes an orphan companion only after verified backups', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), 'user\n');
    writeFileSync(join(root, 'CLAUDE-omc.md'), 'orphan\n');
    const result = executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin'), version: '1.0.0' });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('<!-- OMC:VERSION:1.0.0 -->');
    expect(result.backups).toHaveLength(2);
    expect(result.deletedPaths).toEqual([join(root, 'CLAUDE-omc.md')]);
  });

  it('renders canonical content from parser-owned marker boundaries', () => {
    const { root, source } = fixture();
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('<!-- OMC:START -->\n# canonical\n<!-- OMC:END -->\n');
  });

  it('keeps the canonical missing-marker diagnostic compatible', () => {
    const { root, source } = fixture();
    writeFileSync(source, '# not managed\n');
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(result).toMatchObject({ exitCode: 3, failedPhase: 'validation' });
    expect(result.error).toContain('missing required OMC markers');
  });

  it('preserve writes the companion before the single owned import', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), '# user\n');
    const result = executeClaudeMdTransaction({ mode: 'global-preserve', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE-omc.md'), 'utf8')).toContain('# canonical');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('@CLAUDE-omc.md');
  });

  it.each(['local', 'global-overwrite', 'global-preserve'] as const)('omits all operations and backups on an idempotent %s rerun', mode => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    writeFileSync(main, 'user bytes\n');
    const request = { mode, root, source, sourceRoot: join(root, 'plugin') };
    expect(executeClaudeMdTransaction(request).ok).toBe(true);
    const beforeMain = readFileSync(main);
    const companion = join(root, 'CLAUDE-omc.md');
    const beforeCompanion = nodeFs.existsSync(companion) ? readFileSync(companion) : undefined;
    const rerun = executeClaudeMdTransaction(request);
    expect(rerun).toMatchObject({ ok: true, operations: [], completedOperations: [], backups: [], mutatedPaths: [] });
    expect(readFileSync(main)).toEqual(beforeMain);
    if (beforeCompanion) expect(readFileSync(companion)).toEqual(beforeCompanion);
    else expect(nodeFs.existsSync(companion)).toBe(false);
  });

  it('replaces generated customization headers without changing trailing user bytes', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    writeFileSync(main, 'user bytes\n');
    expect(executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') }).ok).toBe(true);
    const first = readFileSync(main, 'utf8');
    expect(executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') }).ok).toBe(true);
    const second = readFileSync(main, 'utf8');
    expect(second).toBe(first);
    expect(second.match(/<!-- User customizations -->/g)).toHaveLength(1);
    expect(second.endsWith('user bytes\n')).toBe(true);
  });

  it('removes a recovered generated customization header in original coordinates', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    writeFileSync(main, '<!-- OMC:START -->\nold\n<!-- OMC:END -->\n\n<!-- User customizations (recovered from corrupted markers) -->\ntrailing user bytes');
    const result = executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    const output = readFileSync(main, 'utf8');
    expect(output).not.toContain('recovered from corrupted markers');
    expect(output.match(/<!-- User customizations -->/g)).toHaveLength(1);
    expect(output.endsWith('trailing user bytes')).toBe(true);
  });

  it('preserves user-authored customization comments outside managed scaffolding', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    const existing = 'notes\n<!-- User customizations -->\nkeep this line\n';
    writeFileSync(main, existing);

    const result = executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') });
    const output = readFileSync(main, 'utf8');

    expect(result.ok).toBe(true);
    expect(output.match(/<!-- User customizations -->/g)).toHaveLength(2);
    expect(output.endsWith(existing)).toBe(true);
  });

  it('refuses a symlink before mutation', () => {
    const { root, source } = fixture();
    const outside = join(root, 'outside');
    writeFileSync(outside, 'unchanged');
    symlinkSync(outside, join(root, 'CLAUDE.md'));
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  });

  it('rejects invalid UTF-8 without changing targets', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), Buffer.from([0xff]));
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(join(root, 'CLAUDE.md'))).toEqual(Buffer.from([0xff]));
  });

  it('preserves a leading UTF-8 BOM and does not classify the bytes as exact legacy content', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    const guide = Buffer.from((corpus.variants as Array<{ dataBase64: string }>)[0].dataBase64, 'base64');
    const bomGuide = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), guide]);
    writeFileSync(main, bomGuide);

    const result = executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') });
    const output = readFileSync(main);

    expect(result.ok).toBe(true);
    expect(result.removedVariants).toEqual([]);
    expect(output.indexOf(bomGuide)).toBeGreaterThanOrEqual(0);
  });
  it('does not serialize operation bytes or temporary paths', () => {
    const { root, source } = fixture();
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(JSON.stringify(result)).not.toContain('"bytes"');
    expect(JSON.stringify(result)).not.toContain('"tempPath"');
  });

  it('reports a verified-backup write failure before mutation', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    writeFileSync(main, 'user\n');
    const fs = { ...nodeFs, writeFileSync(path: nodeFs.PathOrFileDescriptor, data: string | Uint8Array, options?: nodeFs.WriteFileOptions) {
      if (typeof path === 'number') throw new Error('backup write failed');
      return nodeFs.writeFileSync(path, data, options);
    } } as ClaudeMdTransactionFs;
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin'), fs });
    expect(result).toMatchObject({ exitCode: 4, failedPhase: 'backup' });
    expect(readFileSync(main, 'utf8')).toBe('user\n');
  });

  it('rolls back a newly-created companion and cleans the failed operation temp', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), 'user trailing bytes');
    let renames = 0;
    const fs = { ...nodeFs, renameSync(oldPath: nodeFs.PathLike, newPath: nodeFs.PathLike) {
      renames += 1;
      if (renames === 2) throw new Error('second operation failed');
      return nodeFs.renameSync(oldPath, newPath);
    } } as ClaudeMdTransactionFs;
    const result = executeClaudeMdTransaction({ mode: 'global-preserve', root, source, sourceRoot: join(root, 'plugin'), fs });
    expect(result).toMatchObject({ ok: false, exitCode: 5, failedPhase: 'mutation' });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('user trailing bytes');
    expect(nodeFs.existsSync(join(root, 'CLAUDE-omc.md'))).toBe(false);
    expect(result.tempCleanup.every(item => item.ok)).toBe(true);
  });

  it('reports rollback failure with its phase and path', () => {
    const { root, source } = fixture();
    const companion = join(root, 'CLAUDE-omc.md');
    writeFileSync(join(root, 'CLAUDE.md'), 'user');
    let renames = 0;
    const fs = { ...nodeFs, renameSync(oldPath: nodeFs.PathLike, newPath: nodeFs.PathLike) {
      renames += 1;
      if (renames === 2) throw new Error('mutation failed');
      return nodeFs.renameSync(oldPath, newPath);
    }, unlinkSync(path: nodeFs.PathLike) {
      if (path === companion) throw new Error('rollback delete failed');
      return nodeFs.unlinkSync(path);
    } } as ClaudeMdTransactionFs;
    const result = executeClaudeMdTransaction({ mode: 'global-preserve', root, source, sourceRoot: join(root, 'plugin'), fs });
    expect(result).toMatchObject({ exitCode: 6, failedPhase: 'rollback', failedPath: companion });
    expect(result.rollback).toEqual([{ path: companion, ok: false, error: 'rollback delete failed' }]);
  });
  it('fails closed on corrupt markers without altering user bytes', () => {
    const { root, source } = fixture();
    const main = join(root, 'CLAUDE.md');
    writeFileSync(main, 'trailing\n<!-- OMC:START -->\n');
    const result = executeClaudeMdTransaction({ mode: 'global-preserve', root, source, sourceRoot: join(root, 'plugin') });
    expect(result).toMatchObject({ exitCode: 3, failedPhase: 'validation' });
    expect(result.error).toContain('corrupt OMC markers');
    expect(readFileSync(main, 'utf8')).toBe('trailing\n<!-- OMC:START -->\n');
  });
});

describe('strict rooted path containment', () => {
  it.each([
    ['same-drive child', 'C:\\root', 'C:\\root\\child\\CLAUDE.md', true],
    ['drive mismatch', 'C:\\root', 'D:\\root\\CLAUDE.md', false],
    ['same-share UNC child', '\\\\server\\share\\root', '\\\\server\\share\\root\\child\\CLAUDE.md', true],
    ['share mismatch', '\\\\server\\share-a\\root', '\\\\server\\share-b\\root\\CLAUDE.md', false],
    ['server mismatch', '\\\\server-a\\share\\root', '\\\\server-b\\share\\root\\CLAUDE.md', false],
    ['local and UNC mix', 'C:\\root', '\\\\server\\share\\root\\CLAUDE.md', false],
    ['traversal', 'C:\\root', 'C:\\root\\..\\outside\\CLAUDE.md', false],
    ['root equality', 'C:\\root', 'C:\\root', false],
    ['device namespace candidate', 'C:\\root', '\\\\?\\C:\\root\\CLAUDE.md', false],
    ['device namespace root', '\\\\.\\C:\\root', 'C:\\root\\CLAUDE.md', false],
  ])('%s', (_name, root, candidate, expected) => {
    expect(isStrictChildPath(root, candidate, win32)).toBe(expected);
  });

  it('rejects an escaped transaction source before mutation', () => {
    const { root } = fixture();
    const outside = join(root, 'outside.md');
    writeFileSync(outside, '<!-- OMC:START -->\noutside\n<!-- OMC:END -->\n');
    const result = executeClaudeMdTransaction({ mode: 'local', root, source: outside, sourceRoot: join(root, 'plugin') });
    expect(result).toMatchObject({ ok: false, exitCode: 3, failedPhase: 'validation' });
    expect(nodeFs.existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toContain('outside');
  });
});

describe('CLAUDE.md coordinator protocol', () => {
  it('reports an unavailable ordinary-module handshake without exposing build internals', () => {
    const outcome = runClaudeMdCoordinatorHandshake();
    expect(outcome).toMatchObject({ exitCode: 2, response: { ok: false, error: 'Coordinator build handshake is unavailable', schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION } });
  });

  it('keeps normal stdin request validation separate from the handshake mode', () => {
    const outcome = runClaudeMdCoordinator({ schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION });
    expect(outcome).toMatchObject({ exitCode: 2, response: { ok: false, error: 'Invalid coordinator request', schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION } });
  });
  it('rejects an escaped built coordinator request before transaction mutation', () => {
    const { root } = fixture();
    const pluginRoot = process.cwd();
    const canonicalSource = join(pluginRoot, 'docs', 'CLAUDE.md');
    const packageVersion = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version;
    const sourceSha256 = createHash('sha256').update(readFileSync(canonicalSource)).digest('hex');
    const outcome = spawnSync(process.execPath, ['bridge/claude-md-coordinator.cjs'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION,
        engineVersion: packageVersion,
        mode: 'local',
        configRoot: root,
        pluginRoot,
        sourcePath: join(root, 'outside.md'),
        sourceSha256,
        sourceVersion: packageVersion,
      }),
    });
    expect(outcome.status).toBe(3);
    const response = JSON.parse(outcome.stdout);
    expect(response).toMatchObject({ ok: false, exitCode: 3 });
    expect(response.error).toContain('Source must be inside plugin root');
    expect(nodeFs.existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });
});
