// Stand-in provider CLI for a team worker pane. It uses only what a real
// worker sees: pane text, the stdin trigger, the inbox, the `omc team api`
// commands rendered there, and the shutdown-ack file. No model or network.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const IDLE_PROMPT = '❯ ';
const SHUTDOWN_POLL_MS = 100;

const traceIndex = process.argv.indexOf('--trace');
const tracePath = traceIndex >= 0 ? process.argv[traceIndex + 1] : undefined;

function trace(step, detail = {}) {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify({ step, pid: process.pid, at: new Date().toISOString(), ...detail })}\n`);
}

function expandStateRoot(path) {
  return path.replace(/^\$OMC_TEAM_STATE_ROOT/, process.env.OMC_TEAM_STATE_ROOT ?? '');
}

function runTeamApi(command) {
  let stdout;
  try {
    stdout = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`team_api_exit:${error.status}:${String(error.stdout ?? '').trim()}:${String(error.stderr ?? '').trim()}`);
  }
  const envelope = JSON.parse(stdout.trim().split('\n').at(-1));
  if (envelope.ok !== true || envelope.data?.ok !== true) throw new Error(`team_api_rejected:${stdout.trim()}`);
  return envelope.data;
}

const stdin = createInterface({ input: process.stdin });
// The bootstrap starts providers in their own session, so a closed pane
// delivers EOF rather than SIGHUP. Exit like a CLI that lost its terminal.
stdin.on('close', () => {
  trace('stdin-closed');
  process.exit(129);
});
const stdinLines = stdin[Symbol.asyncIterator]();

const STEPS = [
  {
    name: 'banner',
    run: () => { process.stdout.write('fake-claude for omc team tmux smoke\n\n'); },
  },
  {
    name: 'idle-prompt',
    run: () => { process.stdout.write(IDLE_PROMPT); },
  },
  {
    name: 'await-startup-trigger',
    run: async () => {
      for (;;) {
        const { value, done } = await stdinLines.next();
        if (done) throw new Error('stdin_closed_before_trigger');
        const match = /Read (\S+\/inbox\.md), execute now/.exec(value);
        if (match) return { inboxPath: expandStateRoot(match[1]) };
      }
    },
  },
  {
    name: 'read-inbox',
    run: ({ inboxPath }) => {
      const lines = readFileSync(inboxPath, 'utf8').split('\n').map(line => line.trim());
      const claimCommand = lines.find(line => /\bteam api claim-task\b/.test(line));
      const completeCommand = lines.find(line => /\bteam api transition-task-status\b/.test(line) && line.includes('"to":"completed"'));
      if (!claimCommand || !completeCommand) throw new Error('inbox_lifecycle_commands_missing');
      return { claimCommand, completeCommand };
    },
  },
  {
    name: 'claim-task',
    run: ({ claimCommand }) => ({ claimToken: runTeamApi(claimCommand).claimToken }),
  },
  {
    name: 'complete-task',
    run: ({ completeCommand, claimToken }) => { runTeamApi(completeCommand.replace('<claim_token>', claimToken)); },
  },
  {
    name: 'idle-prompt',
    run: () => { process.stdout.write(`\ntask completed\n${IDLE_PROMPT}`); },
  },
  {
    name: 'await-shutdown-request',
    run: async ({ inboxPath }) => {
      for (;;) {
        const inbox = readFileSync(inboxPath, 'utf8');
        const ackTarget = /^Write your ack to: (\S+)$/m.exec(inbox);
        if (inbox.startsWith('# Shutdown Request') && ackTarget) return { ackPath: expandStateRoot(ackTarget[1]) };
        await sleep(SHUTDOWN_POLL_MS);
      }
    },
  },
  {
    name: 'write-shutdown-ack',
    run: ({ ackPath }) => {
      writeFileSync(ackPath, JSON.stringify({ status: 'accept', reason: 'ok', updated_at: new Date().toISOString() }));
    },
  },
];

let context = {};
for (const step of STEPS) {
  trace(step.name);
  try {
    context = { ...context, ...(await step.run(context)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace('failed', { failed_step: step.name, message });
    process.stdout.write(`\nfake-claude failed at ${step.name}: ${message}\n`);
    process.exit(1);
  }
}
trace('exit');
process.exit(0);
