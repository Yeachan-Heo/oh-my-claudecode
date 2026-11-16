#!/usr/bin/env node
/* global process, setTimeout, clearTimeout */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readStdin } from './lib/stdin.mjs';

function shouldSkipSubagentTracker(action) {
  if (process.env.DISABLE_OMC === '1' || process.env.DISABLE_OMC === 'true') {
    return true;
  }

  const skipHooks = (process.env.OMC_SKIP_HOOKS || '')
    .split(',')
    .map((hook) => hook.trim())
    .filter(Boolean);
  const hookName = action === 'start' ? 'subagent-start' : action === 'stop' ? 'subagent-stop' : 'subagent-tracker';

  return skipHooks.includes(hookName) || skipHooks.includes('subagent-tracker');
}

// Opt-in agent pool (OMC_JEV_POOL=1): the pool module is imported only when the variable is set,
// so with it unset this hook does no extra work. The pool is independent of the tracker skip
// switches and fails open.
const agentPoolEnabled = () => String(process.env.OMC_JEV_POOL ?? '').trim() === '1';

// Time cap of the agent pool step (ms). SubagentStart and PostToolUseFailure have the shortest
// manifest timeout of the hooks that run this step, 3 s. run.cjs stops a hook 1.5 s before its
// manifest timeout on Windows, and the rest of the hook runs after this step, so 1 s leaves about
// 0.5 s for it there.
const AGENT_POOL_STEP_LIMIT_MS = 1000;
let agentPoolStepTimedOut = false;

async function runAgentPool(data) {
  if (!agentPoolEnabled()) return;
  let timer;
  try {
    const step = import('./lib/jev-pool.mjs').then(({ handlePoolHookEvent }) => handlePoolHookEvent(data));
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => {
        agentPoolStepTimedOut = true;
        resolve();
      }, AGENT_POOL_STEP_LIMIT_MS);
    });
    await Promise.race([step, limit]);
  } catch { /* fail-open */ } finally {
    clearTimeout(timer);
  }
}

// A step past its cap can leave its handler holding timers or sockets, which would keep the process
// alive until run.cjs kills it and drops its output. Once stdout is flushed, exit with the exit code.
function exitAfterAgentPoolTimeout() {
  if (!agentPoolStepTimedOut) return;
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}

async function main() {
  const action = process.argv[2]; // 'start' or 'stop'

  if (shouldSkipSubagentTracker(action)) {
    if (agentPoolEnabled()) {
      try { await runAgentPool(JSON.parse(await readStdin())); } catch { /* fail-open */ }
    }
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Read stdin (timeout-protected, see issue #240/#459)
  const input = await readStdin();

  try {
    const data = JSON.parse(input);
    await runAgentPool(data);
    const { processSubagentStart, processSubagentStop } = await import('../dist/hooks/subagent-tracker/index.js');

    let result;
    if (action === 'start') {
      result = await processSubagentStart(data);
    } else if (action === 'stop') {
      result = await processSubagentStop(data);
    } else {
      console.error(`[subagent-tracker] Unknown action: ${action}`);
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[subagent-tracker] Error:', error.message);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main().then(exitAfterAgentPoolTimeout);
