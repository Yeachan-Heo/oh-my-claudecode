/* global process, setTimeout */
/**
 * Tests for the Jev delivery guard (scripts/lib/jev-delivery-guard.mjs, OMC_JEV_GUARD=1) and its
 * wiring in session-start.mjs and keyword-detector.mjs.
 *
 * The library tests drive the functions with a temporary Claude config dir and plugin root; the
 * script tests run the real hook scripts as Claude Code does. Everything runs without the network.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeDelivery,
  dailyStatePath,
  deliveryMessage,
  isGuardEnabled,
  limitMessage,
  minTimeoutSeconds,
  preToolTimeout,
  promptCheck,
  settingsEnvHash,
  startDailyCheck,
  startSession,
} from '../../scripts/lib/jev-delivery-guard.mjs';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const GUARD_SCRIPT = join(repoRoot, 'scripts', 'lib', 'jev-delivery-guard.mjs');
const SESSION_START = join(repoRoot, 'scripts', 'session-start.mjs');
const KEYWORD_DETECTOR = join(repoRoot, 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;

const ON = { TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing:active', OMC_JEV_GUARD: '1' };
const NOW = Date.now();
const HOUR = 3600 * 1000;

let root;
let configDir;
let pluginRoot;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jev-delivery-guard-'));
  configDir = join(root, 'claude');
  pluginRoot = join(root, 'plugin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a detached child may still hold a file */ }
});

/** hooks.json with a pre-tool-enforcer entry (timeout omitted when undefined) and an unrelated Bash entry at 5 s. */
function writeHooks(timeout, { legacyCommand = false, extra = 0 } = {}) {
  const enforcer = legacyCommand
    ? { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-enforcer.mjs"' }
    : { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs', '${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-enforcer.mjs'] };
  if (timeout !== undefined) enforcer.timeout = timeout;
  const doc = {
    hooks: {
      PreToolUse: [
        { matcher: '*', hooks: [enforcer] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', timeout: 5, args: ['${CLAUDE_PLUGIN_ROOT}/scripts/git-guardrails.mjs'] }] },
      ],
      UserPromptSubmit: Array.from({ length: extra }, (_, i) => ({ matcher: '*', hooks: [{ type: 'command', command: `node x${i}.mjs`, timeout: 30 }] })),
    },
  };
  writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(doc));
}

function writeSettings(env, rest = {}) {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ ...rest, env }));
}

const options = (overrides = {}) => ({ env: ON, now: NOW, pluginRoot, configDir, ...overrides });
const session = (id = 's1', source = 'startup') => ({ session_id: id, source });

describe('isGuardEnabled and minTimeoutSeconds', () => {
  it('needs OMC_JEV_GUARD and an active model-routing point with a key', () => {
    expect(isGuardEnabled(ON)).toBe(true);
    expect(isGuardEnabled({ ...ON, OMC_JEV_GUARD: 'true' })).toBe(true);
    expect(isGuardEnabled({ ...ON, OMC_JEV: 'all:active' })).toBe(true);
    expect(isGuardEnabled({ ...ON, OMC_JEV_GUARD: undefined })).toBe(false);
    expect(isGuardEnabled({ ...ON, OMC_JEV_GUARD: '0' })).toBe(false);
    expect(isGuardEnabled({ ...ON, TYPESAFE_API_KEY: '' })).toBe(false);
    expect(isGuardEnabled({ ...ON, OMC_JEV: 'off' })).toBe(false);
    expect(isGuardEnabled({ ...ON, OMC_JEV: 'model-routing' })).toBe(false); // shadow: no decision is applied
    expect(isGuardEnabled({ ...ON, OMC_JEV: 'intent:active' })).toBe(false);
  });

  it('reads the minimum timeout, falling back to 60', () => {
    expect(minTimeoutSeconds({})).toBe(60);
    expect(minTimeoutSeconds({ OMC_JEV_GUARD_MIN_TIMEOUT_S: '10' })).toBe(10);
    expect(minTimeoutSeconds({ OMC_JEV_GUARD_MIN_TIMEOUT_S: '0' })).toBe(60);
    expect(minTimeoutSeconds({ OMC_JEV_GUARD_MIN_TIMEOUT_S: 'soon' })).toBe(60);
  });
});

describe('(a) the pre-tool-enforcer timeout at session start', () => {
  it('reports a timeout below the minimum and stays silent at or above it', () => {
    writeHooks(5);
    expect(startSession(session(), options())).toMatch(/pre-tool-enforcer.*is 5 s.*at least 60 s/s);
    writeHooks(59);
    expect(startSession(session('s2'), options())).toContain('is 59 s');
    writeHooks(60);
    expect(startSession(session('s3'), options())).toBeNull();
    writeHooks(600);
    expect(startSession(session('s4'), options())).toBeNull();
  });

  it('ignores other PreToolUse entries, finds the legacy command form, and gives no verdict without a numeric timeout', () => {
    writeHooks(60); // the Bash entry has 5 s and must not count
    expect(preToolTimeout(pluginRoot)).toBe(60);
    writeHooks(5, { legacyCommand: true });
    expect(preToolTimeout(pluginRoot)).toBe(5);
    writeHooks(undefined);
    expect(preToolTimeout(pluginRoot)).toBeNull();
    expect(limitMessage(pluginRoot, 60)).toBeNull();
    expect(limitMessage(join(root, 'no-such-plugin'), 60)).toBeNull();
  });

  it('follows OMC_JEV_GUARD_MIN_TIMEOUT_S', () => {
    writeHooks(5);
    expect(startSession(session(), options({ env: { ...ON, OMC_JEV_GUARD_MIN_TIMEOUT_S: '5' } }))).toBeNull();
    expect(startSession(session('s2'), options({ env: { ...ON, OMC_JEV_GUARD_MIN_TIMEOUT_S: '6' } }))).toContain('at least 6 s');
  });
});

describe('(b) changes after the session started', () => {
  beforeEach(() => writeHooks(60));

  it('is silent while nothing changed and reports a hooks.json change once it was shown', () => {
    expect(startSession(session(), options())).toBeNull();
    expect(promptCheck(session(), options())).toBeNull();
    writeHooks(60, { extra: 1 });
    const first = promptCheck(session(), options());
    expect(first.text).toContain('hooks/hooks.json');
    expect(first.text).toContain('Restart the session');
    // not shown yet: the next prompt reports it again
    expect(promptCheck(session(), options()).text).toBe(first.text);
    first.confirm();
    expect(promptCheck(session(), options())).toBeNull();
    writeHooks(60, { extra: 2 });
    expect(promptCheck(session(), options()).text).toContain('hooks/hooks.json');
  });

  it('does not report a rewrite with the same content', () => {
    startSession(session(), options());
    writeHooks(60);
    expect(promptCheck(session(), options())).toBeNull();
  });

  it('reports a change of OMC_*, ANTHROPIC_* or TYPESAFE_* variables in settings.json, never storing their values', () => {
    writeSettings({ OMC_JEV: 'model-routing:active', ANTHROPIC_API_KEY: 'sk-first-secret' }, { theme: 'dark' });
    startSession(session(), options());
    expect(promptCheck(session(), options())).toBeNull();
    writeSettings({ OMC_JEV: 'model-routing:active', ANTHROPIC_API_KEY: 'sk-second-secret' }, { theme: 'dark' });
    const change = promptCheck(session(), options());
    expect(change.text).toContain('OMC_*, ANTHROPIC_* or TYPESAFE_*');
    expect(change.text).not.toContain('hooks/hooks.json');
    change.confirm();
    expect(promptCheck(session(), options())).toBeNull();
    const stored = readFileSync(join(configDir, '.omc', 'state', 'sessions', 's1', 'jev-guard-state.json'), 'utf8');
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('model-routing');
  });

  it('reports a change of the Claude Code model-routing variables, never storing their values', () => {
    for (const [key, before, after] of [
      ['CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'us.anthropic.claude-sonnet-first', 'us.anthropic.claude-sonnet-second'],
      ['CLAUDE_CODE_USE_BEDROCK', '1', '0'],
      ['CLAUDE_CODE_SUBAGENT_MODEL', 'model-first', 'model-second'],
      ['CLAUDE_MODEL', 'model-first', 'model-second'],
    ]) {
      const id = `routing-${key}`;
      writeSettings({ [key]: before });
      startSession(session(id), options());
      expect(promptCheck(session(id), options())).toBeNull();
      writeSettings({ [key]: after });
      const change = promptCheck(session(id), options());
      expect(change, key).not.toBeNull();
      expect(change.text).toContain('model-routing variables');
      change.confirm();
      expect(promptCheck(session(id), options())).toBeNull();
      const stored = readFileSync(join(configDir, '.omc', 'state', 'sessions', id, 'jev-guard-state.json'), 'utf8');
      expect(stored).not.toContain('first');
      expect(stored).not.toContain('second');
    }
    // a setting that is not about routing stays silent
    writeSettings({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000' });
    startSession(session('other'), options());
    writeSettings({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2000' });
    expect(promptCheck(session('other'), options())).toBeNull();
  });

  it('ignores other settings.json content and other env keys', () => {
    writeSettings({ OMC_JEV: 'model-routing:active', EDITOR: 'vim' }, { theme: 'dark' });
    startSession(session(), options());
    writeSettings({ OMC_JEV: 'model-routing:active', EDITOR: 'nano' }, { theme: 'light', model: 'opus' });
    expect(promptCheck(session(), options())).toBeNull();
    expect(settingsEnvHash(join(root, 'nowhere'))).toBe(settingsEnvHash(join(root, 'elsewhere'))); // a missing file hashes as empty
    writeFileSync(join(configDir, 'settings.json'), '{ half written');
    expect(settingsEnvHash(configDir)).toBeNull();
    expect(promptCheck(session(), options())).toBeNull(); // no verdict from an unreadable file
  });

  it('reports the removal of the Jev key from the env of settings.json', () => {
    writeSettings({ TYPESAFE_API_KEY: 'key-one' });
    startSession(session(), options());
    writeSettings({});
    expect(promptCheck(session(), options()).text).toContain('TYPESAFE_*');
  });

  it('takes the baseline of a part that could not be read at session start from the first prompt where it reads', () => {
    writeFileSync(join(configDir, 'settings.json'), '{ half written');
    startSession(session(), options());
    expect(promptCheck(session(), options())).toBeNull();
    writeSettings({ OMC_JEV: 'model-routing:active' }); // readable now: this becomes the baseline, not a change
    expect(promptCheck(session(), options())).toBeNull();
    writeSettings({ OMC_JEV: 'all:active' });
    expect(promptCheck(session(), options()).text).toContain('settings.json');
  });

  it('gives a session without a record its baseline at the first prompt', () => {
    expect(promptCheck(session('late'), options())).toBeNull();
    writeHooks(60, { extra: 1 });
    expect(promptCheck(session('late'), options()).text).toContain('hooks/hooks.json');
  });

  it('keeps the record over /compact and starts over on startup, resume and clear', () => {
    startSession(session(), options());
    writeHooks(60, { extra: 1 });
    startSession(session('s1', 'compact'), options());
    expect(promptCheck(session(), options()).text).toContain('hooks/hooks.json');
    for (const source of ['startup', 'resume', 'clear']) {
      startSession(session('s1', source), options());
      expect(promptCheck(session(), options())).toBeNull();
    }
  });

  it('keeps sessions apart and ignores a prompt without a usable session id', () => {
    startSession(session('a'), options());
    writeHooks(60, { extra: 1 });
    startSession(session('b'), options());
    expect(promptCheck(session('a'), options()).text).toContain('hooks/hooks.json');
    expect(promptCheck(session('b'), options())).toBeNull();
    expect(promptCheck({ session_id: '../escape' }, options())).toBeNull();
    expect(promptCheck({}, options())).toBeNull();
  });
});

describe('the sweep of old session records', () => {
  const DAY = 24 * HOUR;
  const recordPath = (id) => join(configDir, '.omc', 'state', 'sessions', id, 'jev-guard-state.json');
  beforeEach(() => writeHooks(60));

  it('removes a record nobody used for 14 days and keeps a live session\'s baseline, whatever its access time', () => {
    startSession(session('live'), options());
    startSession(session('idle'), options());
    // the live session prompts every few days; the idle one never does
    for (const day of [5, 10]) expect(promptCheck(session('live'), options({ now: NOW + day * DAY }))).toBeNull();
    // the access time must not matter: set it to the far past, keep the modification time the prompt wrote
    const fileMtime = statSync(recordPath('live')).mtime;
    utimesSync(recordPath('live'), new Date(NOW - 60 * DAY), fileMtime);
    const before = readFileSync(recordPath('live'), 'utf8');
    startSession(session('new'), options({ now: NOW + 20 * DAY }));
    expect(existsSync(recordPath('idle'))).toBe(false);
    expect(existsSync(recordPath('live'))).toBe(true);
    expect(readFileSync(recordPath('live'), 'utf8')).toBe(before);
    // the baseline survived: a change since the session start is still reported
    writeHooks(60, { extra: 1 });
    expect(promptCheck(session('live'), options({ now: NOW + 20 * DAY })).text).toContain('hooks/hooks.json');
  });

  it('marks the record as in use by its time only, without rewriting it', () => {
    startSession(session('live'), options());
    const before = readFileSync(recordPath('live'), 'utf8');
    expect(promptCheck(session('live'), options({ now: NOW + 3 * DAY }))).toBeNull();
    expect(Math.abs(statSync(recordPath('live')).mtimeMs - (NOW + 3 * DAY))).toBeLessThan(2); // a file system may round to whole microseconds
    expect(readFileSync(recordPath('live'), 'utf8')).toBe(before);
    // a /compact marks it too, before the sweep that /compact runs: untouched, the record would be 15 days old then
    startSession(session('live', 'compact'), options({ now: NOW + 18 * DAY }));
    expect(Math.abs(statSync(recordPath('live')).mtimeMs - (NOW + 18 * DAY))).toBeLessThan(2);
    expect(existsSync(recordPath('live'))).toBe(true);
  });
});

describe('P2: Reset dedupe when configuration returns to baseline', () => {
  const recordPath = (id) => join(configDir, '.omc', 'state', 'sessions', id, 'jev-guard-state.json');
  beforeEach(() => writeHooks(60));

  it('clears warnedHooks and warnedEnv when configuration returns to baseline (A→B→A→B)', () => {
    // A: initial baseline
    startSession(session(), options());
    expect(promptCheck(session(), options())).toBeNull();
    // B: change detected and confirmed
    writeHooks(45); // different timeout
    let change = promptCheck(session(), options());
    expect(change.text).toContain('hooks/hooks.json');
    change.confirm();
    expect(promptCheck(session(), options())).toBeNull(); // no warning yet
    // A: return to original
    writeHooks(60);
    let record = JSON.parse(readFileSync(recordPath('s1'), 'utf8'));
    expect(record.warnedHooks).not.toBeNull(); // was set to the B hash
    change = promptCheck(session(), options());
    expect(change).toBeNull(); // return to baseline clears the warning
    record = JSON.parse(readFileSync(recordPath('s1'), 'utf8'));
    expect(record.warnedHooks).toBeNull(); // cleared by the reset
    // B again: should warn again
    writeHooks(45);
    change = promptCheck(session(), options());
    expect(change.text).toContain('hooks/hooks.json'); // not suppressed
    change.confirm();
    expect(promptCheck(session(), options())).toBeNull();
  });
});

describe('P2: Hash a missing hooks manifest as a changed state', () => {
  const recordPath = (id) => join(configDir, '.omc', 'state', 'sessions', id, 'jev-guard-state.json');

  it('represents hooks.json absence as \'missing\' state, detectable as a change', () => {
    writeHooks(60);
    startSession(session(), options());
    let record = JSON.parse(readFileSync(recordPath('s1'), 'utf8'));
    const initialHash = record.hooks;
    expect(typeof initialHash).toBe('string');
    expect(initialHash).not.toBe('missing');
    expect(initialHash.length).toBe(16); // sha256 digest, truncated to 16 hex chars
    // delete hooks.json: absence is now hashable as 'missing'
    rmSync(join(pluginRoot, 'hooks', 'hooks.json'));
    let change = promptCheck(session(), options());
    expect(change).not.toBeNull();
    expect(change.text).toContain('hooks/hooks.json');
    change.confirm();
    record = JSON.parse(readFileSync(recordPath('s1'), 'utf8'));
    expect(record.warnedHooks).toBe('missing');
    // restoring hooks.json returns to baseline: no new warning
    writeHooks(60);
    expect(promptCheck(session(), options())).toBeNull();
    record = JSON.parse(readFileSync(recordPath('s1'), 'utf8'));
    // warnedHooks is cleared when we return to baseline
    expect(record.warnedHooks).toBeNull();
  });
});

describe('the guard is off unless asked for', () => {
  it('reads and writes nothing without OMC_JEV_GUARD, with Jev off, in shadow mode, or without a key', () => {
    writeHooks(5);
    for (const env of [{ ...ON, OMC_JEV_GUARD: undefined }, { ...ON, OMC_JEV: 'off' }, { ...ON, OMC_JEV: 'model-routing' }, { ...ON, TYPESAFE_API_KEY: '' }]) {
      expect(startSession(session(), options({ env }))).toBeNull();
      expect(promptCheck(session(), options({ env }))).toBeNull();
    }
    expect(existsSync(join(configDir, '.omc'))).toBe(false);
  });
});

/** A Jev log and Claude Code project directories with known contents (see the expectations in the test). */
function writeFixture() {
  const logDir = join(root, 'jev-log');
  mkdirSync(logDir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const row = (id, ms, extra = {}) => JSON.stringify({ ts: iso(ms), point: 'model-routing', mode: 'active', ...(id ? { tool_use_id: id } : {}), answers: { 'model-tier': { type: 'choice', choice: 'Opus' }, effort: { type: 'score', score: 2 } }, ...extra });
  const shadow = [
    ...['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => row(id, NOW - 3 * HOUR)),
    row('d7', NOW - 3 * HOUR), // agent ran on sonnet
    row('d8', NOW - 3 * HOUR), // agent ran on sonnet
    row('d9', NOW - 3 * HOUR), // no agent found
    row(null, NOW - 3 * HOUR), // no tool_use_id: skipped
    row('s1', NOW - 3 * HOUR, { mode: 'shadow' }), // shadow mode: skipped
    row('p1', NOW - 3 * HOUR, { point: 'slop-warning' }), // other point: skipped
    row('old', NOW - 30 * HOUR), // outside the window
    row('fresh', NOW - 30 * 1000), // too young to have an agent
    'not json "model-routing" "active"',
  ];
  writeFileSync(join(logDir, 'shadow.jsonl'), shadow.join('\n') + '\n');
  writeFileSync(join(logDir, 'shadow-20261110-090000-4242.jsonl'), row('d6', NOW - 2 * HOUR) + '\n'); // a rotated file
  const sessionDir = join(configDir, 'projects', 'proj', 'sess');
  const nested = join(sessionDir, 'subagents', 'workflows', 'w1');
  mkdirSync(nested, { recursive: true });
  const meta = (id, model) => JSON.stringify({ toolUseId: id, model, agentType: 'executor' });
  for (const id of ['d1', 'd2']) writeFileSync(join(sessionDir, 'subagents', `agent-${id}.meta.json`), meta(id, 'opus'));
  writeFileSync(join(sessionDir, 'subagents', 'agent-d3.meta.json'), meta('d3', 'claude-opus-4-8')); // the resolved id of the alias
  writeFileSync(join(sessionDir, 'subagents', 'agent-d4.meta.json'), meta('d4', 'Claude-Opus-4-8[1m]'));
  writeFileSync(join(nested, 'agent-d5.meta.json'), meta('d5', 'opus')); // an agent spawned by an agent sits deeper
  writeFileSync(join(sessionDir, 'subagents', 'agent-d6.meta.json'), meta('d6', 'opus'));
  writeFileSync(join(sessionDir, 'subagents', 'agent-d7.meta.json'), meta('d7', 'sonnet'));
  writeFileSync(join(sessionDir, 'subagents', 'agent-d8.meta.json'), meta('d8', 'sonnet'));
  const hook = (name, id, ms, timedOut = true, command = 'command hook 1') => JSON.stringify({ type: 'attachment', timestamp: iso(ms), attachment: { type: 'hook_cancelled', hookName: name, toolUseID: id, hookEvent: name.split(':')[0], command, durationMs: 5100, timedOut, timeoutMs: 5000 } });
  writeFileSync(join(configDir, 'projects', 'proj', 'sess.jsonl'), [
    hook('PreToolUse:Agent', 't1', NOW - 5 * HOUR),
    hook('PreToolUse:Agent', 't2', NOW - 4 * HOUR),
    hook('PreToolUse:Bash', 't3', NOW - 4 * HOUR),
    hook('PostToolUse:Read', 't4', NOW - 4 * HOUR), // not a PreToolUse hook
    hook('PreToolUse:Agent', 't5', NOW - 4 * HOUR, false), // finished in time
    hook('PreToolUse:Agent', 't6', NOW - 40 * HOUR), // outside the window
    hook('PreToolUse:Agent', 't7', NOW - 4 * HOUR, true, 'node "/plugins/other/scripts/toolgate.mjs"'), // another plugin's hook on the same event
    hook('PreToolUse:Agent', 't8', NOW - 4 * HOUR, true, 'node "/plugins/omc/scripts/run.cjs" "/plugins/omc/scripts/pre-tool-enforcer.mjs"'), // named by its command
    hook('PreToolUse:Agent', 't8', NOW - 4 * HOUR, true, 'node "/plugins/other/scripts/toolgate.mjs"'), // a second hook cut on the same call
  ].join('\n') + '\n');
  writeFileSync(join(nested, 'agent-w1.jsonl'), hook('PreToolUse:Agent', 't1', NOW - 5 * HOUR) + '\n'); // the same hook call seen again
  return logDir;
}

describe('(c) the daily figures', () => {
  it('counts delivered decisions and interrupted hooks on known data', async () => {
    const logDir = writeFixture();
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: {} });
    expect(result).toMatchObject({
      ts: NOW,
      windowHours: 24,
      decisions: 9, // d1-d9; skipped: no id, shadow mode, other point, too old, too young
      withAgent: 8, // d9 has no agent
      delivered: 6, // d7 and d8 ran on sonnet although Jev chose opus
      deliveredPercent: 75,
      interruptedAgentHooks: 3, // t1, t2 and t8 (the label of a hook defined with args cannot be told apart and counts as ours)
      interruptedOtherHooks: 3, // t3 (a Bash hook), t7 and the second hook cut on t8 (both another plugin's command)
    });
  });

  it('counts a decision made just before one daily run in the next run', async () => {
    const logDir = join(root, 'carry-logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'shadow.jsonl'), JSON.stringify({ ts: new Date(NOW - 30 * 1000).toISOString(), point: 'model-routing', mode: 'active', tool_use_id: 'tail', answers: { 'model-tier': { type: 'choice', choice: 'opus' } } }) + '\n');
    expect((await computeDelivery({ logDir, configDir, now: NOW, env: {} })).decisions).toBe(0);
    expect((await computeDelivery({ logDir, configDir, now: NOW + 24 * HOUR, env: {} })).decisions).toBe(1);
    expect((await computeDelivery({ logDir, configDir, now: NOW + 48 * HOUR, env: {} })).decisions).toBe(0);
  });

  it('matches the model by word, not by substring', async () => {
    const logDir = writeFixture();
    const sessionDir = join(configDir, 'projects', 'proj', 'sess');
    writeFileSync(join(sessionDir, 'subagents', 'agent-d1.meta.json'), JSON.stringify({ toolUseId: 'd1', model: 'opusx' }));
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: {} });
    expect(result.delivered).toBe(5);
  });

  describe('the model a tier resolves to', () => {
    /** One decision for `wanted`, one agent that ran on `actual`; true when the share counts it as delivered under `env`. */
    async function deliveredFor(wanted, actual, env = {}) {
      const logDir = join(root, 'jev-log');
      mkdirSync(logDir, { recursive: true });
      const row = { ts: new Date(NOW - 3 * HOUR).toISOString(), point: 'model-routing', mode: 'active', tool_use_id: 'x1', answers: { 'model-tier': { type: 'choice', choice: wanted } } };
      writeFileSync(join(logDir, 'shadow.jsonl'), JSON.stringify(row) + '\n');
      const subagents = join(configDir, 'projects', 'proj', 'sess', 'subagents');
      mkdirSync(subagents, { recursive: true });
      writeFileSync(join(subagents, 'agent-x1.meta.json'), JSON.stringify({ toolUseId: 'x1', model: actual }));
      const result = await computeDelivery({ logDir, configDir, now: NOW, env });
      expect(result.withAgent).toBe(1);
      return result.delivered === 1;
    }

    it('counts the id a tier is configured to as delivered, from any of the tier variables', async () => {
      expect(await deliveredFor('sonnet', 'kimi-k2.6:cloud', { ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.6:cloud' })).toBe(true);
      expect(await deliveredFor('Sonnet', 'KIMI-K2.6:cloud[1m]', { ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.6:cloud' })).toBe(true);
      expect(await deliveredFor('opus', 'us.anthropic.claude-x-v1:0', { CLAUDE_CODE_BEDROCK_OPUS_MODEL: 'us.anthropic.claude-x-v1:0' })).toBe(true);
      expect(await deliveredFor('haiku', 'glm-5', { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5' })).toBe(true);
      expect(await deliveredFor('fable', 'fable-proxy-1', { ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable-proxy-1' })).toBe(true);
    });

    it('takes the first tier variable that is set, in the order Claude Code reads them', async () => {
      const env = { CLAUDE_CODE_BEDROCK_SONNET_MODEL: 'bedrock-model-a', ANTHROPIC_DEFAULT_SONNET_MODEL: 'proxy-model-b' };
      expect(await deliveredFor('sonnet', 'bedrock-model-a', env)).toBe(true);
      expect(await deliveredFor('sonnet', 'proxy-model-b', env)).toBe(false);
    });

    it('does not count another tier\'s model, an unconfigured provider model, or a shared first word', async () => {
      const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.6:cloud', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8' };
      expect(await deliveredFor('sonnet', 'kimi-k2.6:cloud', {})).toBe(false); // no configuration for the tier
      expect(await deliveredFor('opus', 'kimi-k2.6:cloud', env)).toBe(false); // it is sonnet's model
      expect(await deliveredFor('haiku', 'claude-opus-4-8', env)).toBe(false); // same first word "claude", another tier
      expect(await deliveredFor('haiku', 'claude-sonnet-5', env)).toBe(false);
      expect(await deliveredFor('sonnet', 'kimi', env)).toBe(false); // a part of the configured id is not the id
      expect(await deliveredFor('opus', 'opusx', env)).toBe(false);
      expect(await deliveredFor('opus', '', env)).toBe(false);
    });

    it('ignores the OMC-internal override, which Claude Code does not read for an alias', async () => {
      // the agent inherited the session model: the override must not turn that into a delivery of any tier
      const env = { OMC_SUBAGENT_MODEL: 'inherited-model', OMC_MODEL_LOW: 'inherited-model' };
      for (const tier of ['haiku', 'sonnet', 'opus', 'fable']) expect(await deliveredFor(tier, 'inherited-model', env)).toBe(false);
    });

    it('survives a tier name that is no tier', async () => {
      for (const tier of ['constructor', 'toString', '__proto__']) expect(await deliveredFor(tier, 'some-model', {})).toBe(false);
    });

    it('still matches the alias and a full id with the tier as a whole word', async () => {
      expect(await deliveredFor('opus', 'opus')).toBe(true);
      expect(await deliveredFor('opus', 'claude-opus-4-8')).toBe(true);
      expect(await deliveredFor('haiku', 'claude-opus-4-8')).toBe(false);
    });
  });

  it('does not compute a share under forceInherit', async () => {
    const logDir = writeFixture();
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: { OMC_ROUTING_FORCE_INHERIT: 'true' } });
    expect(result).toMatchObject({ decisions: 0, deliveredPercent: null, interruptedAgentHooks: 3 });
  });

  it('reports interruptions without a share when the log has no tool_use_id', async () => {
    const logDir = writeFixture();
    for (const name of readdirSync(logDir)) if (name !== 'shadow.jsonl') rmSync(join(logDir, name));
    writeFileSync(join(logDir, 'shadow.jsonl'), JSON.stringify({ ts: new Date(NOW - HOUR).toISOString(), point: 'model-routing', mode: 'active', answers: { 'model-tier': { type: 'choice', choice: 'opus' } } }) + '\n');
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: {} });
    expect(result).toMatchObject({ decisions: 0, withAgent: 0, deliveredPercent: null, interruptedAgentHooks: 3 });
    expect(deliveryMessage(result)).toContain('no active model-routing decision could be matched to an agent');
  });

  it('handles a missing log directory and missing project directories', async () => {
    const result = await computeDelivery({ logDir: join(root, 'none'), configDir: join(root, 'no-config'), now: NOW });
    expect(result).toMatchObject({ decisions: 0, deliveredPercent: null, interruptedAgentHooks: 0, interruptedOtherHooks: 0 });
    expect(deliveryMessage(result)).toBeNull();
  });

  it('turns the figures into a message only when something is wrong', () => {
    const base = { ts: NOW, windowHours: 24, decisions: 100, withAgent: 100, delivered: 100, deliveredPercent: 100, interruptedAgentHooks: 0, interruptedOtherHooks: 0 };
    expect(deliveryMessage(base)).toBeNull();
    expect(deliveryMessage({ ...base, delivered: 95, deliveredPercent: 95 })).toBeNull();
    expect(deliveryMessage({ ...base, delivered: 94, deliveredPercent: 94 })).toContain('94 of 100 Jev model decisions reached the agent (94 %');
    expect(deliveryMessage({ ...base, interruptedAgentHooks: 3, interruptedOtherHooks: 1 })).toMatch(/interrupted: 3 \(hooks of other commands: 1\)/);
    expect(deliveryMessage({ ...base, interruptedOtherHooks: 4 })).toBeNull(); // only PreToolUse:Agent raises the alarm
    expect(deliveryMessage({ ts: NOW, error: 'EACCES' })).toContain('daily check failed (EACCES)');
    expect(deliveryMessage(null)).toBeNull();
  });

  it('compares the unrounded delivery rate with the alert threshold at the 95% boundary', () => {
    // 113/119 = 94.957983..%, rounds to 95%, but is below the 95% alert threshold
    // This test verifies that deliveryMessage compares the unrounded rate, not the displayed rounded percent
    const base = { ts: NOW, windowHours: 24, decisions: 119, withAgent: 119, delivered: 113, deliveredPercentFull: 94.957983, deliveredPercent: 95, interruptedAgentHooks: 0, interruptedOtherHooks: 0 };
    expect(deliveryMessage(base)).toContain('113 of 119 Jev model decisions reached the agent (95 %');
  });

  it('runs as a detached-style process and writes delivery.json', () => {
    const logDir = writeFixture();
    const run = spawnSync(NODE, [GUARD_SCRIPT, '--daily', '--config', configDir, '--log', logDir, '--now', new Date(NOW).toISOString(), '--print'], { encoding: 'utf8', timeout: 20000 });
    expect(run.status).toBe(0);
    const printed = JSON.parse(run.stdout);
    expect(printed).toMatchObject({ decisions: 9, delivered: 6, deliveredPercent: 75, interruptedAgentHooks: 3 });
    expect(existsSync(dailyStatePath(configDir, logDir, 'delivery.json'))).toBe(false); // a run by hand leaves the state alone
    const written = spawnSync(NODE, [GUARD_SCRIPT, '--daily', '--write', '--config', configDir, '--log', logDir, '--now', new Date(NOW).toISOString()], { encoding: 'utf8', timeout: 20000 });
    expect(written.status).toBe(0);
    expect(JSON.parse(readFileSync(dailyStatePath(configDir, logDir, 'delivery.json'), 'utf8'))).toEqual(printed);
  });

  it('falls back to a 24 hour window for a window that is not a positive number', () => {
    const logDir = writeFixture();
    const run = spawnSync(NODE, [GUARD_SCRIPT, '--daily', '--print', '--config', configDir, '--log', logDir, '--now', new Date(NOW).toISOString(), '--window-hours', 'abc'], { encoding: 'utf8', timeout: 20000 });
    expect(JSON.parse(run.stdout)).toMatchObject({ windowHours: 24, decisions: 9 });
  });

  it('shows a bad result once per session at the next prompt', () => {
    writeHooks(60);
    const logDir = join(root, 'jev-log');
    mkdirSync(dirname(dailyStatePath(configDir, logDir, 'daily.json')), { recursive: true });
    writeFileSync(dailyStatePath(configDir, logDir, 'daily.json'), JSON.stringify({ lastStart: NOW })); // no new daily check now
    startSession(session(), options());
    startSession(session('other'), options());
    const bad = { ts: NOW - HOUR, windowHours: 24, decisions: 9, withAgent: 8, delivered: 6, deliveredPercent: 75, interruptedAgentHooks: 2, interruptedOtherHooks: 0 };
    writeFileSync(dailyStatePath(configDir, logDir, 'delivery.json'), JSON.stringify(bad));
    const shown = promptCheck(session(), options({ logDir }));
    expect(shown.text).toContain('6 of 8 Jev model decisions reached the agent (75 %');
    shown.confirm();
    expect(promptCheck(session(), options({ logDir }))).toBeNull();
    expect(promptCheck(session('other'), options({ logDir })).text).toContain('75 %');
    // the result belongs to that Jev log directory only
    writeFileSync(dailyStatePath(configDir, join(root, 'other-log'), 'daily.json'), JSON.stringify({ lastStart: NOW }));
    expect(promptCheck(session('other'), options({ logDir: join(root, 'other-log') }))).toBeNull();
  });

  it('does not show a result older than two days', () => {
    writeHooks(60);
    const logDir = join(root, 'jev-log');
    mkdirSync(dirname(dailyStatePath(configDir, logDir, 'daily.json')), { recursive: true });
    writeFileSync(dailyStatePath(configDir, logDir, 'daily.json'), JSON.stringify({ lastStart: NOW }));
    startSession(session(), options());
    writeFileSync(dailyStatePath(configDir, logDir, 'delivery.json'), JSON.stringify({ ts: NOW - 49 * HOUR, windowHours: 24, decisions: 0, withAgent: 0, delivered: 0, deliveredPercent: null, interruptedAgentHooks: 5, interruptedOtherHooks: 0 }));
    expect(promptCheck(session(), options({ logDir }))).toBeNull();
    writeFileSync(dailyStatePath(configDir, logDir, 'delivery.json'), JSON.stringify({ ts: NOW - 47 * HOUR, windowHours: 24, decisions: 0, withAgent: 0, delivered: 0, deliveredPercent: null, interruptedAgentHooks: 5, interruptedOtherHooks: 0 }));
    expect(promptCheck(session(), options({ logDir })).text).toContain('interrupted: 5');
  });

  it('starts the daily process at most once per 24 hours', async () => {
    writeHooks(60);
    startSession(session(), options());
    const logDir = join(root, 'jev-log');
    const state = (kind) => dailyStatePath(configDir, logDir, kind);
    const start = Date.now();
    promptCheck(session(), options({ now: start, logDir, env: { ...process.env, ...ON } }));
    expect(JSON.parse(readFileSync(state('daily.json'), 'utf8')).lastStart).toBe(start);
    // the process writes the result first and releases its lock after
    for (let i = 0; i < 150 && (!existsSync(state('delivery.json')) || existsSync(state('daily.lock'))); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const result = JSON.parse(readFileSync(state('delivery.json'), 'utf8'));
    expect(result).toMatchObject({ decisions: 0, deliveredPercent: null, interruptedAgentHooks: 0 });
    expect(existsSync(state('daily.lock'))).toBe(false);
    promptCheck(session(), options({ now: start + 23 * HOUR, logDir }));
    expect(JSON.parse(readFileSync(state('daily.json'), 'utf8')).lastStart).toBe(start);
  });
});

describe('regression coverage for the review findings', () => {
  const guardState = () => join(configDir, '.omc', 'jev-delivery');
  const badResult = (ts, interrupted) => ({ ts, windowHours: 24, decisions: 0, withAgent: 0, delivered: 0, deliveredPercent: null, interruptedAgentHooks: interrupted, interruptedOtherHooks: 0 });

  it('stays inactive for a plan-mode hook when OMC_JEV_PLAN_MODE turns routing off or to shadow', () => {
    writeHooks(5);
    const input = { ...session('plan'), permission_mode: 'plan' };
    for (const mode of ['off', 'shadow']) {
      const env = { ...ON, OMC_JEV_PLAN_MODE: mode };
      expect(startSession(input, options({ env }))).toBeNull();
      expect(promptCheck(input, options({ env, logDir: join(root, 'jev-log') }))).toBeNull();
    }
    expect(existsSync(guardState())).toBe(false);
    // the same hooks outside plan mode, and in plan mode without the override, still warn
    expect(startSession(session('normal'), options())).toContain('5 s');
    expect(startSession(input, options({ env: { ...ON, OMC_JEV_PLAN_MODE: 'active' } }))).toContain('5 s');
  });

  it('counts a timed-out legacy PreToolUse:Task hook as an interrupted agent hook', async () => {
    const sessionDir = join(configDir, 'projects', 'proj');
    mkdirSync(sessionDir, { recursive: true });
    const hook = (name, id) => JSON.stringify({ type: 'attachment', timestamp: new Date(NOW - 2 * HOUR).toISOString(), attachment: { type: 'hook_cancelled', hookName: name, toolUseID: id, command: 'node "/plugins/omc/scripts/pre-tool-enforcer.mjs"', timedOut: true } });
    writeFileSync(join(sessionDir, 'sess.jsonl'), [hook('PreToolUse:Task', 'k1'), hook('PreToolUse:Agent', 'k2'), hook('PreToolUse:Bash', 'k3')].join('\n') + '\n');
    const result = await computeDelivery({ logDir: join(root, 'none'), configDir, now: NOW, env: {} });
    expect(result).toMatchObject({ interruptedAgentHooks: 2, interruptedOtherHooks: 1 });
    // a Task-only result still raises the alarm
    const taskOnly = { ...result, interruptedAgentHooks: 1, interruptedOtherHooks: 0 };
    expect(deliveryMessage(taskOnly)).toContain('PreToolUse:Agent hooks interrupted: 1');
  });

  it('computes 113 of 119 delivered decisions as a warning, not as 95 %', async () => {
    const logDir = join(root, 'jev-log');
    mkdirSync(logDir, { recursive: true });
    const sessionDir = join(configDir, 'projects', 'proj', 'sess', 'subagents');
    mkdirSync(sessionDir, { recursive: true });
    const rows = [];
    for (let i = 0; i < 119; i++) {
      rows.push(JSON.stringify({ ts: new Date(NOW - 3 * HOUR).toISOString(), point: 'model-routing', mode: 'active', tool_use_id: `b${i}`, answers: { 'model-tier': { choice: 'opus' } } }));
      writeFileSync(join(sessionDir, `agent-b${i}.meta.json`), JSON.stringify({ toolUseId: `b${i}`, model: i < 113 ? 'opus' : 'sonnet' }));
    }
    writeFileSync(join(logDir, 'shadow.jsonl'), rows.join('\n') + '\n');
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: {} });
    expect(result).toMatchObject({ withAgent: 119, delivered: 113, deliveredPercent: 95 });
    expect(deliveryMessage(result)).toContain('113 of 119 Jev model decisions reached the agent (95 %');
  });

  it('startDailyCheck leaves a slot another session already claimed: no worker, no new timestamp, lock released', () => {
    const logDir = join(root, 'jev-log');
    const dir = guardState();
    mkdirSync(dir, { recursive: true });
    const claimed = NOW - 5 * 60 * 1000;
    writeFileSync(dailyStatePath(configDir, logDir, 'daily.json'), JSON.stringify({ lastStart: claimed }));
    startDailyCheck(dir, configDir, logDir, { ...process.env }, NOW); // the caller saw the state before the claim
    expect(JSON.parse(readFileSync(dailyStatePath(configDir, logDir, 'daily.json'), 'utf8')).lastStart).toBe(claimed);
    expect(existsSync(dailyStatePath(configDir, logDir, 'daily.lock'))).toBe(false);
    expect(existsSync(dailyStatePath(configDir, logDir, 'delivery.json'))).toBe(false);
  });

  describe('a daily worker that cannot be started', () => {
    const failingSpawns = {
      'throws while spawning': () => { throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }); },
      'reports an error event': () => {
        const handlers = {};
        setTimeout(() => handlers.error?.(Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })), 0);
        return { on: (name, fn) => { handlers[name] = fn; }, unref: () => {} };
      },
    };
    for (const [label, spawnWorker] of Object.entries(failingSpawns)) {
      it(`gives the slot of the day back when the spawn ${label}`, async () => {
        const logDir = join(root, 'jev-log');
        const dir = guardState();
        mkdirSync(dir, { recursive: true });
        const older = NOW - 2 * 24 * HOUR; // a finished slot of an earlier day
        writeFileSync(dailyStatePath(configDir, logDir, 'daily.json'), JSON.stringify({ lastStart: older }));
        startDailyCheck(dir, configDir, logDir, { ...process.env }, NOW, spawnWorker);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(JSON.parse(readFileSync(dailyStatePath(configDir, logDir, 'daily.json'), 'utf8')).lastStart).toBe(older);
        expect(existsSync(dailyStatePath(configDir, logDir, 'daily.lock'))).toBe(false);
      });
    }

    it('removes the new timestamp when there was no earlier state', async () => {
      const logDir = join(root, 'jev-log');
      const dir = guardState();
      mkdirSync(dir, { recursive: true });
      startDailyCheck(dir, configDir, logDir, { ...process.env }, NOW, failingSpawns['throws while spawning']);
      expect(existsSync(dailyStatePath(configDir, logDir, 'daily.json'))).toBe(false);
      expect(existsSync(dailyStatePath(configDir, logDir, 'daily.lock'))).toBe(false);
    });
  });

  describe('a relative OMC_JEV_LOG_DIR in two working directories', () => {
    it('keeps daily state and displayed-report acknowledgments apart, including an older report in the second project', () => {
      writeHooks(60);
      const cwdA = join(root, 'proj-a');
      const cwdB = join(root, 'proj-b');
      mkdirSync(cwdA, { recursive: true });
      mkdirSync(cwdB, { recursive: true });
      startSession(session(), options());
      const seed = (cwd, ts, interrupted) => {
        mkdirSync(guardState(), { recursive: true });
        writeFileSync(dailyStatePath(configDir, 'logs', 'daily.json', cwd), JSON.stringify({ lastStart: NOW })); // no new daily check
        writeFileSync(dailyStatePath(configDir, 'logs', 'delivery.json', cwd), JSON.stringify(badResult(ts, interrupted)));
      };
      expect(dailyStatePath(configDir, 'logs', 'daily.json', cwdA)).not.toBe(dailyStatePath(configDir, 'logs', 'daily.json', cwdB));
      seed(cwdA, NOW - HOUR, 2);
      seed(cwdB, NOW - 5 * HOUR, 7); // older than the report of A
      const shownA = promptCheck(session(), options({ logDir: 'logs', cwd: cwdA }));
      expect(shownA.text).toContain('interrupted: 2');
      shownA.confirm();
      expect(promptCheck(session(), options({ logDir: 'logs', cwd: cwdA }))).toBeNull();
      const shownB = promptCheck(session(), options({ logDir: 'logs', cwd: cwdB }));
      expect(shownB.text).toContain('interrupted: 7');
      shownB.confirm();
      expect(promptCheck(session(), options({ logDir: 'logs', cwd: cwdB }))).toBeNull();
    });

    it('uses one key for an absolute path whatever the working directory, and a different one for a relative path', () => {
      const key = (logDir, cwd) => dailyStatePath(configDir, logDir, 'daily.json', cwd);
      const absolute = join(root, 'shared-log');
      expect(key(absolute, join(root, 'x'))).toBe(key(absolute, join(root, 'y')));
      expect(key('logs', join(root, 'x'))).toBe(key(join(root, 'x', 'logs'), join(root, 'y')));
      expect(key('logs', join(root, 'x'))).not.toBe(key('logs', join(root, 'y')));
    });

    it.runIf(process.platform === 'win32')('treats a UNC log directory as absolute', () => {
      const unc = '\\\\server\\share\\logs';
      expect(dailyStatePath(configDir, unc, 'daily.json', 'C:\\a')).toBe(dailyStatePath(configDir, unc, 'daily.json', 'C:\\b'));
    });
  });

  describe('a manual --daily run without --log', () => {
    const run = (args, cwd, extraEnv) => spawnSync(NODE, [GUARD_SCRIPT, '--daily', '--config', configDir, '--now', new Date(NOW).toISOString(), ...args], { cwd, encoding: 'utf8', timeout: 20000, env: { ...process.env, OMC_STATE_DIR: '', OMC_DISABLE_MULTIREPO: '1', OMC_JEV_LOG_DIR: '', ...extraEnv } });

    it('scans OMC_JEV_LOG_DIR and writes the report under that directory\'s key', () => {
      const logDir = writeFixture();
      const output = run(['--print', '--write'], root, { OMC_JEV_LOG_DIR: logDir });
      expect(output.status).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ decisions: 9, delivered: 6, deliveredPercent: 75 });
      const written = JSON.parse(readFileSync(dailyStatePath(configDir, logDir, 'delivery.json'), 'utf8'));
      expect(written).toMatchObject({ decisions: 9, delivered: 6 });
      expect(existsSync(dailyStatePath(configDir, undefined, 'delivery.json'))).toBe(false); // not the empty-directory key
      // ... and the next prompt of a session in that project consumes it
      writeHooks(60);
      writeFileSync(dailyStatePath(configDir, logDir, 'daily.json'), JSON.stringify({ lastStart: NOW }));
      startSession(session(), options({ now: NOW - 3 * HOUR }));
      expect(promptCheck(session(), options({ logDir })).text).toContain('6 of 8 Jev model decisions reached the agent (75 %');
    });

    it('scans the project default log directory when neither --log nor OMC_JEV_LOG_DIR is given', () => {
      const logDir = writeFixture();
      const project = join(root, 'project-default');
      mkdirSync(project, { recursive: true });
      execFileSync('git', ['init', '--quiet'], { cwd: project, stdio: 'ignore' });
      const defaultDir = join(project, '.omc', 'state', 'jev');
      mkdirSync(defaultDir, { recursive: true });
      for (const name of readdirSync(logDir)) writeFileSync(join(defaultDir, name), readFileSync(join(logDir, name)));
      const output = run(['--print', '--write'], project, {});
      expect(output.status).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ decisions: 9, delivered: 6 });
      expect(JSON.parse(readFileSync(dailyStatePath(configDir, defaultDir, 'delivery.json'), 'utf8'))).toMatchObject({ decisions: 9 });
    });
  });
});

describe('the hook scripts', () => {
  let project;
  let home;

  beforeEach(() => {
    project = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: project, stdio: 'ignore' });
    // keep the daily check out of these runs
    mkdirSync(dirname(dailyStatePath(configDir, join(root, 'jev-log'), 'daily.json')), { recursive: true });
    writeFileSync(dailyStatePath(configDir, join(root, 'jev-log'), 'daily.json'), JSON.stringify({ lastStart: Date.now() }));
  });

  const scriptEnv = (extra = {}) => ({
    ...process.env,
    NODE_ENV: 'test',
    DISABLE_OMC: '',
    OMC_SKIP_HOOKS: '',
    OMC_TEAM_WORKER: '',
    OMC_STATE_DIR: '',
    CLAUDE_PLUGIN_ROOT: '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    OMC_JEV_LOG_DIR: join(root, 'jev-log'),
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: 'model-routing:active',
    OMC_JEV_GUARD: '1',
    ...extra,
  });

  const runHook = (script, input, extra) => JSON.parse(execFileSync(NODE, [script], { cwd: input.cwd, input: JSON.stringify(input), encoding: 'utf8', env: scriptEnv(extra), timeout: 30000 }).trim());
  const prompt = (id = 'hook-session', text = 'hello there') => ({ hook_event_name: 'UserPromptSubmit', cwd: project, session_id: id, prompt: text });

  it('keyword-detector adds the restart message once, as systemMessage', () => {
    writeSettings({ OMC_JEV: 'model-routing:active' });
    const first = runHook(KEYWORD_DETECTOR, prompt());
    expect(first.systemMessage).toBeUndefined();
    writeSettings({ OMC_JEV: 'all:active' });
    const changed = runHook(KEYWORD_DETECTOR, prompt());
    expect(changed.continue).toBe(true);
    expect(changed.suppressOutput).toBeUndefined();
    expect(changed.systemMessage).toContain('Jev delivery guard');
    expect(changed.systemMessage).toContain('OMC_*, ANTHROPIC_* or TYPESAFE_*');
    expect(runHook(KEYWORD_DETECTOR, prompt()).systemMessage).toBeUndefined();
  });

  it('keyword-detector is unchanged without OMC_JEV_GUARD', () => {
    writeSettings({ OMC_JEV: 'model-routing:active' });
    const env = { OMC_JEV_GUARD: '' };
    runHook(KEYWORD_DETECTOR, prompt(), env);
    writeSettings({ OMC_JEV: 'all:active' });
    const output = runHook(KEYWORD_DETECTOR, prompt(), env);
    expect(output.systemMessage).toBeUndefined();
    expect(existsSync(join(configDir, '.omc', 'state', 'sessions'))).toBe(false);
  });

  it('session-start reports a short pre-tool-enforcer timeout and records the session', () => {
    const start = (extra) => runHook(SESSION_START, { hook_event_name: 'SessionStart', cwd: project, session_id: 'start-session', source: 'startup' }, extra);
    expect(start({ OMC_JEV_GUARD_MIN_TIMEOUT_S: '100000' }).systemMessage).toMatch(/Jev delivery guard: the PreToolUse timeout of pre-tool-enforcer/);
    expect(existsSync(join(configDir, '.omc', 'state', 'sessions', 'start-session', 'jev-guard-state.json'))).toBe(true);
    expect(start({ OMC_JEV_GUARD_MIN_TIMEOUT_S: '1' }).systemMessage ?? '').not.toContain('Jev delivery guard');
    expect(start({ OMC_JEV_GUARD: '', OMC_JEV_GUARD_MIN_TIMEOUT_S: '100000' }).systemMessage ?? '').not.toContain('Jev delivery guard');
  });

  it('session-start reports it outside a workspace too', () => {
    const bare = join(root, 'bare'); // a directory with no .git or .omc-workspace marker above it
    mkdirSync(bare, { recursive: true });
    const output = runHook(SESSION_START, { hook_event_name: 'SessionStart', cwd: bare, session_id: 'bare-session', source: 'startup' }, { OMC_JEV_GUARD_MIN_TIMEOUT_S: '100000' });
    expect(output.systemMessage).toContain('Jev delivery guard');
  });
});
