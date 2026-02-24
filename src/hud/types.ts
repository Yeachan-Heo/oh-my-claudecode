/**
 * OMC HUD Type Definitions
 *
 * Type definitions for the HUD state, configuration, and rendering.
 */

import type { AutopilotStateForHud } from './elements/autopilot.js';

// Re-export for convenience
export type { AutopilotStateForHud };

// ============================================================================
// HUD State
// ============================================================================

export interface BackgroundTask {
  id: string;
  description: string;
  agentType?: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed';
  startTime?: string; // Alias for compatibility
  exitCode?: number; // For tracking abnormal termination
}

export interface OmcHudState {
  timestamp: string;
  backgroundTasks: BackgroundTask[];
  /** Persisted session start time to survive tail-parsing resets */
  sessionStartTimestamp?: string;
  /** Session ID that owns the persisted sessionStartTimestamp */
  sessionId?: string;
  /** Timestamp of last user prompt submission (ISO 8601) */
  lastPromptTimestamp?: string;
}

// ============================================================================
// Stdin from Claude Code
// ============================================================================

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

// ============================================================================
// Transcript Parsing Results
// ============================================================================

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
  toolName: string;       // "Edit", "Bash", etc. (proxy_ prefix stripped)
  targetSummary: string;  // "src/main.ts" or "npm install"
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
}

export interface TranscriptData {
  agents: ActiveAgent[];
  todos: TodoItem[];
  sessionStart?: Date;
  lastActivatedSkill?: SkillInvocation;
  pendingPermission?: PendingPermission;
  thinkingState?: ThinkingState;
  toolCallCount: number;
  agentCallCount: number;
  skillCallCount: number;
}

// ============================================================================
// OMC State Types (read from existing files)
// ============================================================================

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


// ============================================================================
// Render Context
// ============================================================================

export interface RateLimits {
  /** 5-hour rolling window usage percentage (0-100) - all models combined */
  fiveHourPercent: number;
  /** Weekly usage percentage (0-100) - all models combined (undefined if not applicable) */
  weeklyPercent?: number;
  /** When the 5-hour limit resets (null if unavailable) */
  fiveHourResetsAt?: Date | null;
  /** When the weekly limit resets (null if unavailable) */
  weeklyResetsAt?: Date | null;

  /** Sonnet-specific weekly usage percentage (0-100), if available from API */
  sonnetWeeklyPercent?: number;
  /** Sonnet weekly reset time */
  sonnetWeeklyResetsAt?: Date | null;

  /** Opus-specific weekly usage percentage (0-100), if available from API */
  opusWeeklyPercent?: number;
  /** Opus weekly reset time */
  opusWeeklyResetsAt?: Date | null;

  /** Monthly usage percentage (0-100), if available from API */
  monthlyPercent?: number;
  /** When the monthly limit resets (null if unavailable) */
  monthlyResetsAt?: Date | null;
}

// ============================================================================
// Custom Rate Limit Provider
// ============================================================================

/**
 * Custom rate limit provider configuration.
 * Set omcHud.rateLimitsProvider.type = 'custom' to enable.
 */
export interface RateLimitsProviderConfig {
  type: 'custom';
  /** Shell command string or argv array to execute */
  command: string | string[];
  /** Execution timeout in milliseconds (default: 800) */
  timeoutMs?: number;
  /** Optional bucket IDs to display; shows all buckets when omitted */
  periods?: string[];
  /** Percent usage threshold above which resetsAt is shown (default: 85) */
  resetsAtDisplayThresholdPercent?: number;
}

/** Usage expressed as a 0-100 percent value */
export interface BucketUsagePercent {
  type: 'percent';
  value: number;
}

/** Usage expressed as consumed credits vs. limit */
export interface BucketUsageCredit {
  type: 'credit';
  used: number;
  limit: number;
}

/** Usage expressed as a pre-formatted string (resetsAt always hidden) */
export interface BucketUsageString {
  type: 'string';
  value: string;
}

export type CustomBucketUsage = BucketUsagePercent | BucketUsageCredit | BucketUsageString;

/** A single rate limit bucket returned by the custom provider command */
export interface CustomBucket {
  id: string;
  label: string;
  usage: CustomBucketUsage;
  /** ISO 8601 reset time; only shown when usage crosses resetsAtDisplayThresholdPercent */
  resetsAt?: string;
}

/** The JSON object a custom provider command must print to stdout */
export interface CustomProviderOutput {
  version: 1;
  generatedAt: string;
  buckets: CustomBucket[];
}

/**
 * Result of executing (or loading from cache) the custom rate limit provider.
 * Passed directly to the HUD render context.
 */
export interface CustomProviderResult {
  buckets: CustomBucket[];
  /** True when using the last-known-good cached value after a command failure */
  stale: boolean;
  /** Error message when command failed and no cache is available */
  error?: string;
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

  /** Rate limits (5h and weekly) from built-in Anthropic/z.ai providers */
  rateLimits: RateLimits | null;

  /** Custom rate limit buckets from rateLimitsProvider command (null when not configured) */
  customBuckets: CustomProviderResult | null;

  /** Pending permission state (heuristic-based) */
  pendingPermission: PendingPermission | null;

  /** Extended thinking state */
  thinkingState: ThinkingState | null;

  /** Session health metrics */
  sessionHealth: SessionHealth | null;

  /** Installed OMC version (e.g. "4.1.10") */
  omcVersion: string | null;

  /** Latest available version from npm registry (null if up to date or unknown) */
  updateAvailable: string | null;

  /** Total tool_use blocks seen in transcript */
  toolCallCount: number;

  /** Total Task/proxy_Task calls seen in transcript */
  agentCallCount: number;

  /** Total Skill/proxy_Skill calls seen in transcript */
  skillCallCount: number;

  /** Last prompt submission time (from HUD state) */
  promptTime: Date | null;
}

// ============================================================================
// Configuration
// ============================================================================

export type HudPreset = 'minimal' | 'focused' | 'full' | 'opencode' | 'dense';

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

/**
 * Model name format options:
 * - short: 'Opus', 'Sonnet', 'Haiku'
 * - versioned: 'Opus 4.6', 'Sonnet 4.5', 'Haiku 4.5'
 * - full: raw model ID like 'claude-opus-4-6-20260205'
 */
export type ModelFormat = 'short' | 'versioned' | 'full';

export interface HudElementConfig {
  cwd: boolean;              // Show working directory
  cwdFormat: CwdFormat;      // Path display format
  gitRepo: boolean;          // Show git repository name
  gitBranch: boolean;        // Show git branch
  model: boolean;            // Show current model name
  modelFormat: ModelFormat;   // Model name verbosity level
  omcLabel: boolean;
  rateLimits: boolean;  // Show 5h and weekly rate limits
  ralph: boolean;
  autopilot: boolean;
  prdStory: boolean;
  activeSkills: boolean;
  lastSkill: boolean;
  contextBar: boolean;
  agents: boolean;
  agentsFormat: AgentsFormat;
  agentsMaxLines: number;  // Max agent detail lines for multiline format (default: 5)
  backgroundTasks: boolean;
  todos: boolean;
  permissionStatus: boolean;  // Show pending permission indicator
  thinking: boolean;          // Show extended thinking indicator
  thinkingFormat: ThinkingFormat;  // Thinking indicator format
  promptTime: boolean;        // Show last prompt submission time (HH:MM:SS)
  sessionHealth: boolean;     // Show session health/duration
  showSessionDuration?: boolean;  // Show session:19m duration display (default: true if sessionHealth is true)
  showHealthIndicator?: boolean;  // Show 🟢/🟡/🔴 health indicator (default: true if sessionHealth is true)
  showTokens?: boolean;           // Show token count like 79.3k (default: true if sessionHealth is true)
  useBars: boolean;           // Show visual progress bars instead of/alongside percentages
  showCallCounts?: boolean;   // Show tool/agent/skill call counts on the right of the status line (default: true)
  maxOutputLines: number;     // Max total output lines to prevent input field shrinkage
  safeMode: boolean;          // Strip ANSI codes and use ASCII-only output to prevent terminal rendering corruption (Issue #346)
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
  /** Session cost ($) that triggers budget warning (default: 2.0) */
}

export interface ContextLimitWarningConfig {
  /** Context percentage threshold that triggers the warning banner (default: 80) */
  threshold: number;
  /** Automatically queue /compact when threshold is exceeded (default: false) */
  autoCompact: boolean;
}

export interface HudConfig {
  preset: HudPreset;
  elements: HudElementConfig;
  thresholds: HudThresholds;
  staleTaskThresholdMinutes: number; // Default 30
  contextLimitWarning: ContextLimitWarningConfig;
  /** Optional custom rate limit provider; omit to use built-in Anthropic/z.ai */
  rateLimitsProvider?: RateLimitsProviderConfig;
}

export const DEFAULT_HUD_CONFIG: HudConfig = {
  preset: 'focused',
  elements: {
    cwd: false,               // Disabled by default for backward compatibility
    cwdFormat: 'relative',
    gitRepo: false,           // Disabled by default for backward compatibility
    gitBranch: false,         // Disabled by default for backward compatibility
    model: false,             // Disabled by default for backward compatibility
    modelFormat: 'short',     // Short names by default for backward compatibility
    omcLabel: true,
    rateLimits: true,  // Show rate limits by default
    ralph: true,
    autopilot: true,
    prdStory: true,
    activeSkills: true,
    contextBar: true,
    agents: true,
    agentsFormat: 'multiline', // Multi-line for rich agent visualization
    agentsMaxLines: 5, // Show up to 5 agent detail lines
    backgroundTasks: true,
    todos: true,
    lastSkill: true,
    permissionStatus: false,  // Disabled: heuristic-based, causes false positives
    thinking: true,
    thinkingFormat: 'text',   // Text format for backward compatibility
    promptTime: true,  // Show last prompt time by default
    sessionHealth: true,
    useBars: false,  // Disabled by default for backwards compatibility
    showCallCounts: true,  // Show tool/agent/skill call counts by default (Issue #710)
    maxOutputLines: 4,
    safeMode: true,  // Enabled by default to prevent terminal rendering corruption (Issue #346)
  },
  thresholds: {
    contextWarning: 70,
    contextCompactSuggestion: 80,
    contextCritical: 85,
    ralphWarning: 7,
  },
  staleTaskThresholdMinutes: 30,
  contextLimitWarning: {
    threshold: 80,
    autoCompact: false,
  },
};

export const PRESET_CONFIGS: Record<HudPreset, Partial<HudElementConfig>> = {
  minimal: {
    cwd: false,
    cwdFormat: 'folder',
    gitRepo: false,
    gitBranch: false,
    model: false,
    modelFormat: 'short',
    omcLabel: true,
    rateLimits: true,
    ralph: true,
    autopilot: true,
    prdStory: false,
    activeSkills: true,
    lastSkill: true,
    contextBar: false,
    agents: true,
    agentsFormat: 'count',
    agentsMaxLines: 0,
    backgroundTasks: false,
    todos: true,
    permissionStatus: false,
    thinking: false,
    thinkingFormat: 'text',
    promptTime: false,
    sessionHealth: false,
    useBars: false,
    showCallCounts: false,
    maxOutputLines: 2,
    safeMode: true,
  },
  focused: {
    cwd: false,
    cwdFormat: 'relative',
    gitRepo: false,
    gitBranch: true,
    model: false,
    modelFormat: 'short',
    omcLabel: true,
    rateLimits: true,
    ralph: true,
    autopilot: true,
    prdStory: true,
    activeSkills: true,
    lastSkill: true,
    contextBar: true,
    agents: true,
    agentsFormat: 'multiline',
    agentsMaxLines: 3,
    backgroundTasks: true,
    todos: true,
    permissionStatus: false,
    thinking: true,
    thinkingFormat: 'text',
    promptTime: true,
    sessionHealth: true,
    useBars: true,
    showCallCounts: true,
    maxOutputLines: 4,
    safeMode: true,
  },
  full: {
    cwd: false,
    cwdFormat: 'relative',
    gitRepo: true,
    gitBranch: true,
    model: false,
    modelFormat: 'short',
    omcLabel: true,
    rateLimits: true,
    ralph: true,
    autopilot: true,
    prdStory: true,
    activeSkills: true,
    lastSkill: true,
    contextBar: true,
    agents: true,
    agentsFormat: 'multiline',
    agentsMaxLines: 10,
    backgroundTasks: true,
    todos: true,
    permissionStatus: false,
    thinking: true,
    thinkingFormat: 'text',
    promptTime: true,
    sessionHealth: true,
    useBars: true,
    showCallCounts: true,
    maxOutputLines: 12,
    safeMode: true,
  },
  opencode: {
    cwd: false,
    cwdFormat: 'relative',
    gitRepo: false,
    gitBranch: true,
    model: false,
    modelFormat: 'short',
    omcLabel: true,
    rateLimits: false,
    ralph: true,
    autopilot: true,
    prdStory: false,
    activeSkills: true,
    lastSkill: true,
    contextBar: true,
    agents: true,
    agentsFormat: 'codes',
    agentsMaxLines: 0,
    backgroundTasks: false,
    todos: true,
    permissionStatus: false,
    thinking: true,
    thinkingFormat: 'text',
    promptTime: true,
    sessionHealth: true,
    useBars: false,
    showCallCounts: true,
    maxOutputLines: 4,
    safeMode: true,
  },
  dense: {
    cwd: false,
    cwdFormat: 'relative',
    gitRepo: true,
    gitBranch: true,
    model: false,
    modelFormat: 'short',
    omcLabel: true,
    rateLimits: true,
    ralph: true,
    autopilot: true,
    prdStory: true,
    activeSkills: true,
    lastSkill: true,
    contextBar: true,
    agents: true,
    agentsFormat: 'multiline',
    agentsMaxLines: 5,
    backgroundTasks: true,
    todos: true,
    permissionStatus: false,
    thinking: true,
    thinkingFormat: 'text',
    promptTime: true,
    sessionHealth: true,
    useBars: true,
    showCallCounts: true,
    maxOutputLines: 6,
    safeMode: true,
  },
};
