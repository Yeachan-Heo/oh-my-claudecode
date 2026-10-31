/**
 * `omc ralph afk "<task>" [--verify "<command>"]...` — launch a headless,
 * narrowly-permissioned ralph session and return to the prompt.
 *
 * Reuses the factory chain's AFK link profile (scoped allowlist +
 * project,local settings) and its argv builder, so a ralph run spawned here
 * obeys the same default isolation contract as a chain link: user-level hooks
 * and settings are excluded unless OMC_AFK_INCLUDE_USER_SETTINGS=1 is set, no
 * general Bash is allowed, and only the gh/file/WebFetch surface, the
 * read-only git commands ralph's own stale-state detection needs, and exactly
 * the declared `--verify` commands are available.
 *
 * Two consequences of the default isolation shape the launch:
 * - A session with `--setting-sources project,local` cannot see
 *   plugin-bundled skills, so a `/oh-my-claudecode:ralph` prompt degrades
 *   into a plain one-shot request. The ralph skill is materialized as a
 *   PROJECT skill before launch (the chain-ring contract) and invoked as
 *   `/ralph`.
 * - The mandatory deslop pass (Step 7.5) invokes the plugin-bundled
 *   `ai-slop-cleaner` skill, which such a session equally cannot see — the
 *   pass could never complete and the loop would stall. The launch
 *   therefore injects `--no-deslop`; HITL ralph runs keep the pass.
 */
import type { Command } from 'commander';
import { type CommandBaseline } from '../../hooks/ralph/feedback-baseline.js';
/**
 * The session's own feedback gate must be runnable inside the session: the
 * loop's continuation context (getRalphContext), the startup notice, and the
 * skill's NON-NEGOTIABLE precondition block all call `omc ralph verify` and
 * nothing else. Prefix-matched so `--write-baseline` / `--session <id>` /
 * `--json` all pass.
 *
 * Deliberately no OMC MCP entries: a live probe of an isolated session
 * (`--setting-sources project,local`) showed the bridge MCP server does not
 * register there at all — trace_summary / state_write / state_read simply do
 * not exist, so allowlist entries for them would be cargo-cult. Consequence,
 * documented in the skill's budget rule: the token-budget stop is
 * attended-only; headless cost control is task sizing.
 */
export declare const RALPH_AFK_SESSION_COMMANDS: string[];
/**
 * Env var carrying the launcher's declared --verify list (JSON array) into the
 * headless session. When present, `omc ralph verify` runs exactly these
 * commands and ignores the PRD's feedbackCommands and package.json detection:
 * the session can edit both with its file tools, so trusting them would turn
 * the always-granted `omc ralph verify` entry into an arbitrary-shell escape
 * from the allowlist.
 */
export declare const RALPH_AFK_FEEDBACK_ENV = "OMC_RALPH_AFK_FEEDBACK";
/** The declared --verify commands that pass the same boundary check as the allowlist. */
export declare function afkFeedbackCommands(verifyCommands: readonly string[]): string[];
/** Args (command excluded) for one headless AFK ralph launch. */
export declare function ralphAfkArgv(task: string, verifyCommands?: readonly string[], sessionId?: string): string[];
export type SkillMaterialization = {
    status: 'created';
    path: string;
} | {
    status: 'present' | 'diverged';
    path: string;
};
/**
 * Materialize the bundled ralph skill into the project's skill scope so the
 * isolated session can load it. An existing project copy is never clobbered:
 * identical content is a no-op, diverged content is reported so a stale copy
 * from an older OMC install cannot silently persist across upgrades.
 */
export declare function materializeRalphSkill(directory: string): SkillMaterialization | null;
export declare function ralphCommand(program: Command): Command;
/**
 * Feedback commands for judgment. Inside an `omc ralph afk` session only the
 * launcher-declared list counts; otherwise the PRD's declared list, else
 * package-script detection. A found but unreadable PRD returns its error
 * instead of falling through to package-script detection.
 */
export declare function resolveFeedbackCommands(directory: string, sessionId?: string): {
    commands: string[];
    prdError?: string;
};
/** Run one feedback command on the current tree and fingerprint its failures. */
export declare function runFeedbackCommand(command: string, directory: string): CommandBaseline;
/** The verify action, extracted so tests can drive it directly. Exit code is the contract. */
export declare function ralphVerify(options: {
    json?: boolean;
    session?: string;
    writeBaseline?: boolean;
}, directory?: string, now?: Date): number;
//# sourceMappingURL=ralph.d.ts.map