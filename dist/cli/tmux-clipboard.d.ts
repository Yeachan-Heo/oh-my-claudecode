import { tmuxExec, tmuxExecAsync } from './tmux-utils.js';
type SyncTmuxClipboardOptions = Parameters<typeof tmuxExec>[1];
type AsyncTmuxClipboardOptions = Parameters<typeof tmuxExecAsync>[1];
export declare function hasUniversalClipboardTerminalFeature(features: string): boolean;
export declare function configureTmuxClipboardForSession(sessionName: string, opts?: SyncTmuxClipboardOptions): void;
export declare function configureTmuxClipboardForCurrentSession(opts?: SyncTmuxClipboardOptions): void;
export declare function configureTmuxClipboardForSessionAsync(sessionName: string, opts?: AsyncTmuxClipboardOptions): Promise<void>;
export {};
//# sourceMappingURL=tmux-clipboard.d.ts.map