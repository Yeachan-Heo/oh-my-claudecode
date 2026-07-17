import { execFileSync } from 'node:child_process';
import type { TeamConfig, TeamRuntimeOwnerEpoch } from './types.js';
export interface OwnerFence {
    epoch: number;
    nonce: string;
}
export interface OwnerEpochRecord extends TeamRuntimeOwnerEpoch {
    schema_version: 1;
    heartbeat?: {
        observed_at: string;
        detail?: string;
    };
    payload_hash: string;
}
export interface OwnerEpochInput {
    pid?: number;
    processStartedAt?: string;
    nonce?: string;
    heartbeat?: OwnerEpochRecord['heartbeat'];
}
export type OwnerFenceCheck = {
    ok: true;
    record: OwnerEpochRecord;
} | {
    ok: false;
    reason: 'missing' | 'malformed' | 'superseded' | 'mismatch';
};
export declare function processStartIdentityForPlatform(pid: number, platform?: NodeJS.Platform, exec?: typeof execFileSync): string | null;
export declare function isValidProcessStartIdentity(value: unknown, platform?: NodeJS.Platform): value is string;
export declare function currentProcessStartIdentity(pid?: number): string | null;
export declare function isProcessIdentityDead(record: Pick<OwnerEpochRecord, 'pid' | 'process_started_at'>): boolean;
export declare function readLatestOwnerEpoch(cwd: string, teamName: string): OwnerEpochRecord | null;
/** Publish a complete, canonical epoch through a hard link. Epoch files are never reclaimed. */
export declare function publishOwnerEpoch(cwd: string, teamName: string, epoch: number, input?: OwnerEpochInput): OwnerEpochRecord;
export declare function requireOwnerProcessIdentity(record: OwnerEpochRecord, pid?: number, processStartedAt?: string | null): OwnerEpochRecord;
export declare function acquireSuccessorOwnerEpoch(cwd: string, teamName: string, input?: OwnerEpochInput): OwnerEpochRecord;
export declare function checkOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerFenceCheck;
export declare function requireOwnerFence(cwd: string, teamName: string, fence: OwnerFence): OwnerEpochRecord;
export declare function isFreshRecoveryElection(config: TeamConfig, fence: OwnerFence, expectedRevision: number): boolean;
export declare function isSameAttemptSuccessorRebind(config: TeamConfig, prior: TeamRuntimeOwnerEpoch, successor: OwnerFence, requestId: string, recoveryId: string): boolean;
export declare function isActiveRecoveryEffect(config: TeamConfig, fence: OwnerFence, requestId: string, recoveryId: string): boolean;
export declare function isFencedServiceMaintenance(config: TeamConfig, fence: OwnerFence): boolean;
//# sourceMappingURL=team-owner-epoch.d.ts.map