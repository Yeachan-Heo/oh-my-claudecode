/**
 * OMC HUD Type Definitions
 *
 * Type definitions for the HUD state, configuration, and rendering.
 */
import type { AutopilotStateForHud } from './elements/autopilot.js';
export type { AutopilotStateForHud };
export interface BackgroundTask {
    id: string;
    description: string;
    agentType?: string;
    startedAt: string;
    completedAt?: string;
    status: 'running' | 'completed' | 'failed';
    startTime?: string;
    exitCode?: number;
}
export interface OmcHudState {
    timestamp: string;
    backgroundTasks: BackgroundTask[];
}
export interface StatuslineStdin {
    /** Transcript path for parsing conversation history */
    transcript_path: string;
    /** Current working directory */
    cwd: string;
    /** Model information */
    model: {
        id: string;
        display_name: string;
    };
    /** Context window metrics */
    context_window: {
        context_window_size: number;
        used_percentage?: number;
        current_usage?: {
            input_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
        };
    };
}
export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string;
}
export interface ActiveAgent {
    id: string;
    type: string;
    model?: string;
    description?: string;
    status: 'running' | 'completed';
    startTime: Date;
    endTime?: Date;
}
export interface SkillInvocation {
    name: string;
    args?: string;
    timestamp: Date;
}
export interface PendingPermission {
    toolName: string;
    targetSummary: string;
    timestamp: Date;
}
export interface ThinkingState {
    active: boolean;
    lastSeen?: Date;
}
export interface SessionHealth {
    durationMinutes: number;
    messageCount: number;
    health: 'healthy' | 'warning' | 'critical';
    sessionCost?: number;
    totalTokens?: number;
    cacheHitRate?: number;
    topAgents?: Array<{
        agent: string;
        cost: number;
    }>;
    costPerHour?: number;
    isEstimated?: boolean;
}
export interface TranscriptData {
    agents: ActiveAgent[];
    todos: TodoItem[];
    sessionStart?: Date;
    lastActivatedSkill?: SkillInvocation;
    pendingPermission?: PendingPermission;
    thinkingState?: ThinkingState;
}
export interface RalphStateForHud {
    active: boolean;
    iteration: number;
    maxIterations: number;
    prdMode?: boolean;
    currentStoryId?: string;
}
export interface UltraworkStateForHud {
    active: boolean;
    reinforcementCount: number;
}
export interface PrdStateForHud {
    currentStoryId: string | null;
    completed: number;
    total: number;
}
export interface RateLimits {
    /** 5-hour rolling window usage percentage (0-100) - all models combined */
    fiveHourPercent: number;
    /** Weekly usage percentage (0-100) - all models combined */
    weeklyPercent: number;
    /** When the 5-hour limit resets (null if unavailable) */
    fiveHourResetsAt?: Date | null;
    /** When the weekly limit resets (null if unavailable) */
    weeklyResetsAt?: Date | null;
    /** Sonnet-specific weekly usage percentage (0-100), if available from API */
    sonnetWeeklyPercent?: number;
    /** Sonnet weekly reset time */
    sonnetWeeklyResetsAt?: Date | null;
}
export interface HudRenderContext {
    /** Context window percentage (0-100) */
    contextPercent: number;
    /** Model display name */
    modelName: string;
    /** Ralph loop state */
    ralph: RalphStateForHud | null;
    /** Ultrawork state */
    ultrawork: UltraworkStateForHud | null;
    /** PRD state */
    prd: PrdStateForHud | null;
    /** Autopilot state */
    autopilot: AutopilotStateForHud | null;
    /** Active subagents from transcript */
    activeAgents: ActiveAgent[];
    /** Todo list from transcript */
    todos: TodoItem[];
    /** Background tasks from HUD state */
    backgroundTasks: BackgroundTask[];
    /** Working directory */
    cwd: string;
    /** Last activated skill from transcript */
    lastSkill: SkillInvocation | null;
    /** Rate limits (5h and weekly) */
    rateLimits: RateLimits | null;
    /** Pending permission state (heuristic-based) */
    pendingPermission: PendingPermission | null;
    /** Extended thinking state */
    thinkingState: ThinkingState | null;
    /** Session health metrics */
    sessionHealth: SessionHealth | null;
}
export type HudPreset = 'minimal' | 'focused' | 'full' | 'opencode' | 'dense' | 'analytics';
/**
 * Agent display format options:
 * - count: agents:2
 * - codes: agents:Oes (type-coded with model tier casing)
 * - codes-duration: agents:O(2m)es (codes with duration)
 * - detailed: agents:[architect(2m),explore,exec]
 * - descriptions: O:analyzing code | e:searching (codes + what they're doing)
 * - tasks: [analyzing code, searching...] (just descriptions - most readable)
 * - multiline: Multi-line display with full agent details on separate lines
 */
export type AgentsFormat = 'count' | 'codes' | 'codes-duration' | 'detailed' | 'descriptions' | 'tasks' | 'multiline';
/**
 * Thinking indicator format options:
 * - bubble: 💭 (thought bubble emoji)
 * - brain: 🧠 (brain emoji)
 * - face: 🤔 (thinking face emoji)
 * - text: "thinking" (full text)
 */
export type ThinkingFormat = 'bubble' | 'brain' | 'face' | 'text';
/**
 * CWD path format options:
 * - relative: ~/workspace/dotfiles (home-relative)
 * - absolute: /Users/dat/workspace/dotfiles (full path)
 * - folder: dotfiles (folder name only)
 */
export type CwdFormat = 'relative' | 'absolute' | 'folder';
export interface HudElementConfig {
    cwd: boolean;
    cwdFormat: CwdFormat;
    gitRepo: boolean;
    gitBranch: boolean;
    model: boolean;
    omcLabel: boolean;
    rateLimits: boolean;
    ralph: boolean;
    autopilot: boolean;
    prdStory: boolean;
    activeSkills: boolean;
    lastSkill: boolean;
    contextBar: boolean;
    agents: boolean;
    agentsFormat: AgentsFormat;
    agentsMaxLines: number;
    backgroundTasks: boolean;
    todos: boolean;
    permissionStatus: boolean;
    thinking: boolean;
    thinkingFormat: ThinkingFormat;
    sessionHealth: boolean;
    showSessionDuration?: boolean;
    showHealthIndicator?: boolean;
    showTokens?: boolean;
    showCostPerHour?: boolean;
    showBudgetWarning?: boolean;
    useBars: boolean;
    showCache: boolean;
    showCost: boolean;
    maxOutputLines: number;
    safeMode: boolean;
}
export interface HudThresholds {
    /** Context percentage that triggers warning color (default: 70) */
    contextWarning: number;
    /** Context percentage that triggers compact suggestion (default: 80) */
    contextCompactSuggestion: number;
    /** Context percentage that triggers critical color (default: 85) */
    contextCritical: number;
    /** Ralph iteration that triggers warning color (default: 7) */
    ralphWarning: number;
}
export interface HudConfig {
    preset: HudPreset;
    elements: HudElementConfig;
    thresholds: HudThresholds;
    staleTaskThresholdMinutes: number;
}
export declare const DEFAULT_HUD_CONFIG: HudConfig;
export declare const PRESET_CONFIGS: Record<HudPreset, Partial<HudElementConfig>>;
//# sourceMappingURL=types.d.ts.map