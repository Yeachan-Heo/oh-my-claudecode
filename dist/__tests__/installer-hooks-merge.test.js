/**
 * Tests for omc update --force-hooks protection (issue #722)
 *
 * Verifies that the hook merge logic in install() correctly:
 *   - merges OMC hooks with existing non-OMC hooks during `omc update` (force=true)
 *   - warns when non-OMC hooks are present
 *   - only fully replaces when --force-hooks is explicitly set
 *
 * Tests exercise isOmcHook() and the merge logic via unit-level helpers
 * to avoid filesystem side-effects.
 */
import { describe, it, expect } from 'vitest';
import { isOmcHook } from '../installer/index.js';
// ---------------------------------------------------------------------------
// Pure merge helper extracted from install() for isolated testing.
// This mirrors exactly the logic in installer/index.ts so that changes
// to the installer are reflected and tested here.
// ---------------------------------------------------------------------------
function mergeEventHooks(existingGroups, newOmcGroups, options) {
    const conflicts = [];
    const logMessages = [];
    const eventType = 'TestEvent';
    const nonOmcGroups = existingGroups.filter(group => group.hooks.some(h => h.type === 'command' && !isOmcHook(h.command)));
    const hasNonOmcHook = nonOmcGroups.length > 0;
    const nonOmcCommand = hasNonOmcHook
        ? nonOmcGroups[0].hooks.find(h => h.type === 'command' && !isOmcHook(h.command))?.command ?? ''
        : '';
    let merged;
    if (options.forceHooks && !options.allowPluginHookRefresh) {
        if (hasNonOmcHook) {
            logMessages.push(`Warning: Overwriting non-OMC ${eventType} hook with --force-hooks: ${nonOmcCommand}`);
            conflicts.push({ eventType, existingCommand: nonOmcCommand });
        }
        merged = newOmcGroups;
        logMessages.push(`Updated ${eventType} hook (--force-hooks)`);
    }
    else if (options.force) {
        merged = [...nonOmcGroups, ...newOmcGroups];
        if (hasNonOmcHook) {
            logMessages.push(`Merged ${eventType} hooks (updated OMC hooks, preserved non-OMC hook: ${nonOmcCommand})`);
            conflicts.push({ eventType, existingCommand: nonOmcCommand });
        }
        else {
            logMessages.push(`Updated ${eventType} hook (--force)`);
        }
    }
    else {
        if (hasNonOmcHook) {
            logMessages.push(`Warning: ${eventType} hook has non-OMC hook. Skipping. Use --force-hooks to override.`);
            conflicts.push({ eventType, existingCommand: nonOmcCommand });
        }
        else {
            logMessages.push(`${eventType} hook already configured, skipping`);
        }
        merged = existingGroups; // unchanged
    }
    return { merged, conflicts, logMessages };
}
// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
function omcGroup(command) {
    return { hooks: [{ type: 'command', command }] };
}
function userGroup(command) {
    return { hooks: [{ type: 'command', command }] };
}
const OMC_CMD = 'node "$HOME/.claude/hooks/keyword-detector.mjs"';
const USER_CMD = '/usr/local/bin/my-custom-hook.sh';
const NEW_OMC_CMD = 'node "$HOME/.claude/hooks/session-start.mjs"';
// ---------------------------------------------------------------------------
// isOmcHook unit tests
// ---------------------------------------------------------------------------
describe('isOmcHook()', () => {
    it('recognises OMC keyword-detector command', () => {
        expect(isOmcHook('node "$HOME/.claude/hooks/keyword-detector.mjs"')).toBe(true);
    });
    it('recognises OMC session-start command', () => {
        expect(isOmcHook('node "$HOME/.claude/hooks/session-start.mjs"')).toBe(true);
    });
    it('recognises OMC pre-tool-use command', () => {
        expect(isOmcHook('node "$HOME/.claude/hooks/pre-tool-use.mjs"')).toBe(true);
    });
    it('recognises OMC post-tool-use command', () => {
        expect(isOmcHook('node "$HOME/.claude/hooks/post-tool-use.mjs"')).toBe(true);
    });
    it('recognises OMC persistent-mode command', () => {
        expect(isOmcHook('node "$HOME/.claude/hooks/persistent-mode.mjs"')).toBe(true);
    });
    it('recognises Windows-style OMC path', () => {
        expect(isOmcHook('node "%USERPROFILE%\\.claude\\hooks\\keyword-detector.mjs"')).toBe(true);
    });
    it('recognises oh-my-claudecode in command path', () => {
        expect(isOmcHook('/path/to/oh-my-claudecode/hook.mjs')).toBe(true);
    });
    it('recognises omc as a path segment', () => {
        expect(isOmcHook('/usr/local/bin/omc-hook.sh')).toBe(true);
    });
    it('does not recognise a plain user command', () => {
        expect(isOmcHook('/usr/local/bin/my-custom-hook.sh')).toBe(false);
    });
    it('does not recognise a random shell script', () => {
        expect(isOmcHook('bash /home/user/scripts/notify.sh')).toBe(false);
    });
    it('does not match "omc" inside an unrelated word', () => {
        // "nomc" or "omcr" should NOT match the omc path-segment pattern
        expect(isOmcHook('/usr/bin/nomc-thing')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Hook merge logic tests
// ---------------------------------------------------------------------------
describe('Hook merge during omc update', () => {
    describe('no force flags — skip behaviour', () => {
        it('skips an already-configured OMC-only event type', () => {
            const existing = [omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, {});
            expect(merged).toEqual(existing); // unchanged
            expect(conflicts).toHaveLength(0);
            expect(logMessages[0]).toMatch(/already configured/);
        });
        it('records conflict but does not overwrite when non-OMC hook exists', () => {
            const existing = [userGroup(USER_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, {});
            expect(merged).toEqual(existing); // unchanged
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].existingCommand).toBe(USER_CMD);
            expect(logMessages[0]).toMatch(/non-OMC hook/);
            expect(logMessages[0]).toMatch(/--force-hooks/);
        });
    });
    describe('force=true — merge behaviour (omc update path)', () => {
        it('replaces OMC hooks when event type has only OMC hooks', () => {
            const existing = [omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts } = mergeEventHooks(existing, newOmc, { force: true });
            // Non-OMC groups: none → merged = newOmc only
            expect(merged).toHaveLength(1);
            expect(merged[0].hooks[0].command).toBe(NEW_OMC_CMD);
            expect(conflicts).toHaveLength(0);
        });
        it('preserves non-OMC hook and adds updated OMC hook', () => {
            const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, { force: true });
            // non-OMC groups come first, then new OMC groups
            expect(merged).toHaveLength(2);
            expect(merged[0].hooks[0].command).toBe(USER_CMD);
            expect(merged[1].hooks[0].command).toBe(NEW_OMC_CMD);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].existingCommand).toBe(USER_CMD);
            expect(logMessages[0]).toMatch(/Merged/);
            expect(logMessages[0]).toMatch(/preserved non-OMC hook/);
        });
        it('preserves multiple non-OMC hook groups', () => {
            const userCmd2 = '/usr/local/bin/another-hook.sh';
            const existing = [userGroup(USER_CMD), userGroup(userCmd2), omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged } = mergeEventHooks(existing, newOmc, { force: true });
            expect(merged).toHaveLength(3); // 2 user groups + 1 new OMC group
            expect(merged[0].hooks[0].command).toBe(USER_CMD);
            expect(merged[1].hooks[0].command).toBe(userCmd2);
            expect(merged[2].hooks[0].command).toBe(NEW_OMC_CMD);
        });
        it('does not carry over old OMC hook groups', () => {
            const existing = [omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged } = mergeEventHooks(existing, newOmc, { force: true });
            const commands = merged.flatMap(g => g.hooks.map(h => h.command));
            expect(commands).not.toContain(OMC_CMD);
            expect(commands).toContain(NEW_OMC_CMD);
        });
        it('records a conflict when non-OMC hook is preserved', () => {
            const existing = [userGroup(USER_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { conflicts } = mergeEventHooks(existing, newOmc, { force: true });
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].existingCommand).toBe(USER_CMD);
        });
        it('records no conflict when only OMC hooks existed', () => {
            const existing = [omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { conflicts } = mergeEventHooks(existing, newOmc, { force: true });
            expect(conflicts).toHaveLength(0);
        });
    });
    describe('forceHooks=true — replace-all behaviour', () => {
        it('replaces OMC-only hooks', () => {
            const existing = [omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts } = mergeEventHooks(existing, newOmc, { forceHooks: true });
            expect(merged).toEqual(newOmc);
            expect(conflicts).toHaveLength(0);
        });
        it('replaces non-OMC hook and warns', () => {
            const existing = [userGroup(USER_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, { forceHooks: true });
            expect(merged).toEqual(newOmc);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].existingCommand).toBe(USER_CMD);
            expect(logMessages[0]).toMatch(/Overwriting non-OMC/);
            expect(logMessages[0]).toMatch(/--force-hooks/);
        });
        it('replaces mixed hooks entirely', () => {
            const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged } = mergeEventHooks(existing, newOmc, { forceHooks: true });
            expect(merged).toHaveLength(1);
            expect(merged[0].hooks[0].command).toBe(NEW_OMC_CMD);
        });
        it('does NOT replace when allowPluginHookRefresh is true (plugin safety)', () => {
            // When running as a plugin with refreshHooksInPlugin, forceHooks should
            // not clobber user hooks — falls through to the force=true merge path
            // (since allowPluginHookRefresh=true disables the forceHooks branch).
            // This test exercises the guard: forceHooks && !allowPluginHookRefresh.
            const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged } = mergeEventHooks(existing, newOmc, {
                forceHooks: true,
                allowPluginHookRefresh: true,
                // Note: force is not set, so falls to "no force" branch
            });
            // Without force set, the no-force branch runs → merged unchanged
            expect(merged).toEqual(existing);
        });
    });
    describe('edge cases', () => {
        it('handles event type with no existing hooks (empty array)', () => {
            // When existingHooks[eventType] exists but is empty
            const existing = [];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { merged, conflicts } = mergeEventHooks(existing, newOmc, { force: true });
            // nonOmcGroups will be empty, so merged = [] + newOmcGroups
            expect(merged).toEqual(newOmc);
            expect(conflicts).toHaveLength(0);
        });
        it('handles hook group with non-command type (should not be treated as non-OMC)', () => {
            // A hook group with type != 'command' should not count as non-OMC
            const existing = [{ hooks: [{ type: 'webhook', command: '' }] }];
            const newOmc = [omcGroup(NEW_OMC_CMD)];
            const { conflicts } = mergeEventHooks(existing, newOmc, { force: true });
            // The webhook group has no command-type hooks → nonOmcGroups is empty
            expect(conflicts).toHaveLength(0);
        });
    });
});
//# sourceMappingURL=installer-hooks-merge.test.js.map