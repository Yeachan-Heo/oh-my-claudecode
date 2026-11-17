export interface SessionFrictionReportOptions {
    workingDirectory?: string;
    sessionId?: string;
    since?: string;
    project?: string;
    limit?: number;
}
export interface SessionFrictionSignal {
    severity: 'info' | 'warn' | 'critical';
    code: string;
    message: string;
    evidence: Record<string, number | string | boolean | null>;
}
export interface SessionFrictionSession {
    sessionId: string;
    projectPath?: string;
    sources: string[];
    firstTimestamp?: string;
    lastTimestamp?: string;
    transcriptBytes: number;
    transcriptLines: number;
    userTurns: number;
    assistantTurns: number;
    toolCalls: number;
    toolResults: number;
    errorResults: number;
    maxLineBytes: number;
    largestMessageBytes: number;
    estimatedContextPercent: number | null;
    contextWindowTokens: number | null;
    inputTokens: number | null;
    maxIdleGapMinutes: number | null;
    replayEvents: number;
    replayAgentsSpawned: number;
    replayAgentsFailed: number;
    replayToolCalls: number;
    replayHooksFired: number;
    frictionScore: number;
    signals: SessionFrictionSignal[];
}
export interface SessionFrictionReport {
    generatedAt: string;
    scope: {
        mode: 'current' | 'project' | 'all';
        project?: string;
        workingDirectory: string;
        since?: string;
    };
    privacy: {
        localOnly: true;
        rawContentIncluded: false;
        summary: string;
    };
    totals: {
        sessions: number;
        transcriptBytes: number;
        transcriptLines: number;
        toolCalls: number;
        errorResults: number;
        criticalSignals: number;
        warningSignals: number;
    };
    sessions: SessionFrictionSession[];
}
//# sourceMappingURL=types.d.ts.map