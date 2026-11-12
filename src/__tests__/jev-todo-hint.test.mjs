/**
 * Experiment (negative result, not for merge): scripts/jev-todo-hint.mjs and scripts/lib/jev-todo-hint.mjs.
 * Real hook subprocesses against a local stub of the Jev endpoint; every variable is off by default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyListCall, przypomnienieQuestion, przypomnienieZOdpowiedzi, QUESTION_WITH_HISTORY } from '../../scripts/lib/jev-todo-hint.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/jev-todo-hint.mjs', import.meta.url));

// Async spawn: the event loop of the test must stay free for the stub server the hook's synchronous Jev child posts to.
function runHook(input, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    child.stdin.end(JSON.stringify(input));
  });
}

describe('jev todo-hint (experiment)', () => {
  let cwd;
  let env;
  let server;
  let requests;
  let answer;

  const logRows = () => {
    const path = join(cwd, 'jev-logs', 'todo-hint.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const batch = (calls, extra = {}) => ({ session_id: 'sess-1', prompt_id: 'p1', tool_calls: calls, ...extra });

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'jev-todo-hint-'));
    requests = [];
    answer = { type: 'choice', choice: 'zaloz_liste', confidence: 0.5, probabilities: { zadne: 0.3, zaloz_liste: 0.6 } };
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (c) => { raw += c; });
      request.on('end', () => {
        requests.push(JSON.parse(raw));
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify({ answers: { przypomnienie: answer } }));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    env = {
      PATH: process.env.PATH,
      HOME: cwd,
      NODE_NO_WARNINGS: '1',
      OMC_JEV_LOG_DIR: join(cwd, 'jev-logs'),
      OMC_JEV_QUIET: '1',
      OMC_JEV_TIMEOUT_MS: '3000',
      TYPESAFE_API_KEY: 'test-key-123',
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    };
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('does nothing without OMC_TODO_HINT', async () => {
    const result = await runHook(batch([{ tool_name: 'Bash' }]), { ...env, OMC_JEV: 'todo-hint:active' }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toBeUndefined();
    expect(requests).toEqual([]);
    expect(existsSync(join(cwd, 'jev-logs', 'todo-hint'))).toBe(false);
  });

  it('`all:active` does not enable the point', async () => {
    const result = await runHook(batch([{ tool_name: 'Bash' }]), { ...env, OMC_TODO_HINT: 'active', OMC_JEV: 'all:active' }, cwd);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('delivers the reminder Jev chose, once, in the active mode', async () => {
    const result = await runHook(batch([{ tool_name: 'Bash' }]), { ...env, OMC_TODO_HINT: 'active', OMC_JEV: 'todo-hint:active' }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.hookSpecificOutput.additionalContext).toContain('Załóż listę zadań');
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(['przypomnienie']);
    expect(requests[0].questions.przypomnienie.instructions).toBe(QUESTION_WITH_HISTORY);
    expect(requests[0].state.przypomnienie).toMatchObject({ ma_liste: false, wywolan_od_zmiany_listy: 1, przypomnien_dotad: 0, sesja_glowna: true, historia_przypomnien: [] });
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ etap: 'przypomnienie', tryb: 'active', rodzaj: 'zaloz_liste', agent: 'main', kto: 'jev', nr_tury: 1 });
  });

  it('sends nothing to the agent when Jev answers `zadne` or the answer is unusable', async () => {
    for (const given of [{ type: 'choice', choice: 'zadne' }, { type: 'choice', choice: 'nie-ma-takiego' }, { type: 'noul', noul: 0.9 }]) {
      answer = given;
      const result = await runHook(batch([{ tool_name: 'Bash' }]), { ...env, OMC_TODO_HINT: 'active', OMC_JEV: 'todo-hint:active' }, cwd);
      expect(JSON.parse(result.stdout).hookSpecificOutput).toBeUndefined();
    }
    expect(logRows()).toEqual([]);
  });

  it('shadow delivery logs the decision and delivers nothing', async () => {
    const result = await runHook(batch([{ tool_name: 'Bash' }]), { ...env, OMC_TODO_HINT: 'shadow', OMC_JEV: 'todo-hint:active' }, cwd);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toBeUndefined();
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tryb: 'shadow', rodzaj: 'zaloz_liste' });
  });

  it('gives Jev the history of the thread: the earlier reminder and whether a list call followed', async () => {
    const on = { ...env, OMC_TODO_HINT: 'active', OMC_JEV: 'todo-hint:active' };
    await runHook(batch([{ tool_name: 'Bash' }, { tool_name: 'Read' }]), on, cwd);
    await runHook(batch([{ tool_name: 'Bash' }]), on, cwd);
    expect(requests[1].state.przypomnienie.historia_przypomnien).toMatchObject([{ rodzaj: 'zaloz_liste', tryb: 'active', wywolan_narzedzi_temu: 1, lista_zmieniona_po_nim: false }]);
    expect(requests[1].state.przypomnienie).toMatchObject({ przypomnien_dotad: 1, wywolan_od_zmiany_listy: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runHook(batch([{ tool_name: 'TaskCreate', tool_input: { subject: 'do it' }, tool_response: 'Task #1 created' }]), on, cwd);
    await runHook(batch([{ tool_name: 'Bash' }]), on, cwd);
    const last = requests.at(-1).state.przypomnienie;
    expect(last).toMatchObject({ ma_liste: true, zadan_w_toku: 0, zadan_otwartych: 1, wywolan_od_zmiany_listy: 1 });
    // reminder 1: no list call before reminder 2; reminder 2: the TaskCreate batch came before reminder 3
    expect(last.historia_przypomnien.map((h) => h.lista_zmieniona_po_nim).slice(0, 2)).toEqual([false, true]);
  });

  it('keeps the list of each agent apart from the main thread', async () => {
    const on = { ...env, OMC_TODO_HINT: 'active', OMC_JEV: 'todo-hint:active' };
    await runHook(batch([{ tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: 'Task #1 created' }]), on, cwd);
    await runHook(batch([{ tool_name: 'Bash' }], { agent_id: 'agent-7', agent_type: 'executor' }), on, cwd);
    const sub = requests.at(-1).state.przypomnienie;
    expect(sub).toMatchObject({ ma_liste: false, sesja_glowna: false, typ_agenta: 'executor' });
  });

  describe('library', () => {
    it('applyListCall follows TaskCreate, TaskUpdate and TodoWrite and ignores a malformed call', () => {
      let items = applyListCall([], { tool_name: 'TaskCreate', tool_input: { subject: 'a' }, tool_response: { task: { id: 4 } } });
      expect(items).toEqual([{ id: '4', status: 'pending', content: 'a' }]);
      items = applyListCall(items, { tool_name: 'TaskUpdate', tool_input: { taskId: '4', status: 'in_progress' } });
      expect(items[0].status).toBe('in_progress');
      expect(applyListCall(items, { tool_name: 'TaskUpdate', tool_input: { taskId: '9', status: 'completed' } })).toBeNull();
      expect(applyListCall(items, { tool_name: 'TaskCreate', tool_input: { subject: 'b' }, tool_response: 'no id' })).toBeNull();
      expect(applyListCall([], { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'z', status: 'completed' }] } })).toEqual([{ id: '1', status: 'completed', content: 'z' }]);
    });

    it('reads a kind only from a choice answer', () => {
      expect(przypomnienieZOdpowiedzi({ choice: 'notka' })).toBe('notka');
      expect(przypomnienieZOdpowiedzi({ choice: 'zadne' })).toBeNull();
      expect(przypomnienieZOdpowiedzi(null)).toBeNull();
      expect(Object.keys(przypomnienieQuestion().przypomnienie.criteria)).toEqual(['zadne', 'zaloz_liste', 'wpisz_krok', 'lista_nieaktualna', 'notka']);
    });
  });
});
