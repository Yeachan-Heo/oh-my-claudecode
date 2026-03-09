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
export declare function readMissionBoardState(directory: string): MissionBoardState | null;
export declare function recordMissionAgentStart(directory: string, input: MissionAgentStartInput): MissionBoardState;
export declare function recordMissionAgentStop(directory: string, input: MissionAgentStopInput): MissionBoardState;
export declare function refreshMissionBoardState(directory: string, rawConfig?: MissionBoardConfig): MissionBoardState;
export declare function renderMissionBoard(state: MissionBoardState | null, rawConfig?: MissionBoardConfig): string[];
//# sourceMappingURL=mission-board.d.ts.map