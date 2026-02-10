/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */
import { z } from 'zod';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolveStatePath, ensureOmcDir, validateWorkingDirectory, resolveSessionStatePath, ensureSessionStateDir, listSessionIds, validateSessionId, } from '../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { isModeActive, getActiveModes, getAllModeStatuses, clearModeState, getStateFilePath, MODE_CONFIGS, getActiveSessionsForMode } from '../hooks/mode-registry/index.js';
// ExecutionMode from mode-registry (9 modes - NO ralplan)
const EXECUTION_MODES = [
    'autopilot', 'ultrapilot', 'swarm', 'pipeline', 'team',
    'ralph', 'ultrawork', 'ultraqa', 'ecomode'
];
// Extended type for state tools - includes ralplan which has state but isn't in mode-registry
const STATE_TOOL_MODES = [...EXECUTION_MODES, 'ralplan'];
/**
 * Get the state file path for any mode (including swarm and ralplan).
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For ralplan (not in registry): uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getStatePath(mode, root) {
    if (MODE_CONFIGS[mode]) {
        return getStateFilePath(root, mode);
    }
    // Fallback for modes not in registry (e.g., ralplan)
    return resolveStatePath(mode, root);
}
// ============================================================================
// state_read - Read state for a mode
// ============================================================================
export const stateReadTool = {
    name: 'state_read',
    description: 'Read the current state for a specific mode (ralph, ultrawork, autopilot, etc.). Returns the JSON state data or indicates if no state exists.',
    schema: {
        mode: z.enum(STATE_TOOL_MODES).describe('The mode to read state for'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // Special handling for swarm (SQLite database - no session support)
            if (mode === 'swarm') {
                const statePath = getStatePath(mode, root);
                if (!existsSync(statePath)) {
                    return {
                        content: [{
                                type: 'text',
                                text: `No state found for mode: swarm\nNote: Swarm uses SQLite (swarm.db), not JSON. Expected path: ${statePath}`
                            }]
                    };
                }
                return {
                    content: [{
                            type: 'text',
                            text: `## State for swarm\n\nPath: ${statePath}\n\nNote: Swarm uses SQLite database. Use swarm-specific tools to query state.`
                        }]
                };
            }
            // If session_id provided, read from session-scoped path
            if (sessionId) {
                validateSessionId(sessionId);
                const statePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sessionId)
                    : resolveSessionStatePath(mode, sessionId, root);
                if (!existsSync(statePath)) {
                    return {
                        content: [{
                                type: 'text',
                                text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
                            }]
                    };
                }
                const content = readFileSync(statePath, 'utf-8');
                const state = JSON.parse(content);
                return {
                    content: [{
                            type: 'text',
                            text: `## State for ${mode} (session: ${sessionId})\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
                        }]
                };
            }
            // No session_id: scan all sessions and legacy path
            const statePath = getStatePath(mode, root);
            const legacyExists = existsSync(statePath);
            const sessionIds = listSessionIds(root);
            const activeSessions = [];
            for (const sid of sessionIds) {
                const sessionStatePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sid)
                    : resolveSessionStatePath(mode, sid, root);
                if (existsSync(sessionStatePath)) {
                    activeSessions.push(sid);
                }
            }
            if (!legacyExists && activeSessions.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: `No state found for mode: ${mode}\nExpected legacy path: ${statePath}\nNo active sessions found.\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.`
                        }]
                };
            }
            let output = `## State for ${mode}\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.\n\n`;
            // Show legacy state if exists
            if (legacyExists) {
                try {
                    const content = readFileSync(statePath, 'utf-8');
                    const state = JSON.parse(content);
                    output += `### Legacy Path (shared)\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n`;
                }
                catch {
                    output += `### Legacy Path (shared)\nPath: ${statePath}\n*Error reading state file*\n\n`;
                }
            }
            // Show active sessions
            if (activeSessions.length > 0) {
                output += `### Active Sessions (${activeSessions.length})\n\n`;
                for (const sid of activeSessions) {
                    const sessionStatePath = MODE_CONFIGS[mode]
                        ? getStateFilePath(root, mode, sid)
                        : resolveSessionStatePath(mode, sid, root);
                    try {
                        const content = readFileSync(sessionStatePath, 'utf-8');
                        const state = JSON.parse(content);
                        output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n`;
                    }
                    catch {
                        output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n*Error reading state file*\n\n`;
                    }
                }
            }
            return {
                content: [{
                        type: 'text',
                        text: output
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_write - Write state for a mode
// ============================================================================
export const stateWriteTool = {
    name: 'state_write',
    description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Common fields (active, iteration, phase, etc.) can be set directly as parameters. Additional custom fields can be passed via the optional `state` parameter. Note: swarm uses SQLite and cannot be written via this tool.',
    schema: {
        mode: z.enum(STATE_TOOL_MODES).describe('The mode to write state for'),
        active: z.boolean().optional().describe('Whether the mode is currently active'),
        iteration: z.number().optional().describe('Current iteration number'),
        max_iterations: z.number().optional().describe('Maximum iterations allowed'),
        current_phase: z.string().optional().describe('Current execution phase'),
        task_description: z.string().optional().describe('Description of the task being executed'),
        plan_path: z.string().optional().describe('Path to the plan file'),
        started_at: z.string().optional().describe('ISO timestamp when the mode started'),
        completed_at: z.string().optional().describe('ISO timestamp when the mode completed'),
        error: z.string().optional().describe('Error message if the mode failed'),
        state: z.record(z.string(), z.unknown()).optional().describe('Additional custom state fields (merged with explicit parameters)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, active, iteration, max_iterations, current_phase, task_description, plan_path, started_at, completed_at, error, state, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // Swarm uses SQLite - cannot be written via this tool
            if (mode === 'swarm') {
                return {
                    content: [{
                            type: 'text',
                            text: `Error: Swarm uses SQLite database (swarm.db), not JSON. Use swarm-specific APIs to modify state.`
                        }],
                    isError: true
                };
            }
            // Determine state path based on session_id
            let statePath;
            if (sessionId) {
                validateSessionId(sessionId);
                ensureSessionStateDir(sessionId, root);
                statePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sessionId)
                    : resolveSessionStatePath(mode, sessionId, root);
            }
            else {
                ensureOmcDir('state', root);
                statePath = getStatePath(mode, root);
            }
            // Build state from explicit params + custom state
            const builtState = {};
            // Add explicit params (only if provided)
            if (active !== undefined)
                builtState.active = active;
            if (iteration !== undefined)
                builtState.iteration = iteration;
            if (max_iterations !== undefined)
                builtState.max_iterations = max_iterations;
            if (current_phase !== undefined)
                builtState.current_phase = current_phase;
            if (task_description !== undefined)
                builtState.task_description = task_description;
            if (plan_path !== undefined)
                builtState.plan_path = plan_path;
            if (started_at !== undefined)
                builtState.started_at = started_at;
            if (completed_at !== undefined)
                builtState.completed_at = completed_at;
            if (error !== undefined)
                builtState.error = error;
            // Merge custom state fields (explicit params take precedence)
            if (state) {
                for (const [key, value] of Object.entries(state)) {
                    if (!(key in builtState)) {
                        builtState[key] = value;
                    }
                }
            }
            // Add metadata
            const stateWithMeta = {
                ...builtState,
                _meta: {
                    mode,
                    sessionId: sessionId || null,
                    updatedAt: new Date().toISOString(),
                    updatedBy: 'state_write_tool'
                }
            };
            atomicWriteJsonSync(statePath, stateWithMeta);
            const sessionInfo = sessionId ? ` (session: ${sessionId})` : ' (legacy path)';
            const warningMessage = sessionId ? '' : '\n\nWARNING: No session_id provided. State written to legacy shared path which may leak across parallel sessions. Pass session_id for session-scoped isolation.';
            return {
                content: [{
                        type: 'text',
                        text: `Successfully wrote state for ${mode}${sessionInfo}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(stateWithMeta, null, 2)}\n\`\`\`${warningMessage}`
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================
export const stateClearTool = {
    name: 'state_clear',
    description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files.',
    schema: {
        mode: z.enum(STATE_TOOL_MODES).describe('The mode to clear state for'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // If session_id provided, clear only session-specific state
            if (sessionId) {
                validateSessionId(sessionId);
                if (MODE_CONFIGS[mode]) {
                    const success = clearModeState(mode, root, sessionId);
                    if (success) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: `Successfully cleared state for mode: ${mode} in session: ${sessionId}`
                                }]
                        };
                    }
                    else {
                        return {
                            content: [{
                                    type: 'text',
                                    text: `Warning: Some files could not be removed for mode: ${mode} in session: ${sessionId}`
                                }]
                        };
                    }
                }
                // Fallback for modes not in registry (e.g., ralplan)
                const statePath = resolveSessionStatePath(mode, sessionId, root);
                if (existsSync(statePath)) {
                    unlinkSync(statePath);
                    return {
                        content: [{
                                type: 'text',
                                text: `Successfully cleared state for mode: ${mode} in session: ${sessionId}\nRemoved: ${statePath}`
                            }]
                    };
                }
                else {
                    return {
                        content: [{
                                type: 'text',
                                text: `No state found to clear for mode: ${mode} in session: ${sessionId}`
                            }]
                    };
                }
            }
            // No session_id: clear from all locations (legacy + all sessions)
            let clearedCount = 0;
            const errors = [];
            // Clear legacy path
            if (MODE_CONFIGS[mode]) {
                // Only clear if state file exists - avoid false counts for missing files
                const legacyStatePath = getStateFilePath(root, mode);
                if (existsSync(legacyStatePath)) {
                    if (clearModeState(mode, root)) {
                        clearedCount++;
                    }
                    else {
                        errors.push('legacy path');
                    }
                }
            }
            else {
                const statePath = getStatePath(mode, root);
                if (existsSync(statePath)) {
                    try {
                        unlinkSync(statePath);
                        clearedCount++;
                    }
                    catch {
                        errors.push('legacy path');
                    }
                }
            }
            // Clear all session-scoped state files
            const sessionIds = listSessionIds(root);
            for (const sid of sessionIds) {
                if (MODE_CONFIGS[mode]) {
                    // Only clear if state file exists - avoid false counts for missing files
                    const sessionStatePath = getStateFilePath(root, mode, sid);
                    if (existsSync(sessionStatePath)) {
                        if (clearModeState(mode, root, sid)) {
                            clearedCount++;
                        }
                        else {
                            errors.push(`session: ${sid}`);
                        }
                    }
                }
                else {
                    const statePath = resolveSessionStatePath(mode, sid, root);
                    if (existsSync(statePath)) {
                        try {
                            unlinkSync(statePath);
                            clearedCount++;
                        }
                        catch {
                            errors.push(`session: ${sid}`);
                        }
                    }
                }
            }
            if (clearedCount === 0 && errors.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: `No state found to clear for mode: ${mode}`
                        }]
                };
            }
            let message = `Cleared state for mode: ${mode}\n- Locations cleared: ${clearedCount}`;
            if (errors.length > 0) {
                message += `\n- Errors: ${errors.join(', ')}`;
            }
            message += '\nWARNING: No session_id provided. Cleared legacy plus all session-scoped state; this is a broad operation that may affect other sessions.';
            return {
                content: [{
                        type: 'text',
                        text: message
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_list_active - List all active modes
// ============================================================================
export const stateListActiveTool = {
    name: 'state_list_active',
    description: 'List all currently active modes. Returns which modes have active state files.',
    schema: {
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // If session_id provided, show modes active for that specific session
            if (sessionId) {
                validateSessionId(sessionId);
                // Get active modes from registry for this session
                const activeModes = [...getActiveModes(root, sessionId)];
                // Also check ralplan for this session
                try {
                    const ralplanPath = resolveSessionStatePath('ralplan', sessionId, root);
                    if (existsSync(ralplanPath)) {
                        const content = readFileSync(ralplanPath, 'utf-8');
                        const state = JSON.parse(content);
                        if (state.active) {
                            activeModes.push('ralplan');
                        }
                    }
                }
                catch {
                    // Ignore parse errors
                }
                if (activeModes.length === 0) {
                    return {
                        content: [{
                                type: 'text',
                                text: `## Active Modes (session: ${sessionId})\n\nNo modes are currently active in this session.`
                            }]
                    };
                }
                const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');
                return {
                    content: [{
                            type: 'text',
                            text: `## Active Modes (session: ${sessionId}, ${activeModes.length})\n\n${modeList}`
                        }]
                };
            }
            // No session_id: show all active modes across all sessions
            const modeSessionMap = new Map();
            // Check legacy paths
            const legacyActiveModes = [...getActiveModes(root)];
            const ralplanPath = getStatePath('ralplan', root);
            if (existsSync(ralplanPath)) {
                try {
                    const content = readFileSync(ralplanPath, 'utf-8');
                    const state = JSON.parse(content);
                    if (state.active) {
                        legacyActiveModes.push('ralplan');
                    }
                }
                catch {
                    // Ignore parse errors
                }
            }
            for (const mode of legacyActiveModes) {
                if (!modeSessionMap.has(mode)) {
                    modeSessionMap.set(mode, []);
                }
                modeSessionMap.get(mode).push('legacy');
            }
            // Check all sessions
            const sessionIds = listSessionIds(root);
            for (const sid of sessionIds) {
                const sessionActiveModes = [...getActiveModes(root, sid)];
                // Also check ralplan for this session
                try {
                    const ralplanSessionPath = resolveSessionStatePath('ralplan', sid, root);
                    if (existsSync(ralplanSessionPath)) {
                        const content = readFileSync(ralplanSessionPath, 'utf-8');
                        const state = JSON.parse(content);
                        if (state.active) {
                            sessionActiveModes.push('ralplan');
                        }
                    }
                }
                catch {
                    // Ignore parse errors
                }
                for (const mode of sessionActiveModes) {
                    if (!modeSessionMap.has(mode)) {
                        modeSessionMap.set(mode, []);
                    }
                    modeSessionMap.get(mode).push(sid);
                }
            }
            if (modeSessionMap.size === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: '## Active Modes\n\nNo modes are currently active.'
                        }]
                };
            }
            const lines = [`## Active Modes (${modeSessionMap.size})\n`];
            for (const [mode, sessions] of Array.from(modeSessionMap.entries())) {
                lines.push(`- **${mode}** (${sessions.join(', ')})`);
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================
export const stateGetStatusTool = {
    name: 'state_get_status',
    description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
    schema: {
        mode: z.enum(STATE_TOOL_MODES).optional().describe('Specific mode to check (omit for all modes)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            if (mode) {
                // Single mode status
                const lines = [`## Status: ${mode}\n`];
                if (sessionId) {
                    // Session-specific status
                    validateSessionId(sessionId);
                    const statePath = MODE_CONFIGS[mode]
                        ? getStateFilePath(root, mode, sessionId)
                        : resolveSessionStatePath(mode, sessionId, root);
                    const active = MODE_CONFIGS[mode]
                        ? isModeActive(mode, root, sessionId)
                        : existsSync(statePath) && (() => {
                            try {
                                const content = readFileSync(statePath, 'utf-8');
                                const state = JSON.parse(content);
                                return state.active === true;
                            }
                            catch {
                                return false;
                            }
                        })();
                    let statePreview = 'No state file';
                    if (existsSync(statePath)) {
                        try {
                            const content = readFileSync(statePath, 'utf-8');
                            const state = JSON.parse(content);
                            statePreview = JSON.stringify(state, null, 2).slice(0, 500);
                            if (statePreview.length >= 500)
                                statePreview += '\n...(truncated)';
                        }
                        catch {
                            statePreview = 'Error reading state file';
                        }
                    }
                    lines.push(`### Session: ${sessionId}`);
                    lines.push(`- **Active:** ${active ? 'Yes' : 'No'}`);
                    lines.push(`- **State Path:** ${statePath}`);
                    lines.push(`- **Exists:** ${existsSync(statePath) ? 'Yes' : 'No'}`);
                    lines.push(`\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``);
                    return {
                        content: [{
                                type: 'text',
                                text: lines.join('\n')
                            }]
                    };
                }
                // No session_id: show all sessions + legacy
                const legacyPath = getStatePath(mode, root);
                const legacyActive = MODE_CONFIGS[mode]
                    ? isModeActive(mode, root)
                    : existsSync(legacyPath) && (() => {
                        try {
                            const content = readFileSync(legacyPath, 'utf-8');
                            const state = JSON.parse(content);
                            return state.active === true;
                        }
                        catch {
                            return false;
                        }
                    })();
                lines.push(`### Legacy Path`);
                lines.push(`- **Active:** ${legacyActive ? 'Yes' : 'No'}`);
                lines.push(`- **State Path:** ${legacyPath}`);
                lines.push(`- **Exists:** ${existsSync(legacyPath) ? 'Yes' : 'No'}\n`);
                // Show active sessions for this mode
                const activeSessions = MODE_CONFIGS[mode]
                    ? getActiveSessionsForMode(mode, root)
                    : listSessionIds(root).filter(sid => {
                        try {
                            const sessionPath = resolveSessionStatePath(mode, sid, root);
                            if (existsSync(sessionPath)) {
                                const content = readFileSync(sessionPath, 'utf-8');
                                const state = JSON.parse(content);
                                return state.active === true;
                            }
                            return false;
                        }
                        catch {
                            return false;
                        }
                    });
                if (activeSessions.length > 0) {
                    lines.push(`### Active Sessions (${activeSessions.length})`);
                    for (const sid of activeSessions) {
                        lines.push(`- ${sid}`);
                    }
                }
                else {
                    lines.push(`### Active Sessions\nNo active sessions for this mode.`);
                }
                return {
                    content: [{
                            type: 'text',
                            text: lines.join('\n')
                        }]
                };
            }
            // All modes status
            const statuses = getAllModeStatuses(root, sessionId);
            const lines = sessionId
                ? [`## All Mode Statuses (session: ${sessionId})\n`]
                : ['## All Mode Statuses\n'];
            for (const status of statuses) {
                const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
                lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
                lines.push(`   Path: \`${status.stateFilePath}\``);
                // Show active sessions if no specific session_id
                if (!sessionId && MODE_CONFIGS[status.mode]) {
                    const activeSessions = getActiveSessionsForMode(status.mode, root);
                    if (activeSessions.length > 0) {
                        lines.push(`   Active sessions: ${activeSessions.join(', ')}`);
                    }
                }
            }
            // Also check ralplan (not in MODE_CONFIGS)
            const ralplanPath = sessionId
                ? resolveSessionStatePath('ralplan', sessionId, root)
                : getStatePath('ralplan', root);
            let ralplanActive = false;
            if (existsSync(ralplanPath)) {
                try {
                    const content = readFileSync(ralplanPath, 'utf-8');
                    const state = JSON.parse(content);
                    ralplanActive = state.active === true;
                }
                catch {
                    // Ignore parse errors
                }
            }
            const ralplanIcon = ralplanActive ? '[ACTIVE]' : '[INACTIVE]';
            lines.push(`${ralplanIcon} **ralplan**: ${ralplanActive ? 'Active' : 'Inactive'}`);
            lines.push(`   Path: \`${ralplanPath}\``);
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
/**
 * All state tools for registration
 */
export const stateTools = [
    stateReadTool,
    stateWriteTool,
    stateClearTool,
    stateListActiveTool,
    stateGetStatusTool,
];
//# sourceMappingURL=state-tools.js.map