import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

// Benign native provider and its supervisor controller run in the same psmux
// console. No model, provider CLI, or user state is accessed.
const [role, root, mode] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
const write = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
const errors = [];
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  stream.on('error', error => errors.push({ stream: 'fixture', code: error.code }));
}

if (role === 'descendant') {
  write('descendant.json', { pid: process.pid });
  setInterval(() => {}, 1000);
} else if (role === 'provider') {
  let descendant;
  if (mode !== 'exit') {
    descendant = spawn(process.execPath, [fixture, 'descendant', root], { stdio: 'inherit' });
    descendant.on('error', error => errors.push({ stream: 'descendant', code: error.code }));
  }
  const timer = setInterval(() => {
    if (descendant && !existsSync(join(root, 'descendant.json'))) return;
    if (!existsSync(join(root, 'provider.json'))) {
      write('provider.json', {
        pid: process.pid,
        descendantPid: descendant?.pid,
        tty: [process.stdin.isTTY === true, process.stdout.isTTY === true, process.stderr.isTTY === true],
      });
      process.stdout.write('WINDOWS_SUPERVISOR_CONSOLE_MARKER\n');
      process.stderr.write('WINDOWS_SUPERVISOR_STDERR_MARKER\n');
    }
    if (mode === 'exit' && existsSync(join(root, 'exit-provider'))) {
      clearInterval(timer);
      process.exit(7);
    }
  }, 25);
} else if (role === 'controller') {
  const { invocation, environment } = JSON.parse(readFileSync(join(root, 'invocation.json'), 'utf8'));
  const child = spawn(invocation.command, invocation.args, {
    cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { controllerPid: process.pid, supervisorPid: child.pid, stdout: '', stderr: '', frames: [], errors, commands: [], closed: false };
  let pending = '';
  let sequence = -1;
  const persist = () => write('controller.json', state);
  child.stdin.on('error', error => { errors.push({ stream: 'stdin', code: error.code }); persist(); });
  child.stdout.on('error', error => { errors.push({ stream: 'stdout', code: error.code }); persist(); });
  child.stderr.on('error', error => { errors.push({ stream: 'stderr', code: error.code }); persist(); });
  child.on('error', error => { errors.push({ stream: 'spawn', code: error.code }); persist(); });
  child.stdout.on('data', chunk => {
    state.stdout += chunk;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try { state.frames.push(JSON.parse(line)); }
      catch { errors.push({ stream: 'json', line }); }
    }
    persist();
  });
  child.stderr.on('data', chunk => { state.stderr += chunk; persist(); });
  const commands = setInterval(() => {
    const path = join(root, 'command.json');
    if (!existsSync(path)) return;
    let command;
    try { command = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    if (command.sequence === sequence) return;
    sequence = command.sequence;
    state.commands.push(sequence);
    if (command.operation === 'eof') child.stdin.end();
    else if (child.stdin.writable) child.stdin.write(JSON.stringify(command.frame) + '\n');
    persist();
  }, 25);
  // Closing this known supervisor closes its kill-on-close Job if a test
  // fails before it sends its expected command. Never target unrelated PIDs.
  const deadline = setTimeout(() => { errors.push({ stream: 'deadline' }); child.kill(); }, 35_000);
  child.on('close', (code, signal) => {
    clearInterval(commands);
    clearTimeout(deadline);
    state.closed = true;
    state.exitCode = code;
    state.signal = signal;
    state.partialStdout = pending;
    persist();
  });
  persist();
  child.stdin.write(invocation.stdinPayload + '\n');
} else {
  throw new Error('Unknown Windows supervisor fixture role');
}
