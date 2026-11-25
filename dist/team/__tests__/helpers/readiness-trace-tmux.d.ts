export declare const PANE_ID = "%2";
export type KeyRecord = {
    fn: string;
    pane: string;
    guarded: boolean;
    keys: string[];
    at_ms: number;
};
export type TracePane = {
    capture: () => string;
    send: (keys: string[]) => void;
    partial?: () => {
        keys: number;
        captures: number;
    };
};
export type TraceScreen = {
    frame: string;
    partial?: boolean;
    next?: string;
    Down?: string;
    Enter?: string;
};
export declare function scriptedPane(screens: Record<string, TraceScreen>, start: string): TracePane;
export declare const trace: {
    frame: string;
    pane: TracePane | null;
    startedAt: number;
    keys: KeyRecord[];
    unknown: string[];
};
export declare function fakeTmux(fn: string, rawArgs: string[]): string;
export declare function fakeShell(fn: string, command: string): string;
export declare function tmuxUtilsOverrides(): {
    tmuxExec: (args: string[]) => string;
    tmuxShell: (command: string) => string;
    tmuxExecAsync: (args: string[]) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    tmuxCmdAsync: (args: string[]) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    tmuxShellAsync: (command: string) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    tmuxSpawn: (args: string[]) => {
        pid: number;
        output: (string | null)[];
        stdout: string;
        stderr: string;
        status: number;
        signal: null;
    };
};
//# sourceMappingURL=readiness-trace-tmux.d.ts.map