export type MissionBoardSource = 'session' | 'team';
export type MissionBoardStatus = 'blocked' | 'waiting' | 'running' | 'done';
export type MissionTimelineEventType = 'handoff' | 'completion' | 'failure' | 'update';
export interface MissionBoardConfig {
    enabled: boolean;
    maxMissions?: number;
    maxAgentsPerMission?: number;
    maxTimelineEvents?: number;
    persistCompletedForMinutes?: number;
}
export interface MissionBoardTimelineEvent {
    id: string;
    at: string;
    kind: MissionTimelineEventType;
    agent: string;
    detail: string;
    sourceKey: string;
}
export interface MissionBoardAgent {
    name: string;
    role?: string;
    ownership?: string;
    status: MissionBoardStatus;
    currentStep?: string | null;
    latestUpdate?: string | null;
    completedSummary?: string | null;
    updatedAt?: string;
}
export interface MissionBoardMission {
    id: string;
    source: MissionBoardSource;
    teamName?: string;
    name: string;
    objective: string;
    createdAt: string;
    updatedAt: string;
    status: MissionBoardStatus;
    workerCount: number;
    taskCounts: {
        total: number;
        pending: number;
        blocked: number;
        inProgress: number;
        completed: number;
        failed: number;
    };
    agents: MissionBoardAgent[];
    timeline: MissionBoardTimelineEvent[];
}
export interface MissionBoardState {
    updatedAt: string;
    missions: MissionBoardMission[];
}
export interface MissionAgentStartInput {
    sessionId: string;
    agentId: string;
    agentType: string;
    parentMode: string;
    taskDescription?: string;
    at?: string;
}
export interface MissionAgentStopInput {
    sessionId: string;
    agentId: string;
    success: boolean;
    outputSummary?: string;
    at?: string;
}
export declare const DEFAULT_MISSION_BOARD_CONFIG: MissionBoardConfig;
export declare function readMissionBoardState(directory: string, sessionId?: string): MissionBoardState | null;
export declare function recordMissionAgentStart(directory: string, input: MissionAgentStartInput, sessionId?: string): MissionBoardState;
export declare function recordMissionAgentStop(directory: string, input: MissionAgentStopInput, sessionId?: string): MissionBoardState;
/**
 * Build a team-only board view without reading or persisting session snapshots.
 * Used by readers that have no session ids to aggregate.
 */
export declare function discoverTeamMissionBoardState(directory: string, rawConfig?: MissionBoardConfig): MissionBoardState;
export declare function refreshMissionBoardState(directory: string, rawConfig?: MissionBoardConfig, sessionId?: string): MissionBoardState;
/**
 * List session ids that have a persisted mission board state, newest first.
 *
 * Process-scoped ids (`pid-<pid>-<timestamp>`) are excluded. Those come from
 * `getProcessSessionId()`, which mints a fresh id per process, so their
 * directories are per-process scratch files that never name a [CC] session.
 */
export declare function listMissionBoardSessionIds(directory: string): string[];
/**
 * Merge per-session mission board snapshots into a single view.
 *
 * Mission ids are already session-scoped (`session:<sessionId>:<parentMode>`), so
 * concatenating them is lossless and no cross-session dedupe is needed. Completed
 * missions older than `persistCompletedForMinutes` are dropped so snapshots from
 * long-finished sessions do not linger on the board.
 */
export declare function mergeMissionBoardStates(states: MissionBoardState[], rawConfig?: MissionBoardConfig): MissionBoardState;
export declare function renderMissionBoard(state: MissionBoardState | null, rawConfig?: MissionBoardConfig): string[];
//# sourceMappingURL=mission-board.d.ts.map