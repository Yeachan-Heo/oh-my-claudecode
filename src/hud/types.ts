/**
 * OMC HUD Type Definitions
 *
 * Type definitions for the HUD state, configuration, and rendering.
 */

import type { AutopilotStateForHud } from './elements/autopilot.js';
import type { ApiKeySource } from './elements/api-key-source.js';
import type { SessionSummaryState } from './elements/session-summary.js';
import type { MissionBoardConfig, MissionBoardState } from './mission-board.js';
import { DEFAULT_MISSION_BOARD_CONFIG } from './mission-board.js';

// Re-export for convenience
export type { AutopilotStateForHud, ApiKeySource, SessionSummaryState };

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
  transcript_path?: string;

  /** Current working directory */
  cwd?: string;

  /** Model information from Claude Code statusline stdin */
  model?: {
    id?: string;
    display_name?: string;
  };

  /** Context window metrics from Claude Code statusline stdin */
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };

  /** Rate limits from Claude Code statusline stdin */
  rate_limits?: {
    five_hour?: {
      used_percentage?: number;
      resets_at?: number | string;
    };
    seven_day?: {
      used_percentage?: number;
      resets_at?: number | string;
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

export interface LastRequestTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface TranscriptData {
  agents: ActiveAgent[];
  todos: TodoItem[];
  sessionStart?: Date;
  lastActivatedSkill?: SkillInvocation;
  pendingPermission?: PendingPermission;
  thinkingState?: ThinkingState;
  lastRequestTokenUsage?: LastRequestTokenUsage;
  sessionTotalTokens?: number;
  toolCallCount: number;
  agentCallCount: number;
  skillCallCount: number;
  /** Name of the last tool_use block seen in transcript */
  lastToolName: string | null;
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

  /** Extra (metered) usage percentage (0-100), derived from spent/limit or API utilization */
  extraUsagePercent?: number;
  /** Extra usage amount spent in USD */
  extraUsageSpentUsd?: number;
  /** Extra usage limit in USD */
  extraUsageLimitUsd?: number;
  /** When the extra usage period resets (null if unavailable) */
  extraUsageResetsAt?: Date | null;
}

/**
 * Categorized error reasons for API usage fetch failures.
 * - 'network': Network error or timeout
 * - 'auth': Authentication failure (token expired, refresh failed)
 * - 'no_credentials': No OAuth credentials available (expected for API key users)
 */
export type UsageErrorReason = 'network' | 'timeout' | 'http' | 'auth' | 'no_credentials' | 'rate_limited';

/**
 * Result of fetching usage data from the API.
 * - rateLimits: The rate limit data (null if no data available)
 * - error: Set when the API call fails (undefined on success or no credentials)
 */
export interface UsageResult {
  rateLimits: RateLimits | null;
  /** Error reason when API call fails (undefined on success or no credentials) */
  error?: UsageErrorReason;
  /** True when serving cached data that may be outdated (429 or lock contention) */
  stale?: boolean;
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

  /** Stable display scope for context smoothing (e.g. session/worktree key) */
  contextDisplayScope?: string | null;

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

  /** Mission-board snapshot (opt-in) */
  missionBoard?: MissionBoardState | null;

  /** Last activated skill from transcript */
  lastSkill: SkillInvocation | null;

  /** Rate limits result from built-in Anthropic/z.ai providers (includes error state) */
  rateLimitsResult: UsageResult | null;

  /** Error reason when built-in rate limit API call fails (undefined on success or no credentials) */
  rateLimitsError?: UsageErrorReason;

  /** Custom rate limit buckets from rateLimitsProvider command (null when not configured) */
  customBuckets: CustomProviderResult | null;

  /** Pending permission state (heuristic-based) */
  pendingPermission: PendingPermission | null;

  /** Extended thinking state */
  thinkingState: ThinkingState | null;

  /** Session health metrics */
  sessionHealth: SessionHealth | null;

  /** Last-request token usage parsed from transcript message.usage */
  lastRequestTokenUsage?: LastRequestTokenUsage | null;

  /** Session token total (input + output) when transcript parsing is reliable enough to calculate it */
  sessionTotalTokens?: number | null;

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

  /** API key source: 'project', 'global', or 'env' */
  apiKeySource: ApiKeySource | null;

  /** Active profile name (derived from CLAUDE_CONFIG_DIR), null if default */
  profileName: string | null;

  /** Cached session summary state (generated by scripts/session-summary.mjs) */
  sessionSummary: SessionSummaryState | null;

  /** Name of the last tool called in this session */
  lastToolName?: string | null;
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
 * - versioned: 'Opus 4.7', 'Sonnet 4.5', 'Haiku 4.5'
 * - full: raw model ID like 'claude-opus-4-7-20260416'
 */
export type ModelFormat = 'short' | 'versioned' | 'full';

export type CallCountsFormat = 'auto' | 'emoji' | 'ascii';

export interface HudElementConfig {
  cwd: boolean;              // Show working directory
  cwdFormat: CwdFormat;      // Path display format
  useHyperlinks?: boolean;   // Wrap cwd/paths in OSC 8 terminal hyperlinks (clickable in supported terminals)
  gitRepo: boolean;          // Show git repository name
  gitBranch: boolean;        // Show git branch
  gitStatus: boolean;        // Show git working tree status (+staged !modified ?untracked ⇡ahead ⇣behind)
  gitInfoPosition: 'above' | 'below';  // Position of git info relative to main HUD line
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
  apiKeySource: boolean;       // Show API key source (project/global/env)
  hostname: boolean;           // Show machine hostname (useful for multi-host SSH workflows)
  profile: boolean;            // Show active profile name (from CLAUDE_CONFIG_DIR)
  missionBoard?: boolean;      // Show opt-in mission board above existing HUD detail lines
  promptTime: boolean;        // Show last prompt submission time (HH:MM:SS)
  sessionHealth: boolean;     // Show session health/duration
  showSessionDuration?: boolean;  // Show session:19m duration display (default: true if sessionHealth is true)
  showHealthIndicator?: boolean;  // Show 🟢/🟡/🔴 health indicator (default: true if sessionHealth is true)
  showTokens?: boolean;           // Show last-request token usage when enabled (tok:i1.2k/o340)
  useBars: boolean;           // Show visual progress bars instead of/alongside percentages
  showCallCounts?: boolean;   // Show tool/agent/skill call counts on the right of the status line (default: true)
  callCountsFormat?: CallCountsFormat; // Controls call count icon rendering: auto (platform default), emoji, or ascii
  showLastTool?: boolean;      // Show name of last tool called (tool:Read)
  sessionSummary: boolean;    // Show AI-generated session summary (<20 chars) - generated every 10 turns via claude -p
  maxOutputLines: number;     // Max total output lines to prevent input field shrinkage
  safeMode: boolean;          // Strip ANSI codes and use ASCII-only output to prevent terminal rendering corruption (Issue #346).
                              // Default true. Set to false to explicitly disable even on Windows (e.g. Windows Terminal with ANSI support).
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

// ============================================================================
// Layout Configuration
// ============================================================================

/**
 * Layout configuration for HUD element ordering.
 * Each group is an ordered array of element names.
 * Elements can be moved between groups (e.g., contextBar from main to line1).
 * Presets control on/off; layout controls order and placement.
 */
export interface LayoutConfig {
  /** Elements on the git/info line (above or below main, per gitInfoPosition) */
  line1?: string[];
  /** Elements on the main statusline */
  main?: string[];
  /** Elements rendered as separate detail lines below the main line */
  detail?: string[];
}

/**
 * Default element order matching the current hardcoded order in render.ts.
 * Used as fallback when no layout is configured.
 */
export const DEFAULT_ELEMENT_ORDER: Required<LayoutConfig> = {
  line1: ['hostname', 'cwd', 'gitRepo', 'gitBranch', 'gitStatus', 'model', 'apiKeySource', 'profile'],
  main: [
    'omcLabel', 'rateLimits', 'customBuckets', 'permission', 'thinking',
    'promptTime', 'session', 'tokens', 'ralph', 'autopilot', 'prd',
    'skills', 'lastSkill', 'contextBar', 'agents', 'background',
    'callCounts', 'lastTool', 'sessionSummary',
  ],
  detail: ['missionBoard', 'agents', 'contextWarning', 'todos'],
};

export interface HudConfig {
  preset: HudPreset;
  elements: HudElementConfig;
  thresholds: HudThresholds;
  staleTaskThresholdMinutes: number; // Default 30
  contextLimitWarning: ContextLimitWarningConfig;
  /** Mission-board collection/rendering settings. */
  missionBoard?: MissionBoardConfig;
  /** Built-in usage API polling interval / success-cache TTL in milliseconds. */
  usageApiPollIntervalMs: number;
  /** Optional custom rate limit provider; omit to use built-in Anthropic/z.ai */
  rateLimitsProvider?: RateLimitsProviderConfig;
  /** Optional main HUD element ordering convenience setting. */
  elementOrder?: string[];
  /** Optional maximum width (columns) for statusline output. */
  maxWidth?: number;
  /** Controls maxWidth behavior: truncate with ellipsis (default) or wrap at " | " HUD element boundaries. */
  wrapMode?: 'truncate' | 'wrap';
  /** Optional element ordering. Overrides default order when set. Presets still control on/off. */
  layout?: LayoutConfig;
}

export const DEFAULT_HUD_USAGE_POLL_INTERVAL_MS = 90 * 1000;

export const DEFAULT_HUD_CONFIG: HudConfig = {
  preset: 'focused',
  elements: {
    cwd: false,               // Disabled by default for backward compatibility
    cwdFormat: 'relative',
    useHyperlinks: false,
    gitRepo: false,           // Disabled by default for backward compatibility
    gitBranch: false,         // Disabled by default for backward compatibility
    gitStatus: false,         // Disabled by default for backward compatibility
    gitInfoPosition: 'above',  // Git info above main HUD line (backward compatible)
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
    apiKeySource: false, // Disabled by default
    hostname: false,
    profile: true,  // Show profile name when CLAUDE_CONFIG_DIR is set
    missionBoard: false,  // Opt-in mission board for whole-run progress tracking
    promptTime: true,  // Show last prompt time by default
    sessionHealth: true,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: false,  // Disabled by default for backwards compatibility
    showCallCounts: true,  // Show tool/agent/skill call counts by default (Issue #710)
    callCountsFormat: 'auto',  // Preserve platform-based emoji/ASCII defaults unless explicitly overridden
    showLastTool: false,
    sessionSummary: false, // Disabled by default - opt-in AI-generated session summary
    maxOutputLines: 4,
    safeMode: true,  // Enabled by default to prevent terminal rendering corruption (Issue #346)
  },
  thresholds: {
    contextWarning: 70,
    contextCompactSuggestion: 80,
    contextCritical: 85,
    ralphWarning: 7,
  },
  staleTaskThresholdMinutes: 10,
  contextLimitWarning: {
    threshold: 80,
    autoCompact: false,
  },
  missionBoard: DEFAULT_MISSION_BOARD_CONFIG,
  usageApiPollIntervalMs: DEFAULT_HUD_USAGE_POLL_INTERVAL_MS,
  wrapMode: 'truncate',
};

export const PRESET_CONFIGS: Record<HudPreset, Partial<HudElementConfig>> = {
  minimal: {
    cwd: false,
    cwdFormat: 'folder',
    useHyperlinks: false,
    gitRepo: false,
    gitBranch: false,
    gitStatus: false,
    gitInfoPosition: 'above',
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
    apiKeySource: false,
    hostname: false,
    profile: true,
    missionBoard: false,
    promptTime: false,
    sessionHealth: false,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: false,
    showCallCounts: false,
    showLastTool: false,
    sessionSummary: false,
    maxOutputLines: 2,
    safeMode: true,
  },
  focused: {
    cwd: false,
    cwdFormat: 'relative',
    useHyperlinks: false,
    gitRepo: false,
    gitBranch: true,
    gitStatus: true,
    gitInfoPosition: 'above',
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
    apiKeySource: false,
    hostname: false,
    profile: true,
    missionBoard: false,
    promptTime: true,
    sessionHealth: true,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: true,
    showCallCounts: true,
    showLastTool: false,
    sessionSummary: false, // Opt-in: sends transcript to claude -p
    maxOutputLines: 4,
    safeMode: true,
  },
  full: {
    cwd: false,
    cwdFormat: 'relative',
    useHyperlinks: false,
    gitRepo: true,
    gitBranch: true,
    gitStatus: true,
    gitInfoPosition: 'above',
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
    apiKeySource: true,
    hostname: false,
    profile: true,
    missionBoard: false,
    promptTime: true,
    sessionHealth: true,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: true,
    showCallCounts: true,
    showLastTool: false,
    sessionSummary: false, // Opt-in: sends transcript to claude -p
    maxOutputLines: 12,
    safeMode: true,
  },
  opencode: {
    cwd: false,
    cwdFormat: 'relative',
    useHyperlinks: false,
    gitRepo: false,
    gitBranch: true,
    gitStatus: false,
    gitInfoPosition: 'above',
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
    apiKeySource: false,
    hostname: false,
    profile: true,
    missionBoard: false,
    promptTime: true,
    sessionHealth: true,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: false,
    showCallCounts: true,
    showLastTool: false,
    sessionSummary: false,
    maxOutputLines: 4,
    safeMode: true,
  },
  dense: {
    cwd: false,
    cwdFormat: 'relative',
    useHyperlinks: false,
    gitRepo: true,
    gitBranch: true,
    gitStatus: true,
    gitInfoPosition: 'above',
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
    apiKeySource: true,
    hostname: false,
    profile: true,
    missionBoard: false,
    promptTime: true,
    sessionHealth: true,
    showSessionDuration: true,
    showHealthIndicator: true,
    showTokens: false,
    useBars: true,
    showCallCounts: true,
    showLastTool: false,
    sessionSummary: false, // Opt-in: sends transcript to claude -p
    maxOutputLines: 6,
    safeMode: true,
  },
};
