/**
 * The named-only Jev point `delegation` (scripts/lib/jev-delegation.mjs) and its branch in the Agent/Task part of
 * scripts/pre-tool-enforcer.mjs: a coordinator session (OMC_SESSION_ROLE=coordinator) is asked whether a call should go
 * to an agent or to a separate background session. The hook never denies and never changes the call because of it; the
 * answer `session` of the active point only adds a hint to additionalContext. The Jev side is a local fake server.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { DELEGATION_QUESTIONS, SESSION_ROLES, decideDelegation, delegationHintText, delegationState, readRunningAgents, sessionRoleFacts } from '../../scripts/lib/jev-delegation.mjs';
import { NAMED_ONLY_POINTS, parseJevEnv } from '../../scripts/jev-resolve.mjs';
import { NAMED_ONLY_POINTS as TS_NAMED_ONLY_POINTS } from '../hooks/jev/config.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLEANUPS = [];
afterAll(() => {
  for (const path of CLEANUPS.splice(0)) rmSync(path, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-delegation-'));
  CLEANUPS.push(dir);
  return dir;
}

describe('delegation point: module', () => {
  it('sessionRoleFacts: only the two roles count; anything else is an ordinary session', () => {
    assert.deepEqual(SESSION_ROLES, ['coordinator', 'worker']);
    assert.equal(sessionRoleFacts({}), null);
    assert.equal(sessionRoleFacts({ OMC_SESSION_ROLE: 'coordinatorr' }), null);
    assert.equal(sessionRoleFacts({ OMC_SESSION_ROLE: '' }), null);
    assert.deepEqual(sessionRoleFacts({ OMC_SESSION_ROLE: ' COORDINATOR ' }), { role: 'coordinator', coordinator: undefined, name: undefined });
    assert.deepEqual(sessionRoleFacts({ OMC_SESSION_ROLE: 'worker', OMC_SESSION_COORDINATOR: 'abc12345', OMC_SESSION_NAME: 'Track A' }), { role: 'worker', coordinator: 'abc12345', name: 'Track A' });
    assert.equal(sessionRoleFacts({ OMC_SESSION_ROLE: 'worker', OMC_SESSION_NAME: 'x'.repeat(300) }).name.length, 120);
  });

  it('decideDelegation: only agent or session is a decision', () => {
    assert.deepEqual(decideDelegation({ delegation: { choice: ' Session ', confidence: 0.9 } }), { choice: 'session', confidence: 0.9 });
    assert.deepEqual(decideDelegation({ delegation: { choice: 'agent', confidence: 2 } }), { choice: 'agent', confidence: null });
    assert.deepEqual(decideDelegation({ delegation: { choice: 'nonsense' } }), { choice: undefined, confidence: null });
    assert.deepEqual(decideDelegation({}), { choice: undefined, confidence: null });
    assert.deepEqual(decideDelegation(undefined), { choice: undefined, confidence: null });
    assert.deepEqual(Object.keys(DELEGATION_QUESTIONS.delegation.criteria), ['agent', 'session']);
  });

  it('delegationState: the facts and the task; running_agents only when known', () => {
    const facts = { role: 'coordinator' };
    const state = delegationState({ toolName: 'Agent', toolInput: { subagent_type: 'executor', prompt: 'p', description: 'd', run_in_background: true }, facts, running: 2 });
    assert.deepEqual(state, { tool_name: 'Agent', subagent_type: 'executor', task: 'p', description: 'd', session_role: 'coordinator', run_in_background: true, running_agents: 2 });
    const unknown = delegationState({ toolName: 'Task', toolInput: {}, facts, running: undefined });
    assert.equal('running_agents' in unknown, false);
    assert.equal(unknown.run_in_background, false);
  });

  it('readRunningAgents: this session only, entries of the last 6 hours, running status; undefined when unknown', () => {
    const stateDir = tempDir();
    const now = Date.now();
    assert.equal(readRunningAgents(stateDir, 's1', now), undefined);
    mkdirSync(join(stateDir, 'sessions', 's1'), { recursive: true });
    writeFileSync(join(stateDir, 'sessions', 's1', 'subagent-tracking-state.json'), JSON.stringify({ agents: [
      { agent_id: 'a1', status: 'running', started_at: new Date(now - 60_000).toISOString() },
      { agent_id: 'a2', status: 'running', started_at: new Date(now - 3_600_000).toISOString() },
      { agent_id: 'a3', status: 'running', started_at: new Date(now - 20 * 3_600_000).toISOString() },
      { agent_id: 'a4', status: 'completed', started_at: new Date(now - 60_000).toISOString() },
      { agent_id: 'a5', status: 'running', started_at: 'not a date' },
    ] }));
    assert.equal(readRunningAgents(stateDir, 's1', now), 2);
    assert.equal(readRunningAgents(stateDir, '../s1', now), undefined);
    assert.equal(readRunningAgents('', 's1', now), undefined);
    writeFileSync(join(stateDir, 'sessions', 's1', 'subagent-tracking-state.json'), '{broken');
    assert.equal(readRunningAgents(stateDir, 's1', now), undefined);
  });

  it('delegationHintText: the launcher of this plugin copy, the facts and the sentence about a restart', () => {
    const text = delegationHintText({ running: 3, sessionId: 'abcdef123456' });
    assert.match(text, /\[Jev, delegation\]/);
    assert.match(text, /node \S*jev-session\.mjs --role worker --coordinator abcdef12 --brief/);
    assert.match(text, /marks as running \(entries from the last 6 hours; the OMC registry may count differently\): 3\./);
    assert.match(text, /A restart of this session interrupts background agents/);
    assert.match(text, /the agent call is not blocked/);
    assert.doesNotMatch(delegationHintText({ running: undefined, sessionId: '' }), /marks as running/);
  });

  it('the points delegation and session-routing are named-only in both mirrors: `all` never enables them', () => {
    for (const point of ['delegation', 'session-routing']) {
      assert.equal(NAMED_ONLY_POINTS.has(point), true);
      assert.equal(TS_NAMED_ONLY_POINTS.has(point), true);
      const env = { TYPESAFE_API_KEY: 'k' };
      assert.equal(parseJevEnv(point, { ...env, OMC_JEV: 'all' }), 'off');
      assert.equal(parseJevEnv(point, { ...env, OMC_JEV: 'all:active' }), 'off');
      assert.equal(parseJevEnv(point, { ...env, OMC_JEV: `all:active,${point}` }), 'shadow');
      assert.equal(parseJevEnv(point, { ...env, OMC_JEV: `all:active,${point}:active` }), 'active');
      assert.equal(parseJevEnv(point, { ...env, OMC_JEV: `all:active,${point}:off` }), 'off');
    }
    assert.deepEqual([...NAMED_ONLY_POINTS].sort(), [...TS_NAMED_ONLY_POINTS].sort());
  });
});

// --- hook part: a fake Jev server --------------------------------------------------------------------------------

const JEV_ROUTING = { 'model-tier': { choice: 'sonnet', confidence: 0.9 }, effort: { score: 2, confidence: 0.8 } };
const PROMPT = 'Run the measurement of all variants for several hours.';

describe('delegation point: Agent hook', { timeout: 180_000 }, () => {
  let world;
  let server;
  let port;
  let received;
  let handler;
  let counter = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        received.push({ url: request.url, body });
        const result = handler(body);
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body ?? {}));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const root = tempDir();
    world = { home: join(root, 'home'), project: join(root, 'proj'), logs: join(root, 'logs') };
    for (const dir of [world.home, join(world.home, '.claude'), world.project, world.logs]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(world.project, 'a.ts'), 'export const a = 1;\n');
    const git = (...args) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: world.project });
    git('init', '-q');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'start');
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function hookEnv({ logs, omcJev, role, extra = {} }) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|PLUGIN_ROOT$|CODEX|DISABLE_OMC)/i.test(key)));
    Object.assign(env, { HOME: world.home, USERPROFILE: world.home, CLAUDE_CONFIG_DIR: join(world.home, '.claude'), CLAUDE_PLUGIN_ROOT: ROOT, OMC_JEV: omcJev, TYPESAFE_API_KEY: 'test', OMC_JEV_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`, OMC_JEV_LOG_DIR: logs, OMC_JEV_QUIET: '1', OMC_JEV_APPLIED_LOG: '1', OMC_JEV_TIMEOUT_MS: '8000' });
    if (role !== undefined) env.OMC_SESSION_ROLE = role;
    return Object.assign(env, extra);
  }

  // The event loop of the test stays free: the synchronous Jev child of the hook must be able to reach the server of this process.
  function runHook(input, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], { cwd: world.project, env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('hook: timeout')); }, 90_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(stdout.trim()); } catch { json = null; }
        resolve({ code, stdout, stderr, json });
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  const rowsOf = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

  // One hook call for Agent. answer = the fake's answer to the delegation question ({choice, confidence}) or 'error500'.
  async function call({ toolInput = {}, role, omcJev = 'all:active,delegation:active', answer, extra = {}, session = `dg-${process.pid}-${++counter}`, before } = {}) {
    const logs = join(world.logs, `l${++counter}`);
    mkdirSync(logs, { recursive: true });
    received = [];
    handler = (body) => {
      if (body?.questions?.delegation) {
        if (answer === 'error500') return { status: 500, body: {} };
        return { body: { answers: { delegation: { type: 'choice', ...(answer ?? { choice: 'agent', confidence: 0.9 }) } }, usage: { input_tokens: 1, output_tokens: 1 } } };
      }
      const answers = {};
      for (const name of Object.keys(body?.questions || {})) {
        const question = body.questions[name];
        answers[name] = question.type === 'noul' ? { type: 'noul', noul: 0.1 } : { type: question.type, ...JEV_ROUTING[name] };
      }
      return { body: { answers, usage: { input_tokens: 1, output_tokens: 1 } } };
    };
    if (before) before(session);
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: world.project, session_id: session, permission_mode: 'default', tool_use_id: `toolu_${session}`, ...extra, tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'Description', prompt: PROMPT, ...toolInput } };
    const result = await runHook(input, hookEnv({ logs, omcJev, role }));
    assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    return {
      result, logs, session, json: result.json,
      context: result.json?.hookSpecificOutput?.additionalContext || '',
      updated: result.json?.hookSpecificOutput?.updatedInput,
      queries: received.filter((entry) => entry.body?.questions),
      applied: rowsOf(logs, 'applied.jsonl'),
    };
  }
  const delegationQueries = (run) => run.queries.filter((entry) => entry.body.questions.delegation);
  const routingQueries = (run) => run.queries.filter((entry) => entry.body.questions['model-tier'] || entry.body.questions.effort);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('a coordinator with delegation:active and the answer session: a hint in additionalContext, the call unchanged apart from model-routing, no denial', async () => {
    const run = await call({ role: 'coordinator', answer: { choice: 'session', confidence: 0.9 } });
    assert.ok(run.context.includes('[Jev, delegation]') && run.context.includes('A restart of this session interrupts background agents') && /node \S*jev-session\.mjs --role worker --coordinator/.test(run.context), run.context);
    assert.ok(!run.result.stdout.includes('permissionDecision') && run.json.continue === true && run.json.decision !== 'block', run.result.stdout.slice(0, 400));
    assert.ok(run.updated?.model === 'sonnet' && run.updated.effort === 'high', `updatedInput: ${JSON.stringify(run.updated)}`);
    assert.ok(run.updated.prompt === PROMPT && run.updated.subagent_type === 'oh-my-claudecode:executor', `prompt/type changed: ${JSON.stringify(run.updated)}`);
    const row = run.applied.find((entry) => entry.point === 'delegation');
    assert.ok(row?.applied?.choice === 'session' && row.applied.role === 'coordinator' && row.applied.confidence === 0.9, JSON.stringify(run.applied));
  });

  it('the answer agent: no hint, an applied row with choice agent', async () => {
    const run = await call({ role: 'coordinator', answer: { choice: 'agent', confidence: 0.8 } });
    assert.ok(!run.context.includes('delegation') && run.applied.some((entry) => entry.point === 'delegation' && entry.applied.choice === 'agent'), `${run.context} | ${JSON.stringify(run.applied)}`);
  });

  it('the question is asked ONLY for a coordinator: no role, role worker, a typo, an empty role; a role in capitals with spaces works', async () => {
    for (const role of [undefined, 'worker', 'coordinatorr', '']) {
      const run = await call({ role, answer: { choice: 'session' } });
      assert.ok(delegationQueries(run).length === 0 && !run.context.includes('delegation'), `role ${JSON.stringify(role)}: queries ${delegationQueries(run).length}`);
    }
    const run = await call({ role: ' COORDINATOR ', answer: { choice: 'session' } });
    assert.ok(delegationQueries(run).length === 1 && run.context.includes('[Jev, delegation]'), 'a role in capitals with spaces does not work');
  });

  it('the point is outside `all`: without an entry in OMC_JEV (all:active) there is no question even for a coordinator; delegation:off asks nothing', async () => {
    const run = await call({ role: 'coordinator', omcJev: 'all:active', answer: { choice: 'session' } });
    assert.ok(delegationQueries(run).length === 0 && !run.context.includes('delegation'), `queries ${delegationQueries(run).length}`);
    const off = await call({ role: 'coordinator', omcJev: 'all:active,delegation:off', answer: { choice: 'session' } });
    assert.equal(delegationQueries(off).length, 0, 'delegation:off asks');
  });

  it('shadow mode (the entry `delegation`): the question goes to Jev and is in shadow.jsonl, but no hint and no applied row', async () => {
    const run = await call({ role: 'coordinator', omcJev: 'all:active,delegation', answer: { choice: 'session' } });
    // up to 20 s: a separate resolver process can be slow under load
    for (let i = 0; i < 200 && !(rowsOf(run.logs, 'shadow.jsonl').some((entry) => entry.point === 'delegation') && received.some((entry) => entry.body?.questions?.delegation)); i++) await wait(100);
    const row = rowsOf(run.logs, 'shadow.jsonl').find((entry) => entry.point === 'delegation');
    const sent = received.filter((entry) => entry.body?.questions?.delegation).length; // in shadow the request is sent by a separate process after the hook ends
    assert.ok(sent === 1 && row?.mode === 'shadow' && row?.answers?.delegation?.choice === 'session', `sent ${sent}, shadow: ${JSON.stringify(row)?.slice(0, 300)}`);
    assert.ok(!run.context.includes('delegation') && !run.applied.some((entry) => entry.point === 'delegation'), `context ${run.context}`);
  });

  it('a call from a subagent (agent_id in the input) is not asked', async () => {
    const run = await call({ role: 'coordinator', answer: { choice: 'session' }, extra: { agent_id: 'a123', agent_type: 'general-purpose' } });
    assert.ok(delegationQueries(run).length === 0 && !run.context.includes('delegation'), `queries ${delegationQueries(run).length}`);
  });

  it('Jev answering 500 to the delegation question: exit 0, no hint, model-routing goes on', async () => {
    const run = await call({ role: 'coordinator', answer: 'error500' });
    assert.ok(!run.context.includes('delegation') && run.updated?.model === 'sonnet', `${run.context} | ${JSON.stringify(run.updated)}`);
  });

  it('an answer outside the list (choice `nonsense`, no choice): no hint and no applied row', async () => {
    for (const answer of [{ choice: 'nonsense' }, {}]) {
      const run = await call({ role: 'coordinator', answer });
      assert.ok(!run.context.includes('delegation') && !run.applied.some((entry) => entry.point === 'delegation'), JSON.stringify({ answer, context: run.context }));
    }
  });

  it('facts in the state for Jev: the role, run_in_background, the number of agents of THIS session (no old entries, no finished ones); the same number in the hint', async () => {
    const now = Date.now();
    const run = await call({
      role: 'coordinator', answer: { choice: 'session' }, toolInput: { run_in_background: true },
      before: (session) => {
        const dir = join(world.project, '.omc', 'state', 'sessions', session);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'subagent-tracking-state.json'), JSON.stringify({ agents: [
          { agent_id: 'a1', status: 'running', started_at: new Date(now - 60_000).toISOString() },
          { agent_id: 'a2', status: 'running', started_at: new Date(now - 3_600_000).toISOString() },
          { agent_id: 'a3', status: 'running', started_at: new Date(now - 20 * 3_600_000).toISOString() },
          { agent_id: 'a4', status: 'completed', started_at: new Date(now - 60_000).toISOString() },
        ], total_spawned: 4 }));
      },
    });
    const state = delegationQueries(run)[0]?.body?.state;
    assert.ok(state && state.session_role === 'coordinator' && state.run_in_background === true && state.running_agents === 2 && state.tool_name === 'Agent', JSON.stringify(state));
    assert.ok(run.context.includes('the OMC registry may count differently): 2'), run.context);
    const body = JSON.stringify(delegationQueries(run)[0].body);
    assert.ok(!body.includes(world.project) && !body.includes(run.session), 'the request carries the project path or the session id');
  });

  it('without a session registry the number is left out (no guessing); the hint has the sentence about a restart', async () => {
    const run = await call({ role: 'coordinator', answer: { choice: 'session' } });
    const state = delegationQueries(run)[0]?.body?.state;
    assert.ok(state && !('running_agents' in state) && !run.context.includes('marks as running') && run.context.includes('A restart of this session'), JSON.stringify({ state, context: run.context }));
  });

  it('the model-routing query of a coordinator is identical to one without a role (the wording of the questions and the state unchanged)', async () => {
    const session = 'dg-parity';
    const withRole = await call({ role: 'coordinator', answer: { choice: 'session' }, session });
    const without = await call({ role: undefined, omcJev: 'all:active', session });
    const a = JSON.stringify(routingQueries(withRole).map((entry) => entry.body));
    const b = JSON.stringify(routingQueries(without).map((entry) => entry.body));
    assert.ok(routingQueries(withRole).length === 1 && a === b, `different model-routing bodies (${a.length} vs ${b.length})`);
  });

  it('the hint is not throttled: two identical calls of one session both get the hint', async () => {
    const session = 'dg-throttle';
    const first = await call({ role: 'coordinator', answer: { choice: 'session' }, session });
    const second = await call({ role: 'coordinator', answer: { choice: 'session' }, session });
    assert.ok(first.context.includes('[Jev, delegation]') && second.context.includes('[Jev, delegation]'), `${first.context.slice(0, 60)} | ${second.context.slice(0, 60)}`);
  });

  it('12 agent types and inputs (including types a guard may refuse, Task instead of Agent) with the answer session: exactly one delegation question and the hint each time, never a denial or a block', async () => {
    const types = ['Explore', 'general-purpose', 'claude', 'writer', 'explore', 'mechanic', 'reviewer', 'oh-my-claudecode:architect', 'oh-my-claudecode:executor', 'docs', 'Plan', undefined];
    for (const type of types) {
      const run = await call({ role: 'coordinator', answer: { choice: 'session' }, toolInput: { subagent_type: type }, extra: type === 'Plan' ? { tool_name: 'Task' } : {} });
      assert.ok(!/"permissionDecision"\s*:\s*"deny"/.test(run.result.stdout) && run.json?.decision !== 'block' && run.json?.continue === true, `${type}: ${run.result.stdout.slice(0, 300)}`);
      assert.ok(delegationQueries(run).length === 1 && run.context.includes('[Jev, delegation]'), `${type}: queries ${delegationQueries(run).length}, context ${run.context.slice(0, 80)}`);
    }
  });

  it('with the point not named nothing changes for a coordinator: no query, no hint (default off)', async () => {
    const run = await call({ role: 'coordinator', omcJev: 'all:active', answer: { choice: 'session' } });
    assert.equal(delegationQueries(run).length, 0);
    assert.equal(run.context.includes('delegation'), false);
    assert.equal(run.applied.some((entry) => entry.point === 'delegation'), false);
    const plain = await call({ role: 'coordinator', omcJev: undefined, answer: { choice: 'session' } });
    assert.equal(delegationQueries(plain).length, 0);
  });
});
