/**
 * Declarative hook registry — #3698 / #3707.
 *
 * The installed registration (hooks/hooks.json) remains the runtime SSOT.
 * This module derives one declarative entry per installed command, assigning
 * risk classes by convention (only hard-risk entrypoints fail closed;
 * everything else is advisory/fail-open). No hand-maintained metadata table.
 *
 * Risk classes reuse the canonical taxonomy from src/workflow/registry.ts.
 */
import { failModeForRisk, } from '../../workflow/registry.js';
import { HOOK_EVENTS } from './types.js';
/**
 * Entry points that handle destructive tool calls or permission/security
 * boundaries — the only installed hooks that fail closed (owner decision 6).
 * Every other entrypoint is advisory and fails open.
 */
const HARD_RISK_ENTRYPOINTS = new Map([
    ['pre-tool-enforcer.mjs', 'destructive-mutation'],
    ['permission-handler.mjs', 'security-boundary'],
]);
const ENTRYPOINT_RE = /scripts\/([A-Za-z0-9._-]+\.mjs)((?:"|\s)[^"]*)?$/;
/** Parse an installed command into entrypoint basename + trailing args. */
export function parseEntrypointCommand(command) {
    const m = ENTRYPOINT_RE.exec(command);
    if (!m)
        return null;
    const tail = (m[2] ?? '').trim();
    const args = tail.length > 0 ? tail.split(/\s+/) : [];
    return { entrypoint: m[1], args };
}
/** Derive risk class by convention: only security/destructive hooks are hard-risk. */
function riskClassForEntrypoint(entrypoint) {
    return HARD_RISK_ENTRYPOINTS.get(entrypoint) ?? 'advisory';
}
function entryId(event, matcher, entrypoint, args) {
    const suffix = args.length > 0 ? `:${args.join(' ')}` : '';
    return `${event}:${matcher}:${entrypoint}${suffix}`;
}
/**
 * Derive the declarative registry from the installed hooks.json.
 * Risk classes are assigned by convention; no hand-maintained metadata.
 */
export function buildHookRegistry(hooksJson) {
    const entries = [];
    for (const [event, groups] of Object.entries(hooksJson)) {
        if (!HOOK_EVENTS.includes(event))
            continue;
        for (const group of groups) {
            group.hooks.forEach((hook, order) => {
                const parsed = parseEntrypointCommand(hook.command);
                if (!parsed)
                    return;
                const riskClass = riskClassForEntrypoint(parsed.entrypoint);
                entries.push({
                    id: entryId(event, group.matcher, parsed.entrypoint, parsed.args),
                    event: event,
                    matcher: group.matcher,
                    order,
                    entrypoint: parsed.entrypoint,
                    args: parsed.args,
                    timeoutMs: (hook.timeout ?? 0) * 1000,
                    async: hook.async === true,
                    riskClass,
                    failMode: failModeForRisk(riskClass),
                });
            });
        }
    }
    return entries;
}
/**
 * Registration drift guard: every hooks.json event must be a known lifecycle
 * event, every command must be parseable, and every hook must have a positive
 * timeout. Returns an empty array when registry and installation agree.
 */
export function validateRegistryAgainstHooksJson(hooksJson) {
    const issues = [];
    for (const [event, groups] of Object.entries(hooksJson)) {
        if (!HOOK_EVENTS.includes(event)) {
            issues.push({
                code: 'unknown-event',
                message: `hooks.json event "${event}" is not in the registry HOOK_EVENTS contract`,
            });
            continue;
        }
        for (const group of groups) {
            for (const hook of group.hooks) {
                const parsed = parseEntrypointCommand(hook.command);
                if (!parsed) {
                    issues.push({
                        code: 'unparseable-command',
                        message: `${event}/${group.matcher}: cannot parse command "${hook.command}"`,
                    });
                    continue;
                }
                const installedMs = (hook.timeout ?? 0) * 1000;
                if (installedMs <= 0) {
                    issues.push({
                        code: 'timeout-mismatch',
                        message: `${event}/${group.matcher}: "${parsed.entrypoint}" has no positive installed timeout`,
                    });
                }
            }
        }
    }
    return issues;
}
/** Registry entries applicable to one event+matcher input, in execution order. */
export function selectApplicableEntries(registry, event, matcherInput) {
    return registry
        .filter((e) => e.event === event &&
        (e.matcher === '*' || e.matcher === matcherInput))
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
//# sourceMappingURL=registry.js.map