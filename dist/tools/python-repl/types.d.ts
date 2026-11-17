/**
 * Bridge metadata stored in bridge_meta.json
 */
export interface BridgeMeta {
    pid: number;
    socketPath: string;
    startedAt: string;
    sessionId: string;
    pythonEnv: PythonEnvInfo;
    processStartTime?: number;
}
export interface PythonEnvInfo {
    pythonPath: string;
    type: 'venv';
}
export interface LockInfo {
    lockId: string;
    pid: number;
    processStartTime?: number;
    hostname: string;
    acquiredAt: string;
}
export interface ExecuteResult {
    success: boolean;
    stdout: string;
    stderr: string;
    markers: MarkerInfo[];
    artifacts: unknown[];
    timing: {
        started_at: string;
        duration_ms: number;
    };
    memory: {
        rss_mb: number;
        vms_mb: number;
    };
    error?: {
        type: string;
        message: string;
        traceback: string;
    };
}
export interface MarkerInfo {
    type: string;
    subtype: string | null;
    content: string;
    line_number: number;
    category: string;
}
export interface StateResult {
    memory: {
        rss_mb: number;
        vms_mb: number;
    };
    variables: string[];
    variable_count: number;
}
export interface ResetResult {
    status: string;
    memory: {
        rss_mb: number;
        vms_mb: number;
    };
}
export interface InterruptResult {
    status: string;
    terminatedBy?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'graceful';
    terminationTimeMs?: number;
}
export interface PythonReplInput {
    action: 'execute' | 'interrupt' | 'reset' | 'get_state';
    researchSessionID: string;
    code?: string;
    executionLabel?: string;
    executionTimeout?: number;
    queueTimeout?: number;
    projectDir?: string;
}
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
//# sourceMappingURL=types.d.ts.map