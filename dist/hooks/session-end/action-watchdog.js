import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
/** Durable deadline evidence names the detached action runner from its control record when available. */
export function armSessionEndActionWatchdog(control) {
    const runPath = path.join(getOmcRoot(control.directory), 'state', 'session-end-jobs', 'runs', control.jobId, control.action, String(control.attempt), control.runnerNonce);
    const recordPath = path.join(runPath, 'watchdog.json');
    let runner = { pid: process.pid, processStartIdentity: 'watchdog-parent' };
    try {
        runner = JSON.parse(fs.readFileSync(path.join(runPath, 'control.json'), 'utf8')).runner ?? runner;
    }
    catch { /* runner control may race arm; manifest claim is authoritative */ }
    try {
        fs.mkdirSync(path.dirname(recordPath), { recursive: true });
        atomicWriteJsonSync(recordPath, { runner, startedAt: new Date().toISOString(), deadlineAt: new Date(control.deadlineAt).toISOString(), state: 'armed' });
    }
    catch {
        return () => undefined;
    }
    const timer = setTimeout(() => { try {
        atomicWriteJsonSync(recordPath, { runner, expiredAt: new Date().toISOString(), state: 'deadline-expired' });
    }
    catch { /* manifest retry handles failures */ } }, Math.max(0, control.deadlineAt - Date.now()));
    timer.unref();
    return () => { clearTimeout(timer); try {
        atomicWriteJsonSync(recordPath, { runner, stoppedAt: new Date().toISOString(), state: 'terminal' });
    }
    catch { /* best effort evidence only */ } };
}
//# sourceMappingURL=action-watchdog.js.map