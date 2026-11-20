import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A directory below the transcripts directory, or a transcript file, that cannot be read must stop every tool that
// searches the transcripts: exit 2 and a message that names the path, never a result counted over a part of the tree.
// The tests may run as root, for which chmod does not refuse access, so the refusal is made inside the process under
// test: a small harness replaces the directory listing (os.scandir, os.listdir) or the file open (builtins.open) of
// Python, and a preload module replaces fs.readdirSync or fs.readFileSync of Node, so that one path raises EACCES.
const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const PYTHON_HARNESS = [
  'import builtins, io, os, runpy, sys',
  'mode, target, script = sys.argv[1], sys.argv[2], sys.argv[3]',
  'sys.argv = [script] + sys.argv[4:]',
  'def deny(path):',
  '    raise PermissionError(13, "Permission denied", path)',
  'if mode == "dir":',
  '    # A directory without permissions: it cannot be listed, and nothing below it can be reached (stat fails too).',
  '    real_scandir, real_listdir, real_stat = os.scandir, os.listdir, os.stat',
  '    def named(path):',
  '        return os.fspath(path) if isinstance(path, (str, os.PathLike)) else ""',
  '    def below(path):',
  '        return named(path).startswith(target + os.sep)',
  '    def scandir(path="."):',
  '        if named(path) == target or below(path):',
  '            deny(named(path))',
  '        return real_scandir(path)',
  '    def listdir(path="."):',
  '        if named(path) == target or below(path):',
  '            deny(named(path))',
  '        return real_listdir(path)',
  '    def stat(path, *args, **kwargs):',
  '        if below(path):',
  '            deny(named(path))',
  '        return real_stat(path, *args, **kwargs)',
  '    os.scandir, os.listdir, os.stat = scandir, listdir, stat',
  'elif mode == "file":',
  '    real_open = builtins.open',
  '    def opener(file, *args, **kwargs):',
  '        if isinstance(file, (str, os.PathLike)) and os.fspath(file) == target:',
  '            deny(target)',
  '        return real_open(file, *args, **kwargs)',
  '    builtins.open = io.open = opener  # Path.open goes through io.open',
  'try:',
  '    runpy.run_path(script, run_name="__main__")',
  'except SystemExit as stop:',
  '    sys.exit(stop.code)',
].join('\n');

const NODE_PRELOAD = [
  "const fs = require('node:fs');",
  'const mode = process.env.DENY_MODE;',
  'const target = process.env.DENY_PATH;',
  "const deny = (syscall) => Object.assign(new Error(`EACCES: permission denied, ${syscall} '${target}'`), { code: 'EACCES', syscall, path: target });",
  "if (mode === 'dir') {",
  '  const real = fs.readdirSync;',
  '  fs.readdirSync = function (path, ...rest) { if (String(path) === target) throw deny("scandir"); return real.call(this, path, ...rest); };',
  "} else if (mode === 'file') {",
  '  const real = fs.readFileSync;',
  '  fs.readFileSync = function (path, ...rest) { if (String(path) === target) throw deny("open"); return real.call(this, path, ...rest); };',
  '}',
  "require('node:module').syncBuiltinESMExports();",
].join('\n');

const ROW_USER = { type: 'user', timestamp: '2026-11-14T10:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'hello' } };
const ROW_ASSISTANT = {
  type: 'assistant', timestamp: '2026-11-14T10:00:01.000Z', sessionId: 's1', requestId: 'r1',
  message: { id: 'm1', model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
};
const TRANSCRIPT = `${JSON.stringify(ROW_USER)}\n${JSON.stringify(ROW_ASSISTANT)}\n`;

let base = '';
let projects = '';
let compact = '';
let journal = '';
let routingJournal = '';
let agentTranscript = '';
let mainTranscript = '';
let subagentsDir = '';
let projectDir = '';
let sessionDir = '';
let harness = '';
let preload = '';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'unreadable-transcripts-'));
  projects = join(base, 'projects');
  projectDir = join(projects, 'proj');
  sessionDir = join(projectDir, 's1');
  subagentsDir = join(sessionDir, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  mainTranscript = join(projects, 'proj', 's1.jsonl');
  writeFileSync(mainTranscript, TRANSCRIPT);
  agentTranscript = join(subagentsDir, 'agent-a1.jsonl');
  writeFileSync(agentTranscript, TRANSCRIPT);
  writeFileSync(join(subagentsDir, 'agent-a1.meta.json'), `${JSON.stringify({ toolUseId: 'tid-1', model: 'haiku', effort: 'low', agentId: 'a1', name: 'executor' })}\n`);
  compact = join(base, 'compact.jsonl');
  writeFileSync(compact, '');
  journal = join(base, 'journal');
  mkdirSync(journal);
  writeFileSync(join(journal, 'applied.jsonl'), `${JSON.stringify({ ts: '2026-11-14T10:00:00.500Z', point: 'learner-extraction', session_id: 's1', applied: {} })}\n`);
  routingJournal = join(base, 'routing-journal');
  mkdirSync(routingJournal);
  const routing = {
    ts: '2026-11-14T09:10:00.000Z', point: 'model-routing', tool_use_id: 'tid-1', session_id: 's1',
    applied: { subagent_type: 'executor', model: { from: 'sonnet', to: 'haiku', source: 'jev' }, effort: { from: 'high', to: 'low', source: 'jev' } },
  };
  writeFileSync(join(routingJournal, 'applied.jsonl'), `${JSON.stringify(routing)}\n`);
  harness = join(base, 'harness.py');
  writeFileSync(harness, PYTHON_HARNESS);
  preload = join(base, 'preload.cjs');
  writeFileSync(preload, NODE_PRELOAD);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Mode = 'none' | 'dir' | 'file';

function runPython(script: string, args: string[], mode: Mode, target: string) {
  const r = spawnSync('python3', ['-I', harness, mode, target, join(TOOLS, script), ...args], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runNode(script: string, args: string[], mode: Mode, target: string) {
  const r = spawnSync(process.execPath, ['--require', preload, join(TOOLS, script), ...args], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, DENY_MODE: mode, DENY_PATH: target },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// The directories below the searched one that may refuse access: a project, a session and the directory of its subagents.
const DIRECTORIES: Array<[string, () => string]> = [['project directory', () => projectDir], ['session directory', () => sessionDir], ['subagents directory', () => subagentsDir]];

// Every Python tool that searches the transcripts, with the arguments of a valid run over the small tree above.
const PYTHON_TOOLS: Array<{ script: string; args: () => string[]; fileTarget: () => string }> = [
  { script: 'advisor_event_coverage.py', args: () => ['--projects', projects, '--label', 'x'], fileTarget: () => mainTranscript },
  { script: 'compaction_harm_monitor.py', args: () => ['--projects', projects, '--compact', compact, '--to', '2026-11-15T00:00:00Z', '--days', '7'], fileTarget: () => mainTranscript },
  { script: 'compaction_ask_probe.py', args: () => ['--projects', projects, '--compact', compact, '--json'], fileTarget: () => mainTranscript },
  { script: 'user_prohibitions_after_compaction.py', args: () => ['--projects', projects], fileTarget: () => mainTranscript },
  { script: 'compaction_window_drops.py', args: () => ['--projects', projects, '--compact', compact], fileTarget: () => mainTranscript },
  {
    script: 'compaction_cache_cost.py',
    args: () => ['--projects', projects, '--compact', compact, '--deployed-at', '2026-11-01T00:00:00Z', '--to', '2026-11-15T00:00:00Z', '--days', '30', '--json'],
    fileTarget: () => mainTranscript,
  },
  { script: 'empty_results.py', args: () => ['--transcripts', projects], fileTarget: () => mainTranscript },
  { script: 'tool_call_repeats.py', args: () => ['--transcripts', projects], fileTarget: () => mainTranscript },
  { script: 'decision_outcome_join.py', args: () => ['--journal', routingJournal, '--transcripts', projects], fileTarget: () => agentTranscript },
];

describe.skipIf(!hasPython3)('a directory or a transcript that cannot be read stops the Python tools', () => {
  for (const tool of PYTHON_TOOLS) {
    describe(tool.script, () => {
      it('the fixture is a valid run when nothing is refused', () => {
        const r = runPython(tool.script, tool.args(), 'none', '');
        expect(r.status, r.stderr).toBe(0);
      });

      it.each(DIRECTORIES)('the %s below the searched directory cannot be read: exit 2 and a message that names it', (_name, directory) => {
        const r = runPython(tool.script, tool.args(), 'dir', directory());
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain(directory());
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(r.stdout, 'no result is printed').toBe('');
      });

      it('a transcript below the searched directory that cannot be read exits 2 and names it', () => {
        const r = runPython(tool.script, tool.args(), 'file', tool.fileTarget());
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain(tool.fileTarget());
        expect(r.stderr).not.toMatch(/Traceback|skipping/);
        expect(r.stdout, 'no result is printed').toBe('');
      });
    });
  }
});

// A `*.jsonl` link whose target is gone is a transcript that cannot be read: it stops the run like a file that refuses access.
// It is no missing file that is left out of the counts, so every tool that searches the transcripts names it and exits 2, for a
// main transcript and for a subagent transcript.
describe.skipIf(!hasPython3)('a dangling link to a transcript stops every tool that searches the transcripts', () => {
  const trees: Array<[string, string, string]> = [
    ['main', join('proj', 's2.jsonl'), 's2.jsonl'],
    ['subagent', join('proj', 's1', 'subagents', 'agent-a2.jsonl'), 'agent-a2.jsonl'],
  ];
  const tree = (kind: string) => join(base, `linked-${kind}`);
  beforeAll(() => {
    for (const [kind, link] of trees) {
      mkdirSync(join(tree(kind), 'proj', 's1', 'subagents'), { recursive: true });
      writeFileSync(join(tree(kind), 'proj', 's1.jsonl'), TRANSCRIPT);
      symlinkSync(join(base, 'no-such-transcript.jsonl'), join(tree(kind), link));
    }
  });

  for (const [kind, , name] of trees) {
    // The eight tools that search the transcripts; the join of decisions and the outcome labels open only the transcripts that their journal names.
    for (const tool of PYTHON_TOOLS.filter((entry) => entry.script !== 'decision_outcome_join.py')) {
      it(`${tool.script}: a dangling ${kind} link exits 2 and names it`, () => {
        const r = runPython(tool.script, tool.args().map((arg) => (arg === projects ? tree(kind) : arg)), 'none', '');
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain(name);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(r.stdout, 'no result is printed').toBe('');
      });
    }
  }
});

describe('a directory or a transcript that cannot be read stops the outcome labels tool', () => {
  const args = () => ['--journal', journal, '--transcripts', projects, '--json'];

  it('the fixture is a valid run when nothing is refused', () => {
    const r = runNode('jev_outcome_labels.mjs', args(), 'none', '');
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(DIRECTORIES)('the %s below the transcripts directory cannot be read: exit 2 and a message that names it', (_name, directory) => {
    const r = runNode('jev_outcome_labels.mjs', args(), 'dir', directory());
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain(directory());
    expect(r.stdout, 'no result is printed').toBe('');
  });

  it('a transcript of a session that cannot be read exits 2 and names it', () => {
    const r = runNode('jev_outcome_labels.mjs', args(), 'file', mainTranscript);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain(mainTranscript);
    expect(r.stdout, 'no result is printed').toBe('');
  });
});
