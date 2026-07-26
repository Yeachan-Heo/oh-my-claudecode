/**
 * Compact, public-only Graph runtime status.
 */
import { cyan, red, yellow } from '../colors.js';
function renderStatus(status) {
    if (status === 'reconciling')
        return red(status);
    if (status === 'running')
        return cyan(status);
    return yellow(status);
}
export function renderGraph(state) {
    if (!state)
        return null;
    if (state.status === 'unreadable') {
        // Graph state file exists but could not be parsed (likely a transient
        // partial write mid-commit). Keep the indicator visible so the run is not
        // silently hidden during a live tick.
        return `G:${renderStatus(state.status)}`;
    }
    return [
        `G:${renderStatus(state.status)}`,
        `${state.completedActivations}/${state.totalActivations}`,
        `ready:${state.readyActivations}`,
        `live:${state.liveClaims}`,
        `reconcile:${state.unresolvedReconciliations}`,
        `#${state.revisionHashShort}`,
    ].join(' ');
}
//# sourceMappingURL=graph.js.map