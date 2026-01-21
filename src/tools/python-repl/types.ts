/**
 * Bridge metadata stored in bridge_meta.json
 */
export interface BridgeMeta {
  pid: number;
  socketPath: string;
  startedAt: string; // ISO 8601
  sessionId: string;
  pythonEnv: PythonEnvInfo;
  processStartTime?: number; // For PID reuse detection
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
  acquiredAt: string; // ISO 8601
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
  type: string; // e.g., "FINDING", "STAT"
  subtype: string | null; // e.g., "correlation"
  content: string;
  line_number: number;
  category: string; // e.g., "insights"
}

export interface StateResult {
  memory: { rss_mb: number; vms_mb: number };
  variables: string[];
  variable_count: number;
}

export interface ResetResult {
  status: string;
  memory: { rss_mb: number; vms_mb: number };
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
  executionTimeout?: number; // default 300000ms (5 min)
  queueTimeout?: number; // default 30000ms (30 sec)
  projectDir?: string;
}

// JSON-RPC types
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
