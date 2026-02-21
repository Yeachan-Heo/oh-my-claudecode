/**
 * Builtin Skills Types
 *
 * Type definitions for the builtin skills system.
 *
 * Adapted from oh-my-opencode's builtin-skills feature.
 */

/**
 * Configuration for MCP server integration with a skill
 */
export interface SkillMcpConfig {
  [serverName: string]: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

/**
 * A builtin skill definition
 */
export interface BuiltinSkill {
  /** Unique skill name */
  name: string;
  /** Aliases available for canonical skill entries */
  aliases?: string[];
  /** Canonical skill name when this entry is an alias */
  aliasOf?: string;
  /** Whether this entry is a deprecated compatibility alias */
  deprecatedAlias?: boolean;
  /** Human-readable deprecation guidance */
  deprecationMessage?: string;
  /** Short description of the skill */
  description: string;
  /** Full template content for the skill */
  template: string;
  /** License information (optional) */
  license?: string;
  /** Compatibility notes (optional) */
  compatibility?: string;
  /** Additional metadata (optional) */
  metadata?: Record<string, unknown>;
  /** Allowed tools for this skill (optional) */
  allowedTools?: string[];
  /** Agent to use with this skill (optional) */
  agent?: string;
  /** Model to use with this skill (optional) */
  model?: string;
  /** Whether this is a subtask skill (optional) */
  subtask?: boolean;
  /** Hint for arguments (optional) */
  argumentHint?: string;
  /** MCP server configuration (optional) */
  mcpConfig?: SkillMcpConfig;
}

/**
 * Skill registry for runtime access
 */
export interface SkillRegistry {
  /** Get all registered skills */
  getAll(): BuiltinSkill[];
  /** Get a skill by name */
  get(name: string): BuiltinSkill | undefined;
  /** Register a new skill */
  register(skill: BuiltinSkill): void;
  /** Check if a skill exists */
  has(name: string): boolean;
}
