// Stand-in provider CLI for a team worker pane. It uses only what a real
// worker sees: pane text, the stdin trigger, the inbox, the `omc team api`
// commands rendered there, and the shutdown-ack file. No model or network.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { currentStrictProcessStartIdentity } from '../../team-owner-epoch.ts';

const IDLE_PROMPT = '❯ ';
const SHUTDOWN_POLL_MS = 100;

const traceIndex = process.argv.indexOf('--trace');
const tracePath = traceIndex >= 0 ? process.argv[traceIndex + 1] : undefined;
// Lets test cleanup signal this process only while its PID still names it.
const processStartedAt = currentStrictProcessStartIdentity();

function trace(step, detail = {}) {
  if (!tracePath) return;
  const entry = { step, pid: process.pid, process_started_at: processStartedAt, at: new Date().toISOString(), ...detail };
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
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
// Real claude has been seen to outlive its killed launch wrapper as an
// orphan. This knob keeps the fake alive the same way.
const OUTLIVE_TERMINAL = process.env.OMC_FAKE_OUTLIVE_TERMINAL === '1';
if (OUTLIVE_TERMINAL) {
  process.on('SIGHUP', () => trace('sighup-ignored'));
  process.stdout.on('error', () => undefined);
}
// The bootstrap starts providers in their own session, so a closed pane
// delivers EOF rather than SIGHUP. Exit like a CLI that lost its terminal.
stdin.on('close', () => {
  trace('stdin-closed');
  if (OUTLIVE_TERMINAL) void sleep(2_147_483_647);
  else process.exit(129);
});
const stdinLines = stdin[Symbol.asyncIterator]();

const FRAMES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'pane-frames');
const CLEAR_SCREEN = '\x1b[H\x1b[J';
const SLOW_BANNER_MS = Number(process.env.OMC_FAKE_SLOW_BANNER_MS) || 3_000;
const BUSY_MS = 2_000;
const PROVIDER_EXIT_MS = 1_000;
const TRUST_BUSY_MS = 1_000;
const TRUST_IGNORE_MS = 600;
// Down (normal and application cursor mode), then Enter.
const SELECTOR_KEYS = ['\x1b[B', '\x1bOB', '\r', '\n'];

function showFrame(name, file) {
  return {
    name,
    run: () => { process.stdout.write(`${CLEAR_SCREEN}${readFileSync(join(FRAMES_ROOT, file), 'utf8').trimEnd()}`); },
  };
}

function pause(name, ms) {
  return { name, run: () => sleep(ms) };
}

async function nextLine(eofError) {
  const { value, done } = await stdinLines.next();
  if (done) {
    if (OUTLIVE_TERMINAL) return new Promise(() => undefined);
    throw new Error(eofError);
  }
  return value;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// A recovery inbox carries only the owner-adopted claim, inside each
// checkpoint command; completion reuses that command's omc prefix.
function parseRecoveryContinuations(inbox) {
  return inbox.split('## Recovery Continuation').slice(1).map(section => {
    const owned = /You own adopted task (\S+) at checkpoint sequence (\d+)\./.exec(section);
    const checkpoint = /publish the next authenticated checkpoint: `([^`]+)`/.exec(section);
    const field = name => new RegExp(`\\\\"${name}\\\\":\\\\"([^\\\\"]+)\\\\"`).exec(checkpoint?.[1] ?? '')?.[1];
    if (!owned || !checkpoint || !field('team_name') || !field('claim_token')) throw new Error('recovery_continuation_unparseable');
    const prefix = checkpoint[1].slice(0, checkpoint[1].indexOf('team api write-task-checkpoint'));
    return {
      checkpointCommand: checkpoint[1]
        .replace('<next_sequence>', String(Number(owned[2]) + 1))
        .replace('<safe_boundary_json>', '{}'),
      completeCommand: `${prefix}team api transition-task-status --input ${shellQuote(JSON.stringify({
        team_name: field('team_name'),
        task_id: owned[1],
        from: 'in_progress',
        to: 'completed',
        claim_token: field('claim_token'),
        result: 'fake provider resumed the adopted task',
      }))} --json`,
    };
  });
}

const banner = {
  name: 'banner',
  run: () => { process.stdout.write('fake-claude for omc team tmux smoke\n\n'); },
};
const idlePrompt = {
  name: 'idle-prompt',
  run: () => { process.stdout.write(IDLE_PROMPT); },
};
const awaitStartupTrigger = {
  name: 'await-startup-trigger',
  run: async () => {
    for (;;) {
      const match = /Read (\S+\/inbox\.md), execute now/.exec(await nextLine('stdin_closed_before_trigger'));
      if (match) return { inboxPath: expandStateRoot(match[1]) };
    }
  },
};
const readInbox = {
  name: 'read-inbox',
  run: ({ inboxPath }) => {
    const lines = readFileSync(inboxPath, 'utf8').split('\n').map(line => line.trim());
    const claimCommand = lines.find(line => /\bteam api claim-task\b/.test(line));
    const completeCommand = lines.find(line => /\bteam api transition-task-status\b/.test(line) && line.includes('"to":"completed"'));
    if (!claimCommand || !completeCommand) throw new Error('inbox_lifecycle_commands_missing');
    return { claimCommand, completeCommand };
  },
};
const claimTask = {
  name: 'claim-task',
  run: ({ claimCommand }) => ({ claimToken: runTeamApi(claimCommand).claimToken }),
};
const completeTask = {
  name: 'complete-task',
  run: ({ completeCommand, claimToken }) => { runTeamApi(completeCommand.replace('<claim_token>', claimToken)); },
};
const completedPrompt = {
  name: 'idle-prompt',
  run: () => { process.stdout.write(`\ntask completed\n${IDLE_PROMPT}`); },
};
const awaitShutdownRequest = {
  name: 'await-shutdown-request',
  run: async ({ inboxPath }) => {
    for (;;) {
      const inbox = readFileSync(inboxPath, 'utf8');
      const ackTarget = /^Write your ack to: (\S+)$/m.exec(inbox);
      if (inbox.startsWith('# Shutdown Request') && ackTarget) return { ackPath: expandStateRoot(ackTarget[1]) };
      await sleep(SHUTDOWN_POLL_MS);
    }
  },
};
const writeShutdownAck = {
  name: 'write-shutdown-ack',
  run: ({ ackPath }) => {
    writeFileSync(ackPath, JSON.stringify({ status: 'accept', reason: 'ok', updated_at: new Date().toISOString() }));
  },
};

// Claude's two-choice dialogs focus their first choice ("No, exit" in the
// trust dialog) and read raw keys: Down moves the focus to the second choice
// and redraws, Enter confirms the focused choice, and confirming the first one
// fails with firstChoiceError. Keys that arrive in one read act against the
// focus drawn before that read, so a Down and an Enter read together still
// confirm the first choice. That is the hypothesis the recorded 2.1.328
// failures fit, not observed behavior. busyMs blocks the event loop after the
// first draw so keys sent meanwhile reach the selector in one read (an
// unconfirmed hypothesis). ignoreMs drops every key read that soon after the
// first draw, as Claude Code 2.1.328 was measured to drop a Down sent right
// after the trust dialog appeared. Every read is traced, so a run shows
// whether the dialog got any key at all.
const TRUST_CHOICES = [/❯\s*No, exit/, /^\s*Yes, (?:proceed|I trust this folder)/];

function moveFocus(frame, [first, second]) {
  const lines = frame.split('\n');
  const from = lines.findIndex(line => first.test(line));
  const to = lines.findIndex(line => second.test(line));
  const column = lines[from].indexOf('❯');
  lines[from] = `${lines[from].slice(0, column)} ${lines[from].slice(column + 1)}`;
  lines[to] = `${lines[to].slice(0, column)}❯${lines[to].slice(column + 1)}`;
  return lines.join('\n');
}

function claudeSelector(file, {
  name = 'await-trust-answer',
  choices = TRUST_CHOICES,
  firstChoiceError = 'trust_declined',
  busyMs = 0,
  ignoreMs = 0,
} = {}) {
  return {
    name,
    run: () => new Promise((resolve, reject) => {
      const frame = readFileSync(join(FRAMES_ROOT, file), 'utf8').trimEnd();
      let secondFocused = false;
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      const finish = (error) => {
        process.stdin.off('data', onKeys);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        if (error) reject(error);
        else resolve();
      };
      let drawnAt = Infinity;
      const onKeys = (chunk) => {
        trace('selector-read', { dialog: name, keys: String(chunk) });
        if (Date.now() - drawnAt < ignoreMs) return;
        const focusedBeforeRead = secondFocused;
        for (let rest = String(chunk); rest; ) {
          const key = SELECTOR_KEYS.find(candidate => rest.startsWith(candidate));
          rest = rest.slice(key?.length ?? 1);
          if (key === '\r' || key === '\n') return finish(focusedBeforeRead ? undefined : new Error(firstChoiceError));
          if (key && !secondFocused) {
            secondFocused = true;
            process.stdout.write(`${CLEAR_SCREEN}${moveFocus(frame, choices)}`);
          }
        }
      };
      process.stdin.on('data', onKeys);
      process.stdout.write(`${CLEAR_SCREEN}${frame}`, () => {
        drawnAt = Date.now();
        const busyUntil = Date.now() + busyMs;
        while (Date.now() < busyUntil);
      });
    }),
  };
}

// Claude Code 2.1.328 on a fresh CLAUDE_CONFIG_DIR, after the trust dialog.
const claudeBypassWarning = claudeSelector('claude/2.1.328/bypass-permissions.txt', {
  name: 'await-bypass-answer',
  choices: [/❯\s*No, exit/, /^\s*Yes, I accept/],
  firstChoiceError: 'bypass_declined',
});
// Claude Code 2.1.329 on a config with no completed onboarding, before the
// trust dialog. Enter on the focused theme answers the picker for the user.
const claudeOnboardingThemePicker = claudeSelector('claude/2.1.329/onboarding-theme.txt', {
  name: 'await-onboarding-answer',
  choices: [/❯ ✔ Auto \(match terminal\)/, /^\s+Dark mode$/],
  firstChoiceError: 'onboarding_answered',
});
const claudeFullscreenRendererOffer = claudeSelector('claude/2.1.328/fullscreen-renderer.txt', {
  name: 'await-renderer-answer',
  choices: [/❯\s*1\. Yes, try it/, /^\s*2\. Not now/],
  firstChoiceError: 'fullscreen_renderer_accepted',
});

function lifecycle({ startup, working = [], completed = completedPrompt }) {
  return [...startup, awaitStartupTrigger, readInbox, claimTask, ...working, completeTask, completed, awaitShutdownRequest, writeShutdownAck];
}

const CLAUDE_IDLE = 'claude/2.1.325/idle.txt';

const SCENARIOS = {
  default: lifecycle({ startup: [banner, idlePrompt] }),
  'claude-trust': lifecycle({
    startup: [claudeSelector('claude/2.1.325/trust.txt'), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'claude-trust-busy-startup': lifecycle({
    startup: [claudeSelector('claude/2.1.325/trust.txt', { busyMs: TRUST_BUSY_MS }), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'claude-trust-ignores-early-keys': lifecycle({
    startup: [claudeSelector('claude/2.1.325/trust.txt', { ignoreMs: TRUST_IGNORE_MS }), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'claude-onboarding': lifecycle({
    startup: [claudeOnboardingThemePicker, showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'claude-bypass-permissions': lifecycle({
    startup: [claudeBypassWarning, showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  // The trust dialog, then the offer: the order after the bypass warning was
  // accepted once for the config directory (inferred from the 2.1.328 recordings).
  'claude-fullscreen-renderer': lifecycle({
    startup: [
      claudeSelector('claude/2.1.325/trust.txt'),
      claudeFullscreenRendererOffer,
      showFrame('idle-prompt', 'claude/2.1.328/idle-after-fullscreen-renderer.txt'),
    ],
  }),
  'claude-slow-banner': lifecycle({
    startup: [showFrame('startup-banner', 'claude/unversioned/startup-banner-bypass.txt'), pause('slow-startup', SLOW_BANNER_MS), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'claude-busy-spinner': lifecycle({
    startup: [showFrame('idle-prompt', CLAUDE_IDLE)],
    working: [showFrame('busy', 'claude/2.1.325/busy-spinner.txt'), pause('working', BUSY_MS)],
    completed: showFrame('idle-prompt', 'claude/2.1.325/done.txt'),
  }),
  'codex-hooks-review': lifecycle({
    startup: [
      showFrame('hooks-review', 'codex/unversioned/hooks-review.txt'),
      {
        name: 'await-hooks-answer',
        run: async () => { while ((await nextLine('stdin_closed_before_hooks_answer')).trim() !== '3'); },
      },
      showFrame('idle-prompt', 'codex/0.167.0/idle.txt'),
    ],
    completed: showFrame('idle-prompt', 'codex/0.167.0/done.txt'),
  }),
  'cursor-arrow-prompt': lifecycle({
    startup: [showFrame('idle-prompt', 'cursor/unversioned/idle-arrow.txt')],
    completed: showFrame('idle-prompt', 'cursor/unversioned/idle-arrow.txt'),
  }),
  'loading-in-scrollback': lifecycle({
    startup: [showFrame('idle-prompt', 'claude/synthetic/loading-in-scrollback.txt')],
  }),
  'prompt-glyph-in-output': lifecycle({
    startup: [showFrame('quoted-output', 'claude/synthetic/prompt-glyph-in-output.txt'), pause('drawing-input-box', BUSY_MS), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'wrapped-trust-35col': lifecycle({
    startup: [claudeSelector('claude/2.1.310/trust-35col.txt'), showFrame('idle-prompt', CLAUDE_IDLE)],
  }),
  'provider-exit-to-shell-prompt': [
    showFrame('idle-prompt', CLAUDE_IDLE),
    pause('provider-running', PROVIDER_EXIT_MS),
    showFrame('shell-prompt', 'claude/synthetic/shell-prompt-after-exit-heavy-angle.txt'),
  ],
  'provider-exit-before-prompt': [
    showFrame('shell-prompt', 'claude/synthetic/shell-prompt-after-exit-heavy-angle.txt'),
  ],
  'recovery-continuation': [
    banner,
    idlePrompt,
    awaitStartupTrigger,
    {
      name: 'read-inbox',
      run: (context) => {
        const inbox = readFileSync(context.inboxPath, 'utf8');
        return inbox.includes('## Recovery Continuation')
          ? { continuations: parseRecoveryContinuations(inbox) }
          : readInbox.run(context);
      },
    },
    { ...claimTask, skip: ({ continuations }) => continuations !== undefined },
    { ...completeTask, skip: ({ continuations }) => continuations !== undefined },
    {
      name: 'write-checkpoint',
      skip: ({ continuations }) => continuations === undefined,
      run: ({ continuations }) => { for (const { checkpointCommand } of continuations) runTeamApi(checkpointCommand); },
    },
    {
      name: 'complete-adopted-task',
      skip: ({ continuations }) => continuations === undefined,
      run: ({ continuations }) => { for (const { completeCommand } of continuations) runTeamApi(completeCommand); },
    },
    completedPrompt,
    awaitShutdownRequest,
    writeShutdownAck,
  ],
};

const scenarioIndex = process.argv.indexOf('--scenario');
const scenarioName = (scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : process.env.OMC_FAKE_PROVIDER_SCENARIO) || 'default';
const STEPS = Object.hasOwn(SCENARIOS, scenarioName) ? SCENARIOS[scenarioName] : undefined;
if (!STEPS) {
  trace('failed', { failed_step: 'select-scenario', message: `unknown_scenario:${scenarioName}` });
  process.stdout.write(`fake-claude: unknown scenario ${scenarioName}\n`);
  process.exit(2);
}

let context = {};
for (const step of STEPS) {
  if (step.skip?.(context)) continue;
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
