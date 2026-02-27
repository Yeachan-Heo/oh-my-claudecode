/**
 * Interop Adapter Types
 *
 * Type definitions for the OMC-OMX cross-platform worker interop layer.
 * Used by worker-adapter.ts for bidirectional translation between
 * OMC (.omc/state/team/) and OMX (.omx/state/team/) state formats.
 */
import type { InteropMode } from './mcp-bridge.js';
import type { CliAgentType } from '../team/model-contract.js';
/** Which system is the lead (controls the team) */
export type InteropLead = 'omc' | 'omx';
/** Per-worker interop mode: signals that a worker uses OMX state conventions */
export type WorkerInteropMode = 'omc' | 'omx';
/** Unified task status superset for translation */
export type UnifiedTaskStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed';
/** Metadata annotation for lossless round-trip */
export interface StatusAnnotation {
    originalSystem: 'omc' | 'omx';
    originalStatus: string;
    mappedStatus: string;
    mappedAt: string;
    lossy: boolean;
}
/** Adapter context passed through all translation functions */
export interface AdapterContext {
    lead: InteropLead;
    teamName: string;
    cwd: string;
    interopMode: InteropMode;
}
/** Per-worker config extension for interop */
export interface WorkerInteropConfig {
    workerName: string;
    /** The underlying CLI agent type (claude/codex/gemini) */
    agentType: CliAgentType;
    /** Whether this worker uses OMX or OMC state conventions */
    interopMode: WorkerInteropMode;
}
//# sourceMappingURL=adapter-types.d.ts.map