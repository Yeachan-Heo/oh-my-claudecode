import { execFile } from "node:child_process";
declare const execFileAsync: typeof execFile.__promisify__;
/**
 * Herdr team runtime backend (issue #3241, Phase 2).
 *
 * When the multiplexer setting resolves to 'herdr' (src/config/multiplexer.ts),
 * team workers run as Herdr workspaces/tabs/agents instead of tmux
 * sessions/windows/panes:
 *
 *   - one Herdr workspace per team, labelled `omx-team-<name>` (visible in the
 *     Herdr sidebar, replacing the tmux HUD watch pane)
 *   - one tab per worker, carrying the worker env via `tab create --env`
 *   - one agent per tab, started with `agent start --kind <cli>` and driven
 *     through the semantic agent surface (`agent prompt` / `agent read` /
 *     `agent get`) instead of raw keystrokes
 *
 * Design constraints inherited from the Phase 1 bridge (src/adapt/herdr):
 *   - execFile argv arrays only, never a shell string
 *   - the binary is trust-pinned to HERDR_BIN_PATH when present
 *   - a Herdr failure surfaces as a typed error; callers decide severity
 *
 * The headless server is auto-started on demand (`herdr server` daemonizes the
 * pane runtime), because Herdr CLI commands fail with `server_not_running`
 * otherwise.
 */
export declare const HERDR_TEAM_WORKSPACE_LABEL_PREFIX = "omc-team-";
export interface HerdrExecOptions {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Injectable for tests. */
    execFn?: typeof execFileAsync;
}
export declare class HerdrError extends Error {
    readonly code: string;
    readonly detail?: string | undefined;
    constructor(code: string, message: string, detail?: string | undefined);
}
/** JSON envelope every Herdr control command answers with. */
export interface HerdrEnvelope {
    id?: string;
    result?: unknown;
    error?: {
        code?: string;
        message?: string;
    };
}
export declare function parseHerdrEnvelope(stdout: string): HerdrEnvelope;
/**
 * Resolve the Herdr binary. HERDR_BIN_PATH wins when it is an absolute path to
 * an existing file (same trust-pinning as the Phase 1 bridge); otherwise the
 * plain `herdr` name is used and resolved by PATH, mirroring how OMX invokes
 * `tmux` today. Returns null when Herdr cannot be trusted to exist.
 */
export declare function resolveHerdrBinary(env?: NodeJS.ProcessEnv): string | null;
export declare function isHerdrBinaryCallable(bin?: string | null): Promise<boolean>;
export declare function runHerdr(args: string[], options?: HerdrExecOptions): Promise<HerdrEnvelope>;
export declare function runHerdrResult<T>(args: string[], options?: HerdrExecOptions): Promise<T>;
/**
 * Run a Herdr command that prints plain text instead of the JSON envelope
 * (pane/agent `read` on the CLI surface). Stderr is still decoded as a JSON
 * error envelope when possible.
 */
export declare function runHerdrRaw(args: string[], options?: HerdrExecOptions): Promise<string>;
export interface HerdrPaneLikeInfo {
    pane_id?: string;
    workspace_id?: string;
    tab_id?: string;
    cwd?: string;
    agent_status?: string;
}
export interface HerdrAgentLikeInfo {
    name?: string;
    agent?: string;
    pane_id?: string;
    agent_status?: string;
    interactive_ready?: boolean;
}
export interface HerdrWorkspaceLikeInfo {
    workspace_id?: string;
    label?: string;
}
/**
 * Ensure a Herdr server owns the socket. When `agent list` answers
 * `server_not_running`, spawn the headless `herdr server` detached and poll
 * until commands answer (workers then outlive the OMX process, which is the
 * Herdr model). Throws herdr_server_start_failed on timeout.
 */
export declare function ensureHerdrServer(options?: {
    env?: NodeJS.ProcessEnv;
    bin?: string;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<"running" | "started">;
export declare function buildWorkspaceCreateArgs(cwd: string, label: string): string[];
export declare function buildTabCreateArgs(workspaceId: string, cwd: string, label: string, env?: Record<string, string>): string[];
export declare function buildAgentStartArgs(name: string, kind: string, paneId: string, agentArgs?: readonly string[], timeoutMs?: number): string[];
export declare function buildAgentPromptArgs(name: string, text: string): string[];
export declare function buildAgentGetArgs(name: string): string[];
export declare function buildPaneReadArgs(paneId: string, lines: number): string[];
export declare function buildAgentSendKeysArgs(name: string, key: string): string[];
export declare function buildTabCloseArgs(tabId: string): string[];
export declare function buildWorkspaceCloseArgs(workspaceId: string): string[];
/**
 * Herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/ and be unique among
 * live agents. Build a deterministic, collision-resistant name:
 * `omx-<team[:10]>-<hash4>-w<index>`.
 */
export declare function buildHerdrAgentName(teamName: string, workerIndex: number): string;
export declare function herdrWorkspaceIdFromPaneId(paneId: string): string;
export declare function herdrWorkspaceIdFromSessionTarget(sessionTarget: string): string;
/**
 * Create a workspace for any Herdr-backed surface. Team code uses
 * herdrCreateTeamWorkspace for the `omc-team-` label contract; launch and
 * interop surfaces call this directly with their own labels.
 */
export declare function herdrCreateWorkspace(cwd: string, label: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<string>;
/** Create the team workspace; workers become tabs inside it. */
export declare function herdrCreateTeamWorkspace(cwd: string, label: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<string>;
/** Split-equivalent: one tab per worker, returning the new root pane id. */
export declare function herdrCreateWorkerTab(workspaceId: string, cwd: string, label: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<{
    paneId: string;
    tabId: string;
}>;
/** Deliver a shell command (team start command) into a worker pane. */
export declare function herdrRunPaneCommand(paneId: string, command: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/**
 * Submit work to the recognized agent occupying the pane. Agent commands
 * accept the hosting pane id directly; Herdr validates agent identity,
 * honors bracketed paste, and refuses to type into approval dialogs.
 */
export declare function herdrSendPrompt(paneId: string, text: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/** Send a logical key (esc/enter/ctrl+c) to the agent occupying the pane. */
export declare function herdrSendKey(paneId: string, key: "enter" | "esc" | "escape" | "ctrl+c", options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/**
 * Live agent inventory (the `agent list` result). Detectors and liveness
 * surfaces iterate this instead of shelling out per pane; names are cleared
 * when agents exit, so presence here is the liveness proof.
 */
export declare function listHerdrAgents(options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<HerdrAgentLikeInfo[]>;
/** Readiness probe: the recognized agent occupying the pane, or null. */
export declare function herdrAgentInfo(paneId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<HerdrAgentLikeInfo | null>;
/** Submit a task to a worker through the semantic agent surface. */
export declare function submitToHerdrWorker(agentName: string, text: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/** Interrupt the agent turn (Ctrl+C equivalent). */
export declare function interruptHerdrWorker(agentName: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/**
 * Capture worker output for the shared pane-text classifiers
 * (`paneLooksReady` / `paneHasActiveTask`, src/scripts/tmux-hook-engine).
 * `recent-unwrapped` matches tmux `capture-pane -J` semantics: soft wraps
 * joined, ANSI stripped.
 */
export declare function captureHerdrWorkerPane(paneId: string, lines?: number, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<string>;
/**
 * Worker liveness. `pane get` keeps answering for closed panes (IDs are never
 * reused), so liveness is proven through the live-agent inventory instead:
 * agent names are cleared when the agent exits.
 *
 * An inventory query that fails (server down, timeout, binary missing) is NOT
 * proof of death: the error propagates so liveness callers can report
 * 'unknown'. Only a successfully answered inventory that excludes the pane
 * proves the worker gone.
 */
export declare function isHerdrWorkerAlive(paneId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<boolean>;
export declare function buildWorkspacePaneListArgs(workspaceId: string): string[];
export type HerdrWorkspaceExistence = "exists" | "unavailable";
/**
 * Check if a Herdr workspace exists without requiring a specific pane.
 * Used for workspace-level operations like team resume verification.
 *
 *   - 'exists': the workspace query succeeded (panes list, even if empty)
 *   - 'unavailable': the query failed (server/binary/timeout)
 */
export declare function herdrWorkspaceExists(workspaceId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<HerdrWorkspaceExistence>;
export type HerdrPaneMembership = "member" | "foreign" | "unavailable";
/**
 * Prove a pane still exists inside the configured workspace, without
 * requiring a live agent in it. `pane list --workspace` enumerates only live
 * panes of that workspace (a closed pane is absent even though `pane get`
 * keeps answering for some closed-pane states), so membership in this list
 * proves both pane existence and workspace ownership:
 *
 *   - 'member': the workspace pane list contains the pane id. This is the
 *     pre-launch ownership proof for a freshly allocated worker tab, which
 *     hosts only a shell until the start command is delivered.
 *   - 'foreign': the workspace answered and the pane is not in it. The pane
 *     either no longer exists or belongs elsewhere; either way the persisted
 *     target does not own it.
 *   - 'unavailable': the query itself failed (server/binary/timeout). An
 *     observation failure is not evidence about the pane.
 */
export declare function herdrPaneWorkspaceMembership(paneId: string, workspaceId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<HerdrPaneMembership>;
/**
 * Close the worker's pane (and with it the agent). Pane ids are the stable
 * address Herdr hands out (`wN:pM`); tab ids cannot be derived from them, so
 * teardown addresses the pane directly.
 */
export declare function teardownHerdrWorker(paneId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/** Close the whole team workspace (session teardown). */
export declare function destroyHerdrTeam(workspaceId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<void>;
/** List teams by workspace label prefix, mirroring listTeamSessions. */
export declare function listHerdrTeams(options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}): Promise<Array<{
    workspaceId: string;
    teamName: string;
    label: string;
}>>;
/** Close a worker pane (alias of teardownHerdrWorker for the provider arms). */
export declare const herdrClosePane: (paneId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}) => Promise<void>;
/** Close the whole team workspace (alias of destroyHerdrTeam). */
export declare const herdrCloseWorkspace: (workspaceId: string, options?: {
    env?: NodeJS.ProcessEnv;
    execFn?: HerdrExecOptions["execFn"];
}) => Promise<void>;
export {};
//# sourceMappingURL=herdr-session.d.ts.map