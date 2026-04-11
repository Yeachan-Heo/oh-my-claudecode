/**
 * Setup options — typed SetupOptions, flag parser, env var reader,
 * preset loader, and resolveOptions(precedence: flags > env > preset > defaults).
 *
 * All pure functions except `loadPreset`, which reads a JSON file from disk.
 *
 * Plan reference: /Users/peter/.claude-personal/plans/replicated-mixing-wren.md
 *   — "Core types (src/setup/options.ts)"
 *   — "CLI: omc setup"
 *   — Illegal combinations X1–X12 in scenario matrix.
 */

import { existsSync, readFileSync } from 'fs';
import { Command } from 'commander';
import { z } from 'zod';
import type { InstallOptions } from '../installer/index.js';
import type { HudElementConfig } from '../hud/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetupPhase =
  | 'claude-md'
  | 'infra'
  | 'integrations'
  | 'welcome'
  | 'mcp-only'
  | 'state';

export interface McpCustomSpec {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: 'stdio' | 'http';
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export type McpServerEntry =
  | 'context7'
  | 'exa'
  | 'filesystem'
  | 'github'
  | { name: string; spec: McpCustomSpec };

export type StateAction =
  | { op: 'save'; step: number; configType: string }
  | { op: 'clear' }
  | { op: 'resume' }
  | { op: 'complete'; version: string };

export interface SetupOptions {
  // Phase selection — THE critical knob. Bare `omc setup` defaults to ['infra'] only.
  phases: Set<SetupPhase>;

  // Mode control
  interactive: boolean;
  force: boolean;
  quiet: boolean;
  presetFile?: string;

  // Phase 1: CLAUDE.md
  target: 'local' | 'global';
  installStyle: 'overwrite' | 'preserve';

  // Phase 2: configure
  installCli: boolean;
  executionMode?: 'ultrawork' | 'ralph' | 'autopilot';
  taskTool?: 'builtin' | 'bd' | 'br';
  skipHud: boolean;

  // Phase 3: integrations
  mcp: {
    enabled: boolean;
    servers: McpServerEntry[];
    credentials: { exa?: string; github?: string; filesystem?: string[] };
    /**
     * Policy when a credentialed MCP server (exa, github, custom with `-e`)
     * has no credentials available:
     *   - 'skip'                : leave the server out of config entirely.
     *   - 'error'               : throw McpCredentialMissingError.
     *   - 'install-without-auth': install the server WITHOUT the `-e` flag
     *       so it's visible-but-broken via `claude mcp list` and can be
     *       fixed later by adding credentials. Servers with no credentials
     *       required (context7, filesystem) behave identically to normal.
     */
    onMissingCredentials: 'skip' | 'error' | 'install-without-auth';
    scope: 'local' | 'user' | 'project';
  };
  teams: {
    enabled: boolean;
    displayMode: 'auto' | 'in-process' | 'tmux';
    agentCount: 2 | 3 | 5;
    agentType: 'executor' | 'debugger' | 'designer';
  };

  // Phase 4
  starRepo: boolean;

  /**
   * Optional HUD element config patch. When present, phase4 shallow-merges
   * `hud.elements` into `<configDir>/.omc-config.json` under the
   * `hud.elements` key. Only the keys supplied are written — unknown keys
   * in the file are preserved. Omit entirely to skip HUD configuration.
   */
  hud?: {
    elements: Partial<HudElementConfig>;
  };

  // State machine (used when phases includes 'state')
  stateAction?: StateAction;

  // Read-only state inspection
  checkState?: boolean;

  // Installer pass-through
  installerOptions: InstallOptions;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOptionsError';
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Built-in defaults (lowest precedence). Bare `omc setup` → phases={'infra'}
 * matches today's behavior byte-for-byte.
 */
export const DEFAULTS: SetupOptions = Object.freeze({
  phases: new Set<SetupPhase>(['infra']),
  interactive: false,
  force: false,
  quiet: false,
  target: 'local',
  installStyle: 'overwrite',
  installCli: false,
  skipHud: false,
  mcp: {
    enabled: false,
    servers: [],
    credentials: {},
    onMissingCredentials: 'skip',
    scope: 'user',
  },
  teams: {
    enabled: false,
    displayMode: 'auto',
    agentCount: 3,
    agentType: 'executor',
  },
  starRepo: false,
  installerOptions: {},
}) as SetupOptions;

// ---------------------------------------------------------------------------
// QUESTION_METADATA — single source of truth for the 11 user-facing prompts.
// Question text extracted VERBATIM from skills/omc-setup/phases/0{1..4}-*.md
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionSpec {
  question: string;
  options: QuestionOption[];
  default: unknown;
}

export const QUESTION_METADATA: Record<string, QuestionSpec> = {
  target: {
    question: 'Where should I configure oh-my-claudecode?',
    options: [
      {
        label: 'Local (this project)',
        description:
          'Creates `.claude/CLAUDE.md` in current project directory. Best for project-specific configurations.',
      },
      {
        label: 'Global (all projects)',
        description:
          'Creates CLAUDE.md in your active Claude Code config directory (honours CLAUDE_CONFIG_DIR). Best for consistent behavior everywhere.',
      },
    ],
    default: 'local',
  },
  installStyle: {
    question:
      'Global setup will change your base Claude config. Which behavior do you want?',
    options: [
      {
        label: 'Overwrite base CLAUDE.md (Recommended)',
        description: 'plain `claude` and `omc` both use OMC globally.',
      },
      {
        label: 'Keep base CLAUDE.md; use OMC only through `omc`',
        description:
          "preserve the user's base file, install OMC into `CLAUDE-omc.md`, and let `omc` force-load that companion config at launch.",
      },
    ],
    default: 'overwrite',
  },
  executionMode: {
    question:
      "Which parallel execution mode should be your default when you say 'fast' or 'parallel'?",
    options: [
      {
        label: 'ultrawork (maximum capability) (Recommended)',
        description:
          'Uses all agent tiers including Opus for complex tasks. Best for challenging work where quality matters most.',
      },
      {
        label: 'No default',
        description:
          "Don't set a default execution mode. You'll specify explicitly each time.",
      },
    ],
    default: 'ultrawork',
  },
  installCli: {
    question:
      'Would you like to install the OMC CLI globally for standalone helper commands? (`omc`, `omc hud`, `omc teleport`)',
    options: [
      {
        label: 'Yes (Recommended)',
        description: 'Install `oh-my-claude-sisyphus` via `npm install -g`',
      },
      {
        label: 'No - Skip',
        description:
          'Skip installation (can install manually later with `npm install -g oh-my-claude-sisyphus`)',
      },
    ],
    default: false,
  },
  taskTool: {
    question: 'Which task management tool should I use for tracking work?',
    options: [
      {
        label: 'Built-in Tasks (default)',
        description:
          "Use Claude Code's native TaskCreate/TodoWrite. Tasks are session-only.",
      },
      {
        label: 'Beads (bd)',
        description:
          'Git-backed persistent tasks. Survives across sessions. [Only if detected]',
      },
      {
        label: 'Beads-Rust (br)',
        description: 'Lightweight Rust port of beads. [Only if detected]',
      },
    ],
    default: 'builtin',
  },
  mcpEnabled: {
    question:
      'Would you like to configure MCP servers for enhanced capabilities? (Context7, Exa search, GitHub, etc.)',
    options: [
      {
        label: 'Yes, configure MCP servers',
        description:
          'Invoke the mcp-setup skill to add Context7, Exa, GitHub, or custom servers.',
      },
      { label: 'No, skip', description: 'Leave MCP unconfigured (can add later).' },
    ],
    default: false,
  },
  teamsEnabled: {
    question:
      "Would you like to enable agent teams? Teams let you spawn coordinated agents (e.g., `/team 3:executor 'fix all errors'`). This is an experimental Claude Code feature.",
    options: [
      {
        label: 'Yes, enable teams (Recommended)',
        description: 'Enable the experimental feature and configure defaults',
      },
      {
        label: 'No, skip',
        description: 'Leave teams disabled (can enable later)',
      },
    ],
    default: false,
  },
  teamsDisplayMode: {
    question: 'How should teammates be displayed?',
    options: [
      {
        label: 'Auto (Recommended)',
        description:
          'Uses split panes if in tmux, otherwise in-process. Best for most users.',
      },
      {
        label: 'In-process',
        description:
          'All teammates in your main terminal. Use Shift+Up/Down to select. Works everywhere.',
      },
      {
        label: 'Split panes (tmux)',
        description:
          'Each teammate in its own pane. Requires tmux or iTerm2.',
      },
    ],
    default: 'auto',
  },
  teamsAgentCount: {
    question: 'How many agents should teams spawn by default?',
    options: [
      {
        label: '3 agents (Recommended)',
        description: 'Good balance of speed and resource usage',
      },
      {
        label: '5 agents (maximum)',
        description: 'Maximum parallelism for large tasks',
      },
      {
        label: '2 agents',
        description: 'Conservative, for smaller projects',
      },
    ],
    default: 3,
  },
  teamsAgentType: {
    question: 'Which agent type should teammates use by default?',
    options: [
      {
        label: 'executor (Recommended)',
        description: 'General-purpose code implementation agent',
      },
      {
        label: 'debugger',
        description: 'Specialized for build/type error fixing and debugging',
      },
      {
        label: 'designer',
        description: 'Specialized for UI/frontend work',
      },
    ],
    default: 'executor',
  },
  starRepo: {
    question:
      "If you're enjoying oh-my-claudecode, would you like to support the project by starring it on GitHub?",
    options: [
      { label: 'Yes, star it!', description: 'Star the repository' },
      { label: 'No thanks', description: 'Skip without further prompts' },
      { label: 'Maybe later', description: 'Skip without further prompts' },
    ],
    default: false,
  },
};

// ---------------------------------------------------------------------------
// zod schemas
// ---------------------------------------------------------------------------

const mcpCustomSpecSchema: z.ZodType<McpCustomSpec> = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(['stdio', 'http']).optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
});

const mcpServerEntrySchema: z.ZodType<McpServerEntry> = z.union([
  z.literal('context7'),
  z.literal('exa'),
  z.literal('filesystem'),
  z.literal('github'),
  z.object({ name: z.string(), spec: mcpCustomSpecSchema }),
]);

const presetSchema = z
  .object({
    phases: z.array(z.enum(['claude-md', 'infra', 'integrations', 'welcome', 'mcp-only', 'state'])).optional(),
    force: z.boolean().optional(),
    quiet: z.boolean().optional(),
    target: z.enum(['local', 'global']).optional(),
    installStyle: z.enum(['overwrite', 'preserve']).optional(),
    installCli: z.boolean().optional(),
    executionMode: z.enum(['ultrawork', 'ralph', 'autopilot']).optional(),
    taskTool: z.enum(['builtin', 'bd', 'br']).optional(),
    skipHud: z.boolean().optional(),
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        servers: z.array(mcpServerEntrySchema).optional(),
        credentials: z
          .object({
            exa: z.string().optional(),
            github: z.string().optional(),
            filesystem: z.array(z.string()).optional(),
          })
          .optional(),
        onMissingCredentials: z
          .enum(['skip', 'error', 'install-without-auth'])
          .optional(),
        scope: z.enum(['local', 'user', 'project']).optional(),
      })
      .optional(),
    teams: z
      .object({
        enabled: z.boolean().optional(),
        displayMode: z.enum(['auto', 'in-process', 'tmux']).optional(),
        agentCount: z.union([z.literal(2), z.literal(3), z.literal(5)]).optional(),
        agentType: z.enum(['executor', 'debugger', 'designer']).optional(),
      })
      .optional(),
    starRepo: z.boolean().optional(),
  })
  .passthrough(); // extra unknown fields are preserved, not rejected

export type PresetFile = z.infer<typeof presetSchema>;

// ---------------------------------------------------------------------------
// Env var reader
// ---------------------------------------------------------------------------

/**
 * Reads known env vars into a Partial<SetupOptions>.
 *
 * Supported env vars:
 *   EXA_API_KEY                       → mcp.credentials.exa
 *   GITHUB_TOKEN                      → mcp.credentials.github
 *   OMC_SETUP_EXECUTION_MODE          → executionMode
 *   OMC_SETUP_TASK_TOOL               → taskTool
 *   OMC_SETUP_INSTALL_CLI             → installCli (boolean-like)
 *   OMC_SETUP_MCP_ENABLED             → mcp.enabled
 *   OMC_SETUP_TEAMS_ENABLED           → teams.enabled
 *   OMC_SETUP_TEAMS_DISPLAY_MODE      → teams.displayMode
 *   OMC_SETUP_TEAMS_AGENT_COUNT       → teams.agentCount
 *   OMC_SETUP_TEAMS_AGENT_TYPE        → teams.agentType
 *   OMC_SETUP_TARGET                  → target
 *   OMC_SETUP_INSTALL_STYLE           → installStyle
 *   OMC_SETUP_STAR_REPO               → starRepo
 *   OMC_SETUP_MCP_ON_MISSING_CREDS    → mcp.onMissingCredentials
 *   OMC_SETUP_MCP_SCOPE               → mcp.scope
 */
export function readEnvPartial(env: NodeJS.ProcessEnv = process.env): Partial<SetupOptions> {
  const out: Partial<SetupOptions> = {};
  const mcp: Partial<SetupOptions['mcp']> = {};
  const teams: Partial<SetupOptions['teams']> = {};

  const boolish = (v: string | undefined): boolean | undefined => {
    if (v === undefined) return undefined;
    const lower = v.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(lower)) return false;
    return undefined;
  };

  if (env.EXA_API_KEY) {
    mcp.credentials = { ...(mcp.credentials ?? {}), exa: env.EXA_API_KEY };
  }
  if (env.GITHUB_TOKEN) {
    mcp.credentials = { ...(mcp.credentials ?? {}), github: env.GITHUB_TOKEN };
  }

  const em = env.OMC_SETUP_EXECUTION_MODE;
  if (em === 'ultrawork' || em === 'ralph' || em === 'autopilot') {
    out.executionMode = em;
  }
  const tt = env.OMC_SETUP_TASK_TOOL;
  if (tt === 'builtin' || tt === 'bd' || tt === 'br') {
    out.taskTool = tt;
  }
  const installCli = boolish(env.OMC_SETUP_INSTALL_CLI);
  if (installCli !== undefined) out.installCli = installCli;

  const mcpEnabled = boolish(env.OMC_SETUP_MCP_ENABLED);
  if (mcpEnabled !== undefined) mcp.enabled = mcpEnabled;

  const teamsEnabled = boolish(env.OMC_SETUP_TEAMS_ENABLED);
  if (teamsEnabled !== undefined) teams.enabled = teamsEnabled;

  const dm = env.OMC_SETUP_TEAMS_DISPLAY_MODE;
  if (dm === 'auto' || dm === 'in-process' || dm === 'tmux') {
    teams.displayMode = dm;
  }

  const ac = env.OMC_SETUP_TEAMS_AGENT_COUNT;
  if (ac === '2' || ac === '3' || ac === '5') {
    teams.agentCount = Number(ac) as 2 | 3 | 5;
  }

  const at = env.OMC_SETUP_TEAMS_AGENT_TYPE;
  if (at === 'executor' || at === 'debugger' || at === 'designer') {
    teams.agentType = at;
  }

  const tg = env.OMC_SETUP_TARGET;
  if (tg === 'local' || tg === 'global') out.target = tg;

  const is = env.OMC_SETUP_INSTALL_STYLE;
  if (is === 'overwrite' || is === 'preserve') out.installStyle = is;

  const sr = boolish(env.OMC_SETUP_STAR_REPO);
  if (sr !== undefined) out.starRepo = sr;

  const omc = env.OMC_SETUP_MCP_ON_MISSING_CREDS;
  if (omc === 'skip' || omc === 'error' || omc === 'install-without-auth') {
    mcp.onMissingCredentials = omc;
  }

  const ms = env.OMC_SETUP_MCP_SCOPE;
  if (ms === 'local' || ms === 'user' || ms === 'project') mcp.scope = ms;

  if (Object.keys(mcp).length > 0) out.mcp = mcp as SetupOptions['mcp'];
  if (Object.keys(teams).length > 0) out.teams = teams as SetupOptions['teams'];

  return out;
}

// ---------------------------------------------------------------------------
// loadPreset
// ---------------------------------------------------------------------------

/**
 * Loads and validates a JSON preset file.
 * Throws InvalidOptionsError on missing file (X8) or invalid JSON / schema (X9).
 * Unknown keys are preserved (passthrough).
 */
export function loadPreset(path: string): Partial<SetupOptions> {
  if (!existsSync(path)) {
    throw new InvalidOptionsError(`preset file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidOptionsError(`preset file not readable: ${path} (${msg})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidOptionsError(`invalid preset: ${msg}`);
  }

  const result = presetSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidOptionsError(`invalid preset: ${result.error.message}`);
  }

  return presetToPartial(result.data);
}

function presetToPartial(preset: PresetFile): Partial<SetupOptions> {
  const out: Partial<SetupOptions> = {};
  if (preset.phases) out.phases = new Set(preset.phases);
  if (preset.force !== undefined) out.force = preset.force;
  if (preset.quiet !== undefined) out.quiet = preset.quiet;
  if (preset.target) out.target = preset.target;
  if (preset.installStyle) out.installStyle = preset.installStyle;
  if (preset.installCli !== undefined) out.installCli = preset.installCli;
  if (preset.executionMode) out.executionMode = preset.executionMode;
  if (preset.taskTool) out.taskTool = preset.taskTool;
  if (preset.skipHud !== undefined) out.skipHud = preset.skipHud;
  if (preset.mcp) {
    out.mcp = {
      ...DEFAULTS.mcp,
      ...preset.mcp,
      credentials: { ...DEFAULTS.mcp.credentials, ...(preset.mcp.credentials ?? {}) },
      servers: preset.mcp.servers ?? DEFAULTS.mcp.servers,
    };
  }
  if (preset.teams) {
    out.teams = { ...DEFAULTS.teams, ...preset.teams };
  }
  if (preset.starRepo !== undefined) out.starRepo = preset.starRepo;
  return out;
}

// ---------------------------------------------------------------------------
// Flag parser
// ---------------------------------------------------------------------------

interface RawFlags {
  force?: boolean;
  quiet?: boolean;
  noPlugin?: boolean;
  pluginDirMode?: boolean;
  skipHooks?: boolean;
  forceHooks?: boolean;
  preset?: string;
  wizard?: boolean;
  interactive?: boolean;
  nonInteractive?: boolean;
  local?: boolean;
  global?: boolean;
  preserve?: boolean;
  overwrite?: boolean;
  executionMode?: string;
  taskTool?: string;
  installCli?: boolean;
  configureMcp?: boolean;
  noMcp?: boolean;
  mcpServers?: string;
  exaKey?: string;
  exaKeyFile?: string;
  githubToken?: string;
  githubTokenFile?: string;
  mcpOnMissingCreds?: string;
  mcpScope?: string;
  enableTeams?: boolean;
  noTeams?: boolean;
  teamAgents?: string;
  teamType?: string;
  teammateDisplay?: string;
  starRepo?: boolean;
  noStarRepo?: boolean;
  claudeMdOnly?: boolean;
  mcpOnly?: boolean;
  stateSave?: string;
  stateClear?: boolean;
  stateResume?: boolean;
  stateComplete?: string;
  stateConfigType?: string;
  checkState?: boolean;
  buildPreset?: boolean;
  answers?: string;
  out?: string;
  /** Escape hatch: restore pre-safe-defaults bare `omc setup` behavior. */
  infraOnly?: boolean;
  /** Print SAFE_DEFAULTS as JSON and exit (handled in cli). */
  dumpSafeDefaults?: boolean;
}

/**
 * Parse CLI flags into a Partial<SetupOptions>. Does NOT apply defaults,
 * env vars, or preset merging — that's `resolveOptions`'s job.
 *
 * Uses `commander` in standalone (non-process-exiting) mode so it's safe
 * to call from test code and from subcommand dispatchers.
 */
export function parseFlagsToPartial(argv: string[]): Partial<SetupOptions> {
  const program = new Command();
  program
    .name('omc setup')
    .exitOverride() // throw instead of process.exit on parse errors
    .allowExcessArguments(true)
    .allowUnknownOption(false)
    // Existing backward-compat flags
    .option('-f, --force')
    .option('-q, --quiet')
    .option('--no-plugin')
    .option('--plugin-dir-mode')
    .option('--skip-hooks')
    .option('--force-hooks')
    // New flags
    .option('--preset <file>')
    .option('--wizard')
    .option('--interactive')
    .option('--non-interactive')
    .option('--local')
    .option('--global')
    .option('--preserve')
    .option('--overwrite')
    .option('--execution-mode <mode>')
    .option('--task-tool <tool>')
    .option('--install-cli')
    .option('--no-install-cli')
    .option('--configure-mcp')
    .option('--no-mcp')
    .option('--mcp-servers <list>')
    .option('--exa-key <key>')
    .option('--exa-key-file <path>')
    .option('--github-token <token>')
    .option('--github-token-file <path>')
    .option('--mcp-on-missing-creds <mode>')
    .option('--mcp-scope <scope>')
    .option('--enable-teams')
    .option('--no-teams')
    .option('--team-agents <n>')
    .option('--team-type <type>')
    .option('--teammate-display <mode>')
    .option('--star-repo')
    .option('--no-star-repo')
    .option('--claude-md-only')
    .option('--mcp-only')
    .option('--state-save <step>')
    .option('--state-clear')
    .option('--state-resume')
    .option('--state-complete <version>')
    .option('--state-config-type <type>')
    .option('--check-state')
    .option('--build-preset')
    .option('--answers <file>')
    .option('--out <file>')
    .option('--infra-only')
    .option('--dump-safe-defaults');

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidOptionsError(`flag parse error: ${msg}`);
  }

  const opts = program.opts<RawFlags>();
  return flagsToPartial(opts);
}

function parseMcpServersList(list: string): McpServerEntry[] {
  const allowed = new Set(['context7', 'exa', 'filesystem', 'github']);
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name) => {
      if (!allowed.has(name)) {
        throw new InvalidOptionsError(`unknown MCP server: ${name}`);
      }
      return name as McpServerEntry;
    });
}

function readKeyFile(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new InvalidOptionsError(`${label} not found: ${path}`);
  }
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidOptionsError(`${label} not readable: ${path} (${msg})`);
  }
}

/**
 * Convert commander-parsed setup options into a Partial<SetupOptions>.
 *
 * Used by the CLI action handler (which has already let commander parse
 * the outer argv) to skip the double-parse that `parseFlagsToPartial()`
 * would otherwise do. Callers pass `cmd.opts()` directly. Commander
 * normalizes negated flags like `--no-plugin` into `{ plugin: false }`,
 * so the caller's opts object is morphologically identical to `RawFlags`
 * (with the extra `plugin`/`mcp`/`teams`/`installCli`/`starRepo` boolean
 * keys that commander synthesizes for the `--no-*` pairs).
 */
export function mapSetupCommanderOpts(opts: unknown): Partial<SetupOptions> {
  return flagsToPartial(opts as RawFlags);
}

function flagsToPartial(flags: RawFlags): Partial<SetupOptions> {
  const out: Partial<SetupOptions> = {};
  const installerOptions: InstallOptions = {};
  const mcp: Partial<SetupOptions['mcp']> = {};
  const teams: Partial<SetupOptions['teams']> = {};

  // Backward-compat installer pass-through
  if (flags.force) {
    out.force = true;
    installerOptions.force = true;
  }
  if (flags.quiet !== undefined) {
    out.quiet = flags.quiet;
    installerOptions.verbose = !flags.quiet;
  }
  // commander's --no-plugin produces `plugin: false` on opts when declared as
  // `--no-plugin`, but since we only expose `--no-plugin`, the parsed key
  // lives at `noPlugin` on RawFlags via our typing. Commander actually
  // sets `plugin: false`; normalize either.
  const pluginRaw = (flags as unknown as { plugin?: boolean }).plugin;
  if (pluginRaw === false) installerOptions.noPlugin = true;
  if (flags.pluginDirMode) installerOptions.pluginDirMode = true;
  if (flags.skipHooks) {
    (installerOptions as InstallOptions & { skipHooks?: boolean }).skipHooks = true;
  }
  if (flags.forceHooks) installerOptions.forceHooks = true;

  // Mode control
  if (flags.preset) out.presetFile = flags.preset;
  if (flags.interactive) out.interactive = true;
  if (flags.nonInteractive) out.interactive = false;

  // Phase 1
  if (flags.local && flags.global) {
    // explicit conflict, caught later in validate() too
  }
  if (flags.local) out.target = 'local';
  if (flags.global) out.target = 'global';
  if (flags.preserve) out.installStyle = 'preserve';
  if (flags.overwrite) out.installStyle = 'overwrite';

  // Phase 2
  if (flags.executionMode !== undefined) {
    if (
      flags.executionMode !== 'ultrawork' &&
      flags.executionMode !== 'ralph' &&
      flags.executionMode !== 'autopilot'
    ) {
      throw new InvalidOptionsError(
        `invalid --execution-mode: ${flags.executionMode} (expected ultrawork|ralph|autopilot)`,
      );
    }
    out.executionMode = flags.executionMode;
  }
  if (flags.taskTool !== undefined) {
    if (flags.taskTool !== 'builtin' && flags.taskTool !== 'bd' && flags.taskTool !== 'br') {
      throw new InvalidOptionsError(
        `invalid --task-tool: ${flags.taskTool} (expected builtin|bd|br)`,
      );
    }
    out.taskTool = flags.taskTool;
  }
  // commander: `--install-cli`/`--no-install-cli` yields `installCli: boolean`
  if (flags.installCli !== undefined) out.installCli = flags.installCli;

  // Phase 3: MCP
  if (flags.configureMcp) mcp.enabled = true;
  // commander: `--no-mcp` flag yields `mcp: false` on opts
  const mcpRaw = (flags as unknown as { mcp?: boolean }).mcp;
  if (mcpRaw === false) mcp.enabled = false;
  if (flags.mcpServers) {
    mcp.servers = parseMcpServersList(flags.mcpServers);
    if (mcp.enabled === undefined) mcp.enabled = true;
  }
  const creds: { exa?: string; github?: string } = {};
  if (flags.exaKey !== undefined) creds.exa = flags.exaKey;
  if (flags.exaKeyFile !== undefined) creds.exa = readKeyFile(flags.exaKeyFile, 'exa key file');
  if (flags.githubToken !== undefined) creds.github = flags.githubToken;
  if (flags.githubTokenFile !== undefined)
    creds.github = readKeyFile(flags.githubTokenFile, 'github token file');
  if (Object.keys(creds).length > 0) {
    mcp.credentials = creds;
  }
  if (flags.mcpOnMissingCreds !== undefined) {
    if (
      flags.mcpOnMissingCreds !== 'skip' &&
      flags.mcpOnMissingCreds !== 'error' &&
      flags.mcpOnMissingCreds !== 'install-without-auth'
    ) {
      throw new InvalidOptionsError(
        `invalid --mcp-on-missing-creds: ${flags.mcpOnMissingCreds} (expected skip|error|install-without-auth)`,
      );
    }
    mcp.onMissingCredentials = flags.mcpOnMissingCreds;
  }
  if (flags.mcpScope !== undefined) {
    if (
      flags.mcpScope !== 'local' &&
      flags.mcpScope !== 'user' &&
      flags.mcpScope !== 'project'
    ) {
      throw new InvalidOptionsError(
        `invalid --mcp-scope: ${flags.mcpScope} (expected local|user|project)`,
      );
    }
    mcp.scope = flags.mcpScope;
  }

  // Phase 3: Teams
  if (flags.enableTeams) teams.enabled = true;
  const teamsRaw = (flags as unknown as { teams?: boolean }).teams;
  if (teamsRaw === false) teams.enabled = false;
  if (flags.teamAgents !== undefined) {
    const n = Number(flags.teamAgents);
    if (n !== 2 && n !== 3 && n !== 5) {
      throw new InvalidOptionsError(
        `invalid --team-agents: ${flags.teamAgents} (expected 2|3|5)`,
      );
    }
    teams.agentCount = n;
  }
  if (flags.teamType !== undefined) {
    if (flags.teamType !== 'executor' && flags.teamType !== 'debugger' && flags.teamType !== 'designer') {
      throw new InvalidOptionsError(
        `invalid --team-type: ${flags.teamType} (expected executor|debugger|designer)`,
      );
    }
    teams.agentType = flags.teamType;
  }
  if (flags.teammateDisplay !== undefined) {
    if (
      flags.teammateDisplay !== 'auto' &&
      flags.teammateDisplay !== 'in-process' &&
      flags.teammateDisplay !== 'tmux'
    ) {
      throw new InvalidOptionsError(
        `invalid --teammate-display: ${flags.teammateDisplay} (expected auto|in-process|tmux)`,
      );
    }
    teams.displayMode = flags.teammateDisplay;
  }

  // Phase 4
  if (flags.starRepo) out.starRepo = true;
  const starRaw = (flags as unknown as { starRepo?: boolean }).starRepo;
  // commander: `--no-star-repo` ⇒ `starRepo: false`. The `--star-repo` flag
  // also maps to the same key — handle both explicitly.
  if (starRaw === false) out.starRepo = false;

  // Phase-selection flags (derivation happens in resolveOptions)
  const phases = new Set<SetupPhase>();
  if (flags.wizard) {
    phases.add('claude-md');
    phases.add('infra');
    phases.add('integrations');
    phases.add('welcome');
  }
  if (flags.claudeMdOnly) phases.add('claude-md');
  if (flags.mcpOnly) phases.add('mcp-only');
  if (
    flags.stateSave !== undefined ||
    flags.stateClear ||
    flags.stateResume ||
    flags.stateComplete !== undefined
  ) {
    phases.add('state');
  }
  if (flags.local || flags.global) phases.add('claude-md');
  if (phases.size > 0) out.phases = phases;

  // State machine
  if (flags.stateSave !== undefined) {
    const step = Number(flags.stateSave);
    if (!Number.isFinite(step) || Number.isNaN(step)) {
      throw new InvalidOptionsError('--state-save requires --step <n>');
    }
    out.stateAction = {
      op: 'save',
      step,
      configType: flags.stateConfigType ?? 'unknown',
    };
  } else if (flags.stateClear) {
    out.stateAction = { op: 'clear' };
  } else if (flags.stateResume) {
    out.stateAction = { op: 'resume' };
  } else if (flags.stateComplete !== undefined) {
    out.stateAction = { op: 'complete', version: flags.stateComplete };
  }

  if (flags.checkState) out.checkState = true;

  if (Object.keys(mcp).length > 0) out.mcp = mcp as SetupOptions['mcp'];
  if (Object.keys(teams).length > 0) out.teams = teams as SetupOptions['teams'];
  if (Object.keys(installerOptions).length > 0) out.installerOptions = installerOptions;

  // Mark raw flag presence on a non-enumerated key for validation. We
  // attach the original commander opts via a symbol so validators can
  // see which flags were actually passed (for X1, X3, X6, X11, X12).
  (out as { __rawFlags?: RawFlags }).__rawFlags = flags;

  return out;
}

// ---------------------------------------------------------------------------
// resolveOptions — merge precedence and validate
// ---------------------------------------------------------------------------

export interface ResolveContext {
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a TTY. Defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
}

/**
 * Merges flags > env > preset > defaults, derives `phases`, and validates
 * X1–X12 illegal combinations.
 *
 * @param flags   parsed CLI flags (Partial<SetupOptions>) from parseFlagsToPartial
 * @param preset  optional Partial<SetupOptions> loaded from a preset file
 * @param ctx     env/tty overrides (for testing)
 */
export function resolveOptions(
  flags: Partial<SetupOptions>,
  preset?: Partial<SetupOptions>,
  ctx: ResolveContext = {},
): SetupOptions {
  const env = ctx.env ?? process.env;
  const isTTY = ctx.isTTY ?? Boolean(process.stdin.isTTY);
  const rawFlags = (flags as { __rawFlags?: RawFlags }).__rawFlags ?? {};

  // ----- X1: --local + --global (must run BEFORE flag merge so we detect it
  // regardless of which later-wins) -----
  if (rawFlags.local && rawFlags.global) {
    throw new InvalidOptionsError('conflicting targets: --local and --global');
  }

  const envPartial = readEnvPartial(env);

  // Precedence: flags > env > preset > defaults
  const merged = mergeLayers(DEFAULTS, preset ?? {}, envPartial, flags);

  // Strip our internal marker before returning
  delete (merged as { __rawFlags?: RawFlags }).__rawFlags;

  // ----- Phase derivation -----
  if (!flags.phases && !preset?.phases) {
    // No explicit phases; infer from other flags
    merged.phases = derivePhases(rawFlags);
  }
  // Force --check-state to have no phase side effects
  if (rawFlags.checkState) {
    merged.checkState = true;
  }

  // ----- Validation: illegal combinations X1–X12 -----

  // X2: --preserve without --global (or --claude-md-only --target=global)
  if (rawFlags.preserve && !rawFlags.global && !(rawFlags.claudeMdOnly && merged.target === 'global')) {
    throw new InvalidOptionsError('--preserve only valid with --global');
  }

  // X3: --wizard + non-TTY + no --preset
  if (rawFlags.wizard && !isTTY && !rawFlags.preset) {
    throw new InvalidOptionsError('--wizard requires a TTY or --preset <file>');
  }

  // X4: --interactive + non-TTY
  if (rawFlags.interactive && !isTTY) {
    throw new InvalidOptionsError('--interactive requires a TTY');
  }

  // X6: --mcp-only without --preset and no --mcp-servers
  if (rawFlags.mcpOnly && !rawFlags.preset && !rawFlags.mcpServers) {
    throw new InvalidOptionsError(
      '--mcp-only requires --preset <file> or --mcp-servers <list>',
    );
  }

  // X11: --state-save without step argument
  // (handled earlier if stateSave is missing its arg; commander rejects a
  // bare `--state-save`. We still cover the Number(...)-NaN path.)
  if (rawFlags.stateSave !== undefined) {
    const step = Number(rawFlags.stateSave);
    if (!Number.isFinite(step)) {
      throw new InvalidOptionsError('--state-save requires --step <n>');
    }
  }

  // X12: --check-state + any phase flag
  if (rawFlags.checkState) {
    const phaseFlags =
      rawFlags.wizard ||
      rawFlags.claudeMdOnly ||
      rawFlags.mcpOnly ||
      rawFlags.local ||
      rawFlags.global ||
      rawFlags.stateSave !== undefined ||
      rawFlags.stateClear ||
      rawFlags.stateResume ||
      rawFlags.stateComplete !== undefined ||
      rawFlags.interactive ||
      rawFlags.preset !== undefined;
    if (phaseFlags) {
      throw new InvalidOptionsError(
        '--check-state is mutually exclusive with other phase flags',
      );
    }
  }

  // X5: --non-interactive + missing required field + no default
  // This fires only for the wizard/interactions phases where `target`/
  // `installStyle` would otherwise need to be prompted. For bare `omc setup`
  // (`phases: {'infra'}`), defaults always apply (target='local',
  // installStyle='overwrite') so this is a no-op.
  if (
    rawFlags.nonInteractive &&
    merged.phases.has('claude-md') &&
    !rawFlags.local &&
    !rawFlags.global &&
    !(preset && 'target' in preset) &&
    !('OMC_SETUP_TARGET' in env)
  ) {
    throw new InvalidOptionsError(
      'missing field target; pass --local/--global or add to preset',
    );
  }

  // Final interactive flag resolution: if unset, auto-detect from TTY
  if (flags.interactive === undefined && preset?.interactive === undefined) {
    merged.interactive = isTTY && !rawFlags.nonInteractive;
  }

  return merged;
}

/**
 * Derives `phases` from raw flag shape (after X1 check).
 * See plan's "Default `phases` value depends on invocation shape" table.
 */
function derivePhases(flags: RawFlags): Set<SetupPhase> {
  if (flags.wizard || flags.interactive) {
    return new Set(['claude-md', 'infra', 'integrations', 'welcome']);
  }
  if (flags.claudeMdOnly) return new Set(['claude-md']);
  if (flags.mcpOnly) return new Set(['mcp-only']);
  if (
    flags.stateSave !== undefined ||
    flags.stateClear ||
    flags.stateResume ||
    flags.stateComplete !== undefined
  ) {
    return new Set(['state']);
  }
  if (flags.local || flags.global) return new Set(['claude-md']);
  if (flags.infraOnly) return new Set(['infra']);
  // Default: programmatic callers get infra-only (matches DEFAULTS). The
  // CLI handler replaces this with SAFE_DEFAULTS for bare `omc setup`.
  return new Set(['infra']);
}

/**
 * Shallow-merge layers with later-wins precedence, deep-merging the
 * `mcp`, `teams`, and `installerOptions` sub-objects.
 */
function mergeLayers(...layers: Array<Partial<SetupOptions>>): SetupOptions {
  const out: SetupOptions = {
    ...DEFAULTS,
    mcp: { ...DEFAULTS.mcp, credentials: { ...DEFAULTS.mcp.credentials } },
    teams: { ...DEFAULTS.teams },
    installerOptions: { ...DEFAULTS.installerOptions },
    phases: new Set(DEFAULTS.phases),
  };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === '__rawFlags') continue;
      if (v === undefined) continue;
      if (k === 'mcp') {
        const lm = v as Partial<SetupOptions['mcp']>;
        out.mcp = {
          ...out.mcp,
          ...lm,
          credentials: { ...out.mcp.credentials, ...(lm.credentials ?? {}) },
          servers: lm.servers ?? out.mcp.servers,
        };
      } else if (k === 'teams') {
        out.teams = { ...out.teams, ...(v as Partial<SetupOptions['teams']>) };
      } else if (k === 'installerOptions') {
        out.installerOptions = {
          ...out.installerOptions,
          ...(v as InstallOptions),
        };
      } else if (k === 'phases') {
        out.phases = new Set(v as Iterable<SetupPhase>);
      } else {
        (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}
