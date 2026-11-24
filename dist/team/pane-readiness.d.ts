import type { CliAgentType } from './model-contract.js';
export type PaneTrustPromptKind = 'directory' | 'claude_directory' | 'codex_directory' | 'codex_hooks' | 'cursor_workspace_trust';
/**
 * What one pane capture shows. The signals are independent: a working provider
 * keeps its input box drawn, so `idlePrompt` and `busy` are often both true.
 */
export interface PaneSignals {
    trust: PaneTrustPromptKind | null;
    /** A startup word anywhere on screen, or the startup banner. Read before sending keys. */
    bootstrapping: boolean;
    /**
     * A startup word on a status line, or the startup banner. Read by classifyPane,
     * so a reply that mentions "loading" does not keep an idle pane starting.
     */
    startupStatus: boolean;
    idlePrompt: boolean;
    busy: boolean;
}
export interface ProviderPanePatterns {
    readonly idlePromptLine: RegExp;
    readonly busyLines: readonly RegExp[];
    /** Counts as bootstrapping only while no idle prompt is drawn. */
    readonly startupBannerLines: readonly RegExp[];
    readonly loadingLines: readonly RegExp[];
    readonly startupStatusLines: readonly RegExp[];
    readonly trustKinds: readonly PaneTrustPromptKind[];
    /** Provider version whose recorded frames are in the pane-frame corpus. */
    readonly verifiedVersion: string | null;
}
export declare const PANE_PATTERNS: Readonly<Record<CliAgentType, ProviderPanePatterns>>;
export declare function paneLineLooksLikeIdlePrompt(line: string, provider?: CliAgentType): boolean;
export type ClaudeStartupDialogKind = 'claude_onboarding' | 'claude_bypass_permissions' | 'claude_fullscreen_renderer' | 'claude_startup_dialog_unidentified';
export type ClaudeDialogKind = 'claude_directory' | 'claude_bypass_permissions' | 'claude_fullscreen_renderer';
export declare function detectClaudeStartupDialog(captured: string): ClaudeStartupDialogKind | null;
export declare function observePane(captured: string, provider?: CliAgentType): PaneSignals;
/**
 * One state for a pane, for decisions that send no keys themselves: whether the
 * idle nudge fires and what the monitor reports. Earlier states win, so a trust
 * dialog is never idle and a working pane is never idle. The checks that send
 * keys keep reading the signals the way they always have.
 */
export type PaneState = {
    kind: 'trust';
    trust: PaneTrustPromptKind;
} | {
    kind: 'busy';
} | {
    kind: 'bootstrapping';
} | {
    kind: 'idle';
} | {
    kind: 'unknown';
};
export declare function classifyPane(signals: PaneSignals): PaneState;
export declare function detectPaneTrustPromptKind(captured: string, provider?: CliAgentType): PaneTrustPromptKind | null;
export declare function claudeDialogFocus(captured: string, kind: ClaudeDialogKind): 'first' | 'second' | 'stale' | null;
export declare function paneHasTrustPrompt(captured: string, provider?: CliAgentType): boolean;
export declare function paneHasStartupBanner(captured: string, provider?: CliAgentType): boolean;
export declare function paneHasActiveTask(captured: string, provider?: CliAgentType): boolean;
export declare function paneLooksReady(captured: string, provider?: CliAgentType): boolean;
//# sourceMappingURL=pane-readiness.d.ts.map