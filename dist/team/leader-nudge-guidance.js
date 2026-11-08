function activeTaskCount(input) {
    return input.tasks.pending + input.tasks.blocked + input.tasks.inProgress;
}
export function deriveTeamLeaderGuidance(input) {
    const activeTasks = activeTaskCount(input);
    const totalWorkers = Math.max(0, input.workers.total);
    const aliveWorkers = Math.max(0, input.workers.alive);
    const idleWorkers = Math.max(0, input.workers.idle);
    const nonReportingWorkers = Math.max(0, input.workers.nonReporting);
    if (activeTasks === 0) {
        return {
            nextAction: 'shutdown',
            reason: `all_tasks_terminal:completed=${input.tasks.completed},failed=${input.tasks.failed},workers=${totalWorkers}`,
            message: 'All tasks are in a terminal state. Review any failures, then shut down or clean up the current team.',
        };
    }
    if (aliveWorkers === 0) {
        return {
            nextAction: 'launch-new-team',
            reason: `no_alive_workers:active=${activeTasks},total_workers=${totalWorkers}`,
            message: 'Active tasks remain, but no workers appear alive. Launch a new team or replace the dead workers.',
        };
    }
    if (idleWorkers >= aliveWorkers) {
        return {
            nextAction: 'reuse-current-team',
            reason: `all_alive_workers_idle:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers}`,
            message: 'Workers are idle while active tasks remain. Reuse the current team and reassign, unblock, or restart the pending work.',
        };
    }
    if (nonReportingWorkers >= aliveWorkers) {
        return {
            nextAction: 'launch-new-team',
            reason: `all_alive_workers_non_reporting:active=${activeTasks},alive=${aliveWorkers},non_reporting=${nonReportingWorkers}`,
            message: 'Workers are still marked alive, but none are reporting progress. Launch a replacement team or restart the stuck workers.',
        };
    }
    return {
        nextAction: 'keep-checking-status',
        reason: `workers_still_active:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers},non_reporting=${nonReportingWorkers}`,
        message: 'Workers still appear active. Keep checking team status before intervening.',
    };
}
//# sourceMappingURL=leader-nudge-guidance.js.map