import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const osPaths = { home: '', tmp: '' };
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => osPaths.home), tmpdir: vi.fn(() => osPaths.tmp) };
});

const suiteParent = resolve(process.env.HOME || '/Users');
const suiteRoot = mkdtempSync(join(suiteParent, 'omc-3873-owner-'));
osPaths.home = join(suiteRoot, 'home');
osPaths.tmp = join(suiteRoot, 'tmp');
mkdirSync(osPaths.home, { recursive: true });
mkdirSync(osPaths.tmp, { recursive: true });

import { stateTools } from '../state-tools.js';
import { clearWorktreeCache, setGitShowToplevelProbeForTests } from '../../lib/worktree-paths.js';

const stateReadTool = stateTools.find((tool) => tool.name === 'state_read')!;
const stateWriteTool = stateTools.find((tool) => tool.name === 'state_write')!;
const stateStatusTool = stateTools.find((tool) => tool.name === 'state_get_status')!;
const stateListTool = stateTools.find((tool) => tool.name === 'state_list_active')!;
const stateMigrateTool = stateTools.find((tool) => tool.name === 'state_migrate_non_git')!;

let workingDirectory: string;
let centralState: string;
const previousCwd = process.cwd();
const previousStateDir = process.env.OMC_STATE_DIR;

beforeEach(() => {
  workingDirectory = join(suiteRoot, `work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  centralState = join(suiteRoot, 'central');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(centralState, { recursive: true });
  process.chdir(workingDirectory);
  process.env.OMC_STATE_DIR = centralState;
  clearWorktreeCache();
});

afterEach(() => {
  setGitShowToplevelProbeForTests(undefined);
  process.chdir(previousCwd);
  if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousStateDir;
  clearWorktreeCache();
});

afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

describe('#3873 real non-git state ownership', () => {
  it('uses one fixed OMC_STATE_DIR/non-git root for explicit state-tool directories', async () => {
    const result = await stateWriteTool.handler({
      mode: 'ralph',
      session_id: 'owner-a',
      active: true,
      workingDirectory,
    });

    expect(result.isError).toBeUndefined();
    const canonicalPath = join(centralState, 'non-git', 'state', 'sessions', 'owner-a', 'ralph-state.json');
    expect(existsSync(canonicalPath)).toBe(true);
    expect(result.content[0].text).toContain(canonicalPath);
  });

  it('does not expose or disarm a session-scoped file owned by another session', async () => {
    const foreignPath = join(centralState, 'non-git', 'state', 'sessions', 'requester', 'ralph-state.json');
    mkdirSync(join(foreignPath, '..'), { recursive: true });
    const original = JSON.stringify({ active: true, session_id: 'owner-a', _meta: { sessionId: 'owner-a' } });
    writeFileSync(foreignPath, original);

    const readResult = await stateReadTool.handler({ mode: 'ralph', session_id: 'requester', workingDirectory });
    expect(readResult.content[0].text).not.toContain('"session_id"');
    expect(readResult.content[0].text).toContain('No state found');

    const writeResult = await stateWriteTool.handler({ mode: 'ralph', session_id: 'requester', active: false, workingDirectory });
    expect(writeResult.isError).toBe(true);
    expect(readFileSync(foreignPath, 'utf8')).toBe(original);
  });

  it('does not disclose foreign state through session status', async () => {
    const foreignPath = join(centralState, 'non-git', 'state', 'sessions', 'status-requester', 'ralph-state.json');
    mkdirSync(join(foreignPath, '..'), { recursive: true });
    writeFileSync(foreignPath, JSON.stringify({ active: true, session_id: 'status-owner', secret: 'private' }));

    const result = await stateStatusTool.handler({ mode: 'ralph', session_id: 'status-requester', workingDirectory });
    expect(result.content[0].text).toContain('**Active:** No');
    expect(result.content[0].text).toContain('**Exists:** No');
    expect(result.content[0].text).not.toContain('private');
  });

  it('does not list a metadata-owned foreign extra mode as active', async () => {
    const foreignPath = join(centralState, 'non-git', 'state', 'sessions', 'list-requester', 'autoresearch-state.json');
    mkdirSync(join(foreignPath, '..'), { recursive: true });
    writeFileSync(foreignPath, JSON.stringify({ active: true, _meta: { sessionId: 'list-owner' }, secret: 'private' }));
    const result = await stateListTool.handler({ mode: 'autoresearch', session_id: 'list-requester', workingDirectory });
    expect(result.content[0].text).not.toContain('autoresearch');
    expect(result.content[0].text).not.toContain('private');
  });

  it('does not let a requester overwrite a foreign ordinary autopilot record', async () => {
    const foreignPath = join(centralState, 'non-git', 'state', 'sessions', 'autopilot-requester', 'autopilot-state.json');
    mkdirSync(join(foreignPath, '..'), { recursive: true });
    const original = JSON.stringify({ active: true, session_id: 'autopilot-owner', phase: 'execution' });
    writeFileSync(foreignPath, original);

    const result = await stateWriteTool.handler({ mode: 'autopilot', session_id: 'autopilot-requester', active: false, workingDirectory });
    expect(result.isError).toBe(true);
    expect(readFileSync(foreignPath, 'utf8')).toBe(original);
  });

  it('explicitly migrates only matching session-owned JSON without overwriting or deleting source', async () => {
    const sourceRoot = join(osPaths.home, 'legacy-project');
    const sourceSession = join(sourceRoot, '.omc', 'state', 'sessions', 'migrate-a');
    mkdirSync(sourceSession, { recursive: true });
    const ownedPath = join(sourceSession, 'ralph-state.json');
    const foreignPath = join(sourceSession, 'ultrawork-state.json');
    const owned = JSON.stringify({ active: true, session_id: 'migrate-a', _meta: { sessionId: 'migrate-a' } });
    writeFileSync(ownedPath, owned);
    writeFileSync(foreignPath, JSON.stringify({ active: true, session_id: 'other-session' }));
    writeFileSync(join(sourceRoot, '.omc', 'state', 'ralph-state.json'), JSON.stringify({ active: true, session_id: 'migrate-a' }));

    const beforeMigrationCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'migrate-a' });
    } finally {
      process.chdir(beforeMigrationCwd);
    }
    const destination = join(centralState, 'non-git', 'state', 'sessions', 'migrate-a', 'ralph-state.json');
    expect(result.isError).toBeUndefined();
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(owned);
    expect(existsSync(ownedPath)).toBe(true);
    expect(existsSync(join(centralState, 'non-git', 'state', 'sessions', 'migrate-a', 'ultrawork-state.json'))).toBe(false);
    expect(existsSync(join(centralState, 'non-git', 'state', 'ralph-state.json'))).toBe(false);

    writeFileSync(ownedPath, JSON.stringify({ active: false, session_id: 'migrate-a' }));
    const secondCwd = process.cwd();
    process.chdir(sourceRoot);
    let second;
    try {
      second = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'migrate-a' });
    } finally {
      process.chdir(secondCwd);
    }
    expect(second.isError).toBeUndefined();
    expect(second.content[0].text).toContain('ralph-state.json');
    expect(readFileSync(destination, 'utf8')).toBe(owned);
  });

  it('rejects migration sources outside the authorized home boundary', async () => {
    const sourceRoot = join(osPaths.tmp, 'attacker-sibling');
    const sourceSession = join(sourceRoot, '.omc', 'state', 'sessions', 'boundary-owner');
    mkdirSync(sourceSession, { recursive: true });
    writeFileSync(join(sourceSession, 'ralph-state.json'), JSON.stringify({
      active: true,
      session_id: 'boundary-owner',
      _meta: { sessionId: 'boundary-owner' },
    }));

    const result = await stateMigrateTool.handler({
      mode: 'ralph',
      workingDirectory: sourceRoot,
      session_id: 'boundary-owner',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('trusted session working directory');
  });

  it('rejects an owner-matched source outside the trusted session working directory', async () => {
    const sourceRoot = join(osPaths.home, 'untrusted-sibling');
    const sourceSession = join(sourceRoot, '.omc', 'state', 'sessions', 'boundary-owner');
    mkdirSync(sourceSession, { recursive: true });
    writeFileSync(join(sourceSession, 'ralph-state.json'), JSON.stringify({
      active: true,
      session_id: 'boundary-owner',
      _meta: { sessionId: 'boundary-owner' },
    }));

    const result = await stateMigrateTool.handler({
      mode: 'ralph',
      workingDirectory: sourceRoot,
      session_id: 'boundary-owner',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('trusted session working directory');
  });

  it('returns an empty migration report for a partial legacy root', async () => {
    const sourceRoot = join(osPaths.home, 'partial-legacy');
    mkdirSync(join(sourceRoot, '.omc'), { recursive: true });
    const beforeCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'partial-owner' });
    } finally {
      process.chdir(beforeCwd);
    }
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ copied: [], skipped: [], rejected: [] });
  });

  it('rejects oversized migration records without reading unbounded input', async () => {
    const sourceRoot = join(osPaths.home, 'oversized-legacy');
    const sourceSession = join(sourceRoot, '.omc', 'state', 'sessions', 'large-owner');
    mkdirSync(sourceSession, { recursive: true });
    const sourcePath = join(sourceSession, 'ralph-state.json');
    const oversized = `{"active":true,"session_id":"large-owner","payload":"${'x'.repeat(1_100_000)}"}`;
    writeFileSync(sourcePath, oversized);
    const beforeCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'large-owner' });
    } finally {
      process.chdir(beforeCwd);
    }
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).rejected).toContain('ralph-state.json');
    expect(readFileSync(sourcePath, 'utf8')).toBe(oversized);
  });

  it('rejects legacy sources beneath malformed Git metadata', async () => {
    const parent = join(osPaths.home, 'malformed-git-parent');
    const sourceRoot = join(parent, 'legacy-child');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(parent, '.git'), 'gitdir: /missing-omc-gitdir');
    const beforeCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'malformed-owner' });
    } finally {
      process.chdir(beforeCwd);
    }
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Git metadata');
  });

  it('fails closed on a typed Git probe failure', async () => {
    setGitShowToplevelProbeForTests(() => {
      const error = new Error('git unavailable') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    const probePath = join(osPaths.home, 'probe-failure');
    mkdirSync(probePath, { recursive: true });
    const beforeProbeCwd = process.cwd();
    process.chdir(probePath);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: probePath, session_id: 'probe-owner' });
    } finally {
      process.chdir(beforeProbeCwd);
    }
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('failed Git probe');
  });

  it('rejects a symlinked legacy state root before copying', async () => {
    const sourceRoot = join(osPaths.home, 'symlink-project');
    const targetOmc = join(osPaths.home, 'symlink-target-omc');
    const targetSession = join(targetOmc, 'state', 'sessions', 'symlink-owner');
    mkdirSync(targetSession, { recursive: true });
    writeFileSync(join(targetSession, 'ralph-state.json'), JSON.stringify({ active: true, session_id: 'symlink-owner' }));
    mkdirSync(sourceRoot, { recursive: true });
    try {
      symlinkSync(targetOmc, join(sourceRoot, '.omc'), 'dir');
    } catch {
      return;
    }

    const beforeSymlinkCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'symlink-owner' });
    } finally {
      process.chdir(beforeSymlinkCwd);
    }
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('symlinked legacy state paths');
  });

  it('rejects symlinked destination ancestors before copying', async () => {
    const sourceRoot = join(osPaths.home, 'destination-symlink-project');
    const sourceSession = join(sourceRoot, '.omc', 'state', 'sessions', 'destination-owner');
    mkdirSync(sourceSession, { recursive: true });
    writeFileSync(join(sourceSession, 'ralph-state.json'), JSON.stringify({ active: true, session_id: 'destination-owner' }));

    const isolatedCentral = join(suiteRoot, 'central-destination-symlink');
    const canonicalOmc = join(isolatedCentral, 'non-git');
    const destinationState = join(canonicalOmc, 'state');
    const outsideState = join(suiteRoot, 'outside-destination-state');
    mkdirSync(outsideState, { recursive: true });
    mkdirSync(canonicalOmc, { recursive: true });
    try {
      symlinkSync(outsideState, destinationState, 'dir');
    } catch {
      return;
    }

    process.env.OMC_STATE_DIR = isolatedCentral;
    const beforeDestinationCwd = process.cwd();
    process.chdir(sourceRoot);
    let result;
    try {
      result = await stateMigrateTool.handler({ mode: 'ralph', workingDirectory: sourceRoot, session_id: 'destination-owner' });
    } finally {
      process.chdir(beforeDestinationCwd);
    }
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('symlinked migration roots');
    expect(existsSync(join(outsideState, 'sessions', 'destination-owner', 'ralph-state.json'))).toBe(false);
  });
});
