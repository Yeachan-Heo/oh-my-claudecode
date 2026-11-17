import { type ChainOutcome, type RouteTable } from './routing.js';
export interface SpawnNextTracker {
    repo: string;
    issue: number;
    nextLabel: string;
    failedLabel: string;
}
/** How a finished session hands the chain to the next stage. Supplied by the enqueuer in the action payload under `chain`. */
export interface SpawnNextChain {
    outcome: ChainOutcome;
    reason: string;
    routeTable: RouteTable;
    sessionId: string;
    /** Ledger identity carried through so the next link's ledger keeps it. */
    intentId?: string;
    handoffContext?: string;
    tracker?: SpawnNextTracker;
    /** Per-stage link counts carried forward so the enqueuer can cap route loops. */
    visits?: Record<string, number>;
    /** User setting-source opt-in captured at the first link and carried by its ledger. */
    includeUserSettings?: boolean;
}
export interface SpawnNextPlan {
    directive: {
        stage: string;
        skill: string;
    };
    handoffPath: string;
    spawnArgv: string[];
    /** Pre-generated id of the next link, passed via --session-id so its SessionEnd finds the ledger. */
    nextSessionId: string;
    trackerCommands: string[][];
}
export type SpawnFn = (command: string, args: string[], ctx?: SpawnContext) => {
    unref(): void;
};
/** Factory links spawn headless (AFK): their cwd must match the ledger's state root and their permission profile must be narrow. */
export interface SpawnContext {
    cwd?: string;
}
/**
 * AFK allowlist for factory-spawned sessions: gh read/comment, file read/write,
 * and github.com-only WebFetch. Everything else is denied in -p mode and must
 * fall back to HITL (the session's issue-comment contract), never silent failure.
 */
export declare const AFK_ALLOWED_TOOLS: string;
export declare const AFK_INCLUDE_USER_SETTINGS_ENV = "OMC_AFK_INCLUDE_USER_SETTINGS";
export declare const AFK_SPAWN_FLAGS: string[];
/**
 * Args (command excluded) for one factory chain link: intent prompt + AFK
 * permission profile. A stage's declared `verify` commands extend the profile
 * with exactly those `Bash(...)` entries — the argv is a trust boundary, so
 * they are re-checked against the routing pattern here rather than trusted from
 * whatever route table produced the directive.
 */
export declare function factoryLinkArgv(prompt: string, sessionId: string, verifyCommands?: readonly string[], fixedBashCommands?: readonly string[], includeUserSettings?: boolean): string[];
/** Shared label charset (stage/skill/labels): safe for paths and argv. */
export declare const LABEL_PATTERN: RegExp;
/**
 * The chain rides a detached manifest job: every field that lands in a
 * spawned argv or a filesystem path is validated here. An invalid chain is a
 * hard reject (manifest failure), not a partial spawn.
 */
export declare function validateChainFields(chain: SpawnNextChain): void;
export declare function spawnNextAlertComment(chain: SpawnNextChain): string;
export declare function planSpawnNext(chain: SpawnNextChain, omcRoot: string): SpawnNextPlan | null;
/** IO orchestration only: the routing decision comes from the T1 pure function via planSpawnNext. */
export declare function executeSpawnNext(chain: SpawnNextChain, directory: string, spawnFn?: SpawnFn): void;
/**
 * `claude` and `gh` are .cmd shims on Windows, which CreateProcess cannot exec
 * directly; route those through cmd.exe. The -p prompt for claude and --body
 * for gh go through stdin on Windows: cmd.exe's ANSI codepage mangles non-ASCII
 * argv (dogfood: Chinese intent prompts and issue bodies mojibake'd), while the
 * stdin pipe stays UTF-8 end to end. This prevents cmd.exe's quote handling
 * from being exploited: backslash-quote is not an escape (unlike POSIX shells),
 * so embedded quotes would toggle quoting and allow shell metacharacters (&|<>)
 * to run as commands. Additionally, cmd.exe expands %VAR% inside quotes,
 * risking env var leaks. Using stdin with --body-file - and stdin with -p
 * neutralizes both issues while maintaining proper argument escaping via
 * quoteForCmd (which doubles quotes and percent signs, rejecting CR/LF).
 *
 * The .cmd-shim constraint is a Windows PLATFORM fact, not a shell fact: gate
 * on process.platform, never on shell detection. Gating on the shell made
 * Git Bash (MSYSTEM set) skip the cmd.exe route and spawn the .cmd shim
 * directly, which CreateProcess cannot exec — the child died instantly and
 * silently (stdio ignored), so `omc ralph afk` under Git Bash launched
 * nothing. Factory chain links escaped this only by accident: the detached
 * worker's env is an allowlist that drops MSYSTEM. The long-running factory
 * listener (src/factory/listener.ts), which spawns links from its own
 * inherited environment, had the same broken route under Git Bash.
 *
 * detached:true is win32-hostile here (dogfood bisect: cmd.exe children
 * spawned detached exit 1 before writing a transcript), so it is only
 * applied off-win32. Orphaning still holds: Windows children survive
 * parent exit without the detached flag.
 */
export declare function defaultSpawnFn(command: string, args: string[], ctx?: SpawnContext): {
    unref(): void;
};
//# sourceMappingURL=spawn-next.d.ts.map