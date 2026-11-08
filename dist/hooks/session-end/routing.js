/**
 * A declared verify command is interpolated into the link's `--allowedTools`
 * argv, which is comma-separated — so a comma, a shell metacharacter, or a
 * leading option dash would either split the allowlist entry or smuggle shell
 * syntax past the profile. Only plain command lines survive; anything else is
 * dropped, and a directive that keeps none of its commands simply runs with the
 * base profile.
 */
export const VERIFY_COMMAND_PATTERN = /^[A-Za-z][A-Za-z0-9 _.:/=%@-]*$/;
export const MAX_VERIFY_COMMANDS = 10;
export const MAX_VERIFY_COMMAND_LENGTH = 120;
function normalizeVerifyCommands(value) {
    if (!Array.isArray(value))
        return undefined;
    const commands = value
        .filter((entry) => typeof entry === 'string'
        && entry.length <= MAX_VERIFY_COMMAND_LENGTH
        && VERIFY_COMMAND_PATTERN.test(entry))
        .slice(0, MAX_VERIFY_COMMANDS);
    return commands.length > 0 ? commands : undefined;
}
/**
 * Keep only well-formed `outcome:reason` directives. A table written in the
 * nested shape (`{ success: { other: {...} } }`) yields no flat key, so
 * `decideNextStage` returns null and the chain halts as `no-route` — silently,
 * because a malformed table and a deliberate terminal look identical downstream.
 * Nested groups (keys without `:`) and non-directive entries are dropped.
 * Returns null for non-objects; an empty object is a valid, authoritative
 * empty table.
 */
export function normalizeRouteTable(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const entries = Object.entries(input);
    if (entries.length === 0)
        return {};
    const directives = {};
    for (const [key, value] of entries) {
        if (!key.includes(':'))
            continue;
        if (!value || typeof value !== 'object')
            continue;
        const { stage, skill, verify } = value;
        if (typeof stage !== 'string' || typeof skill !== 'string')
            continue;
        const verifyCommands = normalizeVerifyCommands(verify);
        directives[key] = verifyCommands ? { stage, skill, verify: verifyCommands } : { stage, skill };
    }
    return Object.keys(directives).length > 0 ? directives : null;
}
export function decideNextStage(outcome, reason, table) {
    return table[`${outcome}:${reason}`] ?? table[`${outcome}:*`] ?? null;
}
const CRITERIA = [
    ['irreversibleOrExternal', '判据一：不可逆或外部可见'],
    ['precedentSetting', '判据二：先例性'],
    ['valueJudgment', '判据三：价值判断'],
];
export function gradeGate(gate, facts) {
    if (gate === 'intent-accept')
        return { kind: 'human', criterion: '保留人闸：价值判断 + 消耗下游整条链，v1 无自动通道' };
    if (gate === 'review-approve') {
        if (facts.diffAttached === false)
            return { kind: 'human', criterion: 'diff 未附：总结是二手源（由被评审方写的），签收必须基于一手源（diff 或变更文件清单）' };
        return { kind: 'human', criterion: '保留人闸：合并不可逆且外部可见（判据一），v1 无黑区' };
    }
    for (const [key, label] of CRITERIA) {
        if (facts[key])
            return { kind: 'human', criterion: label };
    }
    if (!facts.mechanicalChecksPassed)
        return { kind: 'human', criterion: '机械验证项未全部通过' };
    return { kind: 'auto-pass', signerFact: '分级判据均未触发，机械验证项全部通过，自动过' };
}
//# sourceMappingURL=routing.js.map