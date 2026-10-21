import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { adoptWorkerPaneOwnership, sendTeamPaneKey, spawnWorkerInPane, splitTeamWorkerPaneWithEvidence, } from '../tmux-session.js';
import { getWorkerEnv } from '../model-contract.js';
const FAKE_CMUX_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[0] || '';
fs.appendFileSync(process.env.CMUX_FAKE_LOG, JSON.stringify(args) + '\\n');
const dialect = process.env.CMUX_FAKE_DIALECT;
const fail = (name) => {
  process.stderr.write('Error: Unknown command "' + name + '". Run "cmux --help" for the full command list.\\n');
  process.exit(2);
};
if (dialect === 'new' && ['send-surface', 'send-key-surface'].includes(command)) fail(command);
if (dialect === 'old' && ['send', 'send-key'].includes(command)) fail(command);
if (command === '--json' && args[1] === 'list-panes') {
  let state = { listPaneCalls: 0 };
  try { state = JSON.parse(fs.readFileSync(process.env.CMUX_FAKE_STATE, 'utf8')); } catch {}
  state.listPaneCalls += 1;
  fs.writeFileSync(process.env.CMUX_FAKE_STATE, JSON.stringify(state));
  const panes = state.listPaneCalls < 2
    ? [{ id: 'pane-leader' }]
    : [{ id: 'pane-leader' }, { id: 'pane-worker' }];
  process.stdout.write(JSON.stringify({ panes }));
  process.exit(0);
}
if (command === '--json' && args[1] === 'list-pane-surfaces') {
  const paneIndex = args.indexOf('--pane');
  const pane = args[paneIndex + 1];
  const id = pane === 'pane-worker' ? 'surface:worker-42' : 'surface:leader';
  process.stdout.write(JSON.stringify({ surfaces: [{ id }] }));
  process.exit(0);
}
if (command === 'new-split') {
  process.stdout.write('OK surface:worker-42 workspace:workspace-1\\n');
  process.exit(0);
}
if (command === 'send' || command === 'send-key' || command === 'send-surface' || command === 'send-key-surface') {
  if (command === 'send-key' || command === 'send-key-surface') {
    const key = args[args.length - 1];
    if (!['enter', 'ctrl+x'].includes(key)) {
      process.stderr.write('invalid_params: Unknown key "' + key + '"\\n');
      process.exit(2);
    }
  }
  process.exit(0);
}
process.exit(0);
`;
let fixtureRoot = '';
const ENV_KEYS = [
    'PATH',
    'TMUX',
    'CMUX_SURFACE_ID',
    'CMUX_WORKSPACE_ID',
    'CMUX_FAKE_DIALECT',
    'CMUX_FAKE_LOG',
    'CMUX_FAKE_STATE',
];
let savedEnv = {};
async function setupFakeCmux(dialect) {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'omc-issue-4412-cmux-'));
    const bin = join(fixtureRoot, 'bin');
    await mkdir(bin);
    const fakeCmux = join(bin, 'cmux');
    await writeFile(fakeCmux, FAKE_CMUX_SOURCE, 'utf8');
    await chmod(fakeCmux, 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    process.env.TMUX = '';
    process.env.CMUX_SURFACE_ID = 'surface:leader';
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_FAKE_DIALECT = dialect;
    process.env.CMUX_FAKE_LOG = join(fixtureRoot, 'calls.jsonl');
    process.env.CMUX_FAKE_STATE = join(fixtureRoot, 'state.json');
}
async function readCalls() {
    const output = await readFile(process.env.CMUX_FAKE_LOG, 'utf8');
    return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
});
afterEach(async () => {
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    savedEnv = {};
    if (fixtureRoot)
        await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
});
describe('issue #4412: cmux startup compatibility', () => {
    it.each([
        ['dedicated-command support', 'old'],
        ['surface-option support', 'new'],
    ])('detects %s from CLI behavior and submits worker startup with Enter', async (_name, dialect) => {
        await setupFakeCmux(dialect);
        const secureStorageDir = join(fixtureRoot, 'claude-secure-storage');
        const envVars = getWorkerEnv('safe-team', 'worker-1', 'claude', {
            CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDir,
        });
        await spawnWorkerInPane('cmux:workspace-1', 'surface:worker-42', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars,
            launchBinary: 'claude',
            launchArgs: [],
            cwd: fixtureRoot,
        });
        await sendTeamPaneKey('surface:worker-42', 'C-m');
        const calls = await readCalls();
        const textSend = calls.find(args => args[0] === 'send' || args[0] === 'send-surface');
        expect(textSend).toBeDefined();
        expect(textSend?.at(-1)).toContain('claude');
        expect(textSend?.at(-1)).toContain(`CLAUDE_SECURESTORAGE_CONFIG_DIR='${secureStorageDir}'`);
        const keyCalls = calls.filter(args => ['send-key', 'send-key-surface'].includes(args[0] ?? ''));
        expect(keyCalls.map(args => args[0])).toEqual(dialect === 'old'
            ? ['send-key-surface', 'send-key-surface']
            : ['send-key-surface', 'send-key', 'send-key-surface', 'send-key']);
        expect(keyCalls.every(args => args.at(-1) === 'enter')).toBe(true);
        expect(keyCalls.some(args => args.at(-1) === 'C-m')).toBe(false);
        if (dialect === 'new') {
            expect(calls.some(args => args[0] === 'send' && args[1] === '--surface')).toBe(true);
            expect(calls.some(args => args[0] === 'send-key' && args[1] === '--surface')).toBe(true);
        }
        else {
            expect(calls.some(args => args[0] === 'send-surface')).toBe(true);
            expect(calls.some(args => args[0] === 'send-key-surface')).toBe(true);
        }
    });
    it('retries cmux pane membership until the newly split surface is visible', async () => {
        await setupFakeCmux('new');
        const split = await splitTeamWorkerPaneWithEvidence('surface:leader', 'right', fixtureRoot, 'cmux');
        expect(split).toMatchObject({
            commandSucceeded: true,
            provider: 'cmux',
            paneId: 'surface:worker-42',
        });
        const ownership = await adoptWorkerPaneOwnership({
            provider: 'cmux',
            providerTarget: 'cmux:workspace-1',
            paneId: split.paneId,
            leaderPaneId: 'surface:leader',
            reservedPaneIds: [],
        });
        expect(ownership).toMatchObject({
            ok: true,
            ownership: {
                provider: 'cmux',
                providerTarget: 'cmux:workspace-1',
                paneId: 'surface:worker-42',
                source: 'adopted',
            },
        });
        const listCalls = (await readCalls()).filter(args => args[0] === '--json' && args[1] === 'list-panes');
        expect(listCalls).toHaveLength(2);
    });
});
//# sourceMappingURL=issue-4412-cmux-startup.test.js.map