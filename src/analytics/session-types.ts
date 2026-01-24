export type SessionTag = 'feature' | 'bugfix' | 'refactor' | 'exploration' | 'testing' | 'documentation' | 'other';

export interface SessionMetadata {
  id: string;
  projectPath: string;
  goals: string[];
  tags: SessionTag[];
  startTime: string;
  endTime?: string;
  duration?: number; // milliseconds
  status: 'active' | 'completed' | 'abandoned';
  outcomes: string[];
  notes: string;
}

export interface SessionAnalytics {
  sessionId: string;
  totalTokens: number;
  totalCost: number;
  agentUsage: Record<string, number>; // agent -> token count
  modelUsage: Record<string, number>; // model -> token count
  filesModified: string[];
  tasksCompleted: number;
  errorCount: number;
  successRate: number; // 0-1
}

export interface SessionHistory {
  sessions: SessionMetadata[];
  totalSessions: number;
  totalCost: number;
  averageDuration: number;
  successRate: number;
  lastUpdated: string;
}

export interface SessionSummary {
  metadata: SessionMetadata;
  analytics: SessionAnalytics;
}
