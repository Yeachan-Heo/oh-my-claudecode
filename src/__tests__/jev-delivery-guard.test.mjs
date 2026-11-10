/* global process, setTimeout */
/**
 * Tests for the Jev delivery guard (scripts/lib/jev-delivery-guard.mjs, OMC_JEV_GUARD=1) and its
 * wiring in session-start.mjs and keyword-detector.mjs.
 *
 * The library tests drive the functions with a temporary Claude config dir and plugin root; the
 * script tests run the real hook scripts as Claude Code does. Everything runs without the network.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeDelivery,
  deliveryMessage,
  isGuardEnabled,
  limitMessage,
  minTimeoutSeconds,
  preToolTimeout,
  promptCheck,
  settingsEnvHash,
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

  it('reports a change of OMC_* or ANTHROPIC_* variables in settings.json, never storing their values', () => {
    writeSettings({ OMC_JEV: 'model-routing:active', ANTHROPIC_API_KEY: 'sk-first-secret' }, { theme: 'dark' });
    startSession(session(), options());
    expect(promptCheck(session(), options())).toBeNull();
    writeSettings({ OMC_JEV: 'model-routing:active', ANTHROPIC_API_KEY: 'sk-second-secret' }, { theme: 'dark' });
    const change = promptCheck(session(), options());
    expect(change.text).toContain('OMC_* or ANTHROPIC_*');
    expect(change.text).not.toContain('hooks/hooks.json');
    change.confirm();
    expect(promptCheck(session(), options())).toBeNull();
    const stored = readFileSync(join(configDir, '.omc', 'jev-guard', 'sessions', 's1.json'), 'utf8');
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('model-routing');
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
  for (const id of ['d1', 'd2', 'd3', 'd4']) writeFileSync(join(sessionDir, 'subagents', `agent-${id}.meta.json`), meta(id, 'opus'));
  writeFileSync(join(nested, 'agent-d5.meta.json'), meta('d5', 'opus')); // an agent spawned by an agent sits deeper
  writeFileSync(join(sessionDir, 'subagents', 'agent-d6.meta.json'), meta('d6', 'opus'));
  writeFileSync(join(sessionDir, 'subagents', 'agent-d7.meta.json'), meta('d7', 'sonnet'));
  writeFileSync(join(sessionDir, 'subagents', 'agent-d8.meta.json'), meta('d8', 'sonnet'));
  const hook = (name, id, ms, timedOut = true) => JSON.stringify({ type: 'attachment', timestamp: iso(ms), attachment: { type: 'hook_non_blocking_error', hookName: name, toolUseID: id, timedOut } });
  writeFileSync(join(configDir, 'projects', 'proj', 'sess.jsonl'), [
    hook('PreToolUse:Agent', 't1', NOW - 5 * HOUR),
    hook('PreToolUse:Agent', 't2', NOW - 4 * HOUR),
    hook('PreToolUse:Bash', 't3', NOW - 4 * HOUR),
    hook('PostToolUse:Read', 't4', NOW - 4 * HOUR), // not a PreToolUse hook
    hook('PreToolUse:Agent', 't5', NOW - 4 * HOUR, false), // finished in time
    hook('PreToolUse:Agent', 't6', NOW - 40 * HOUR), // outside the window
  ].join('\n') + '\n');
  writeFileSync(join(nested, 'agent-w1.jsonl'), hook('PreToolUse:Agent', 't1', NOW - 5 * HOUR) + '\n'); // the same hook call seen again
  return logDir;
}

describe('(c) the daily figures', () => {
  it('counts delivered decisions and interrupted hooks on known data', async () => {
    const logDir = writeFixture();
    const result = await computeDelivery({ logDir, configDir, now: NOW });
    expect(result).toMatchObject({
      ts: NOW,
      windowHours: 24,
      decisions: 9, // d1-d9; skipped: no id, shadow mode, other point, too old, too young
      withAgent: 8, // d9 has no agent
      delivered: 6, // d7 and d8 ran on sonnet although Jev chose opus
      deliveredPercent: 75,
      interruptedAgentHooks: 2,
      interruptedOtherHooks: 1,
    });
  });

  it('reports interruptions without a share when the log has no tool_use_id', async () => {
    const logDir = writeFixture();
    for (const name of readdirSync(logDir)) if (name !== 'shadow.jsonl') rmSync(join(logDir, name));
    writeFileSync(join(logDir, 'shadow.jsonl'), JSON.stringify({ ts: new Date(NOW - HOUR).toISOString(), point: 'model-routing', mode: 'active', answers: { 'model-tier': { type: 'choice', choice: 'opus' } } }) + '\n');
    const result = await computeDelivery({ logDir, configDir, now: NOW });
    expect(result).toMatchObject({ decisions: 0, withAgent: 0, deliveredPercent: null, interruptedAgentHooks: 2 });
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
    expect(deliveryMessage({ ...base, delivered: 94, deliveredPercent: 94 })).toContain('94 of 100 Jev model decisions reached the agent (94 %)');
    expect(deliveryMessage({ ...base, interruptedAgentHooks: 3, interruptedOtherHooks: 1 })).toMatch(/interrupted: 3 \(other PreToolUse hooks: 1\)/);
    expect(deliveryMessage({ ...base, interruptedOtherHooks: 4 })).toBeNull(); // only PreToolUse:Agent raises the alarm
    expect(deliveryMessage({ ts: NOW, error: 'EACCES' })).toContain('daily check failed (EACCES)');
    expect(deliveryMessage(null)).toBeNull();
  });

  it('runs as a detached-style process and writes delivery.json', () => {
    const logDir = writeFixture();
    const run = spawnSync(NODE, [GUARD_SCRIPT, '--daily', '--config', configDir, '--log', logDir, '--now', new Date(NOW).toISOString(), '--print'], { encoding: 'utf8', timeout: 20000 });
    expect(run.status).toBe(0);
    const printed = JSON.parse(run.stdout);
    expect(printed).toMatchObject({ decisions: 9, delivered: 6, deliveredPercent: 75, interruptedAgentHooks: 2 });
    expect(JSON.parse(readFileSync(join(configDir, '.omc', 'jev-guard', 'delivery.json'), 'utf8'))).toEqual(printed);
  });

  it('shows a bad result once per session at the next prompt', () => {
    writeHooks(60);
    const dir = join(configDir, '.omc', 'jev-guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daily.json'), JSON.stringify({ lastStart: NOW })); // no new daily check now
    startSession(session(), options());
    startSession(session('other'), options());
    writeFileSync(join(dir, 'delivery.json'), JSON.stringify({ ts: NOW - HOUR, windowHours: 24, decisions: 9, withAgent: 8, delivered: 6, deliveredPercent: 75, interruptedAgentHooks: 2, interruptedOtherHooks: 0 }));
    const shown = promptCheck(session(), options());
    expect(shown.text).toContain('6 of 8 Jev model decisions reached the agent (75 %)');
    shown.confirm();
    expect(promptCheck(session(), options())).toBeNull();
    expect(promptCheck(session('other'), options()).text).toContain('75 %');
  });

  it('starts the daily process at most once per 24 hours', async () => {
    writeHooks(60);
    startSession(session(), options());
    const dir = join(configDir, '.omc', 'jev-guard');
    const start = Date.now();
    promptCheck(session(), options({ now: start, env: { ...process.env, ...ON } }));
    expect(JSON.parse(readFileSync(join(dir, 'daily.json'), 'utf8')).lastStart).toBe(start);
    for (let i = 0; i < 100 && !existsSync(join(dir, 'delivery.json')); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const result = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'));
    expect(result).toMatchObject({ decisions: 0, deliveredPercent: null, interruptedAgentHooks: 0 });
    expect(existsSync(join(dir, 'daily.lock'))).toBe(false);
    promptCheck(session(), options({ now: start + 23 * HOUR }));
    expect(JSON.parse(readFileSync(join(dir, 'daily.json'), 'utf8')).lastStart).toBe(start);
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
    const dir = join(configDir, '.omc', 'jev-guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daily.json'), JSON.stringify({ lastStart: Date.now() }));
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
    expect(changed.systemMessage).toContain('OMC_* or ANTHROPIC_*');
    expect(runHook(KEYWORD_DETECTOR, prompt()).systemMessage).toBeUndefined();
  });

  it('keyword-detector is unchanged without OMC_JEV_GUARD', () => {
    writeSettings({ OMC_JEV: 'model-routing:active' });
    const env = { OMC_JEV_GUARD: '' };
    runHook(KEYWORD_DETECTOR, prompt(), env);
    writeSettings({ OMC_JEV: 'all:active' });
    const output = runHook(KEYWORD_DETECTOR, prompt(), env);
    expect(output.systemMessage).toBeUndefined();
    expect(existsSync(join(configDir, '.omc', 'jev-guard', 'sessions'))).toBe(false);
  });

  it('session-start reports a short pre-tool-enforcer timeout and records the session', () => {
    const start = (extra) => runHook(SESSION_START, { hook_event_name: 'SessionStart', cwd: project, session_id: 'start-session', source: 'startup' }, extra);
    expect(start({ OMC_JEV_GUARD_MIN_TIMEOUT_S: '100000' }).systemMessage).toMatch(/Jev delivery guard: the PreToolUse timeout of pre-tool-enforcer/);
    expect(existsSync(join(configDir, '.omc', 'jev-guard', 'sessions', 'start-session.json'))).toBe(true);
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
