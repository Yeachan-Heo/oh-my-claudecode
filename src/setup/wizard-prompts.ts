/**
 * Pre-phase interactive wizard for bare `omc setup` on a TTY.
 *
 * Iterates through `QUESTION_METADATA` — the same 11 questions asked by the
 * `/oh-my-claudecode:omc-setup` skill via AskUserQuestion — and collects
 * answers through a `Prompter` (`createReadlinePrompter` in production).
 *
 * The resulting `AnswersFile` is ready for `buildPreset()` to convert into
 * a fully-resolved `SetupOptions`. Conditional questions (installStyle,
 * team display/count/type, per-server credentials) are gated inline so we
 * never prompt for fields that don't apply.
 *
 * This module is invoked BEFORE `runSetup` — it is a UI-only layer. No
 * filesystem writes, no phase execution. `runSetup` is called afterwards
 * with the merged SetupOptions.
 *
 * Plan reference: user request "bare omc setup on TTY = interactive wizard
 * like /omc-setup, non-TTY = safe-defaults, --non-interactive = explicit
 * safe-defaults, --interactive non-TTY = error".
 */

import { QUESTION_METADATA } from './options.js';
import type { AnswersFile } from './preset-builder.js';
import type { Prompter, PrompterSelectOption } from './prompts.js';
import {
  formatConfigBanner,
  resolveConfigContext,
  type ConfigContext,
} from './config-context.js';

export interface WizardOptions {
  /**
   * Caller-supplied check: does the current install target have a base
   * CLAUDE.md without OMC markers? When `true`, the wizard asks the
   * `installStyle` question; when `false`, it defaults to 'overwrite' and
   * skips the prompt entirely.
   */
  detectInstallStyleNeeded?: () => boolean;
  /**
   * Pre-resolved config context (default: `resolveConfigContext()`). Tests
   * pass a fixture context so they can assert on exact paths and banner
   * content without mutating `process.env` or `process.cwd`.
   */
  configContext?: ConfigContext;
  /**
   * Override ANSI color emission for the banner (default: auto-detect
   * via `isColorEnabled()`). Tests pass `false` so fixture strings stay
   * free of escape sequences.
   */
  colorEnabled?: boolean;
  /**
   * Skip the `installCli` question entirely and resolve it as `false`
   * (i.e. do not install the CLI). Wire this to `true` when the wizard
   * is being launched FROM the `omc` CLI itself — the user clearly
   * already has the CLI on PATH, so asking whether to install it is a
   * non-sequitur. The `/oh-my-claudecode:omc-setup` skill path runs
   * inside a Claude Code session where the standalone CLI may or may
   * not be installed, so the skill leaves this flag at its default
   * (`false`) and still shows the question.
   */
  skipInstallCliQuestion?: boolean;
}

// ---------------------------------------------------------------------------
// Label → value mappings
// ---------------------------------------------------------------------------
// QUESTION_METADATA stores user-facing labels verbatim. We translate them
// back into the canonical values expected by `buildPreset()` / `AnswersFile`.
// When adding a new question spec, add the label mapping here too.
// ---------------------------------------------------------------------------

function mapTarget(label: string): 'local' | 'global' {
  if (label.startsWith('Local')) return 'local';
  if (label.startsWith('Global')) return 'global';
  return 'local';
}

function mapInstallStyle(label: string): 'overwrite' | 'preserve' {
  if (label.startsWith('Overwrite')) return 'overwrite';
  if (label.startsWith('Keep')) return 'preserve';
  return 'overwrite';
}

function mapExecutionMode(label: string): 'ultrawork' | undefined {
  if (label.startsWith('ultrawork')) return 'ultrawork';
  // "No default" → undefined so buildPreset leaves executionMode unset
  return undefined;
}

function mapInstallCli(label: string): boolean {
  return label.startsWith('Yes');
}

function mapTaskTool(label: string): 'builtin' | 'bd' | 'br' {
  if (label.startsWith('Beads-Rust')) return 'br';
  if (label.startsWith('Beads')) return 'bd';
  return 'builtin';
}

function mapMcpEnabled(label: string): boolean {
  return label.startsWith('Yes');
}

function mapTeamsEnabled(label: string): boolean {
  return label.startsWith('Yes');
}

function mapTeamDisplay(label: string): 'auto' | 'in-process' | 'tmux' {
  if (label.startsWith('Auto')) return 'auto';
  if (label.startsWith('In-process')) return 'in-process';
  if (label.startsWith('Split')) return 'tmux';
  return 'auto';
}

function mapTeamAgentCount(label: string): 2 | 3 | 5 {
  if (label.startsWith('2')) return 2;
  if (label.startsWith('5')) return 5;
  return 3;
}

function mapTeamAgentType(label: string): 'executor' | 'debugger' | 'designer' {
  if (label.startsWith('debugger')) return 'debugger';
  if (label.startsWith('designer')) return 'designer';
  return 'executor';
}

function mapStarRepo(label: string): boolean {
  return label.startsWith('Yes');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the default label for a question spec. The spec's `default` is
 * stored in canonical form (e.g. 'local', true, 3); we need to find the
 * label that maps to that value so `askSelect` can render a `*` marker on
 * the right option and fall back to it on empty input.
 *
 * For boolean questions the "Yes" option is default when `true`, "No" when
 * `false`. For string/number questions we match by the first option whose
 * mapped value equals the canonical default.
 */
function defaultLabelFor(
  questionKey: keyof typeof QUESTION_METADATA,
): string {
  const spec = QUESTION_METADATA[questionKey];
  if (!spec) throw new Error(`unknown question key: ${String(questionKey)}`);
  const rawDefault = spec.default;

  // Boolean questions (installCli, mcpEnabled, teamsEnabled, starRepo)
  if (typeof rawDefault === 'boolean') {
    const match = spec.options.find((o) =>
      rawDefault ? o.label.startsWith('Yes') : o.label.startsWith('No'),
    );
    return match?.label ?? spec.options[0].label;
  }

  // Numeric questions (teamsAgentCount)
  if (typeof rawDefault === 'number') {
    const match = spec.options.find((o) =>
      o.label.startsWith(String(rawDefault)),
    );
    return match?.label ?? spec.options[0].label;
  }

  // String questions — match by prefix against known canonical values.
  // Works for target ('local' → "Local (...)"), executionMode ('ultrawork'),
  // taskTool ('builtin' → "Built-in"), teamsDisplayMode ('auto' → "Auto"),
  // teamsAgentType ('executor' → "executor"), installStyle ('overwrite').
  if (typeof rawDefault === 'string') {
    // Case-insensitive prefix match on the canonical value
    const lc = rawDefault.toLowerCase();
    const match = spec.options.find((o) => {
      const label = o.label.toLowerCase();
      return (
        label.startsWith(lc)
        || label.startsWith(`${lc} `)
        || (lc === 'overwrite' && label.startsWith('overwrite'))
        || (lc === 'builtin' && label.startsWith('built-in'))
        || (lc === 'ultrawork' && label.startsWith('ultrawork'))
      );
    });
    return match?.label ?? spec.options[0].label;
  }

  return spec.options[0].label;
}

/**
 * Convert a QuestionSpec's options into the `PrompterSelectOption<string>[]`
 * shape `askSelect` expects (labels as the generic parameter, descriptions
 * forwarded verbatim).
 *
 * When `descriptionOverrides` is supplied, each entry replaces the static
 * description for the matching option label. This is how we inject
 * CLAUDE_CONFIG_DIR-aware paths into the `target` question at runtime
 * without having to store per-profile strings in QUESTION_METADATA.
 */
function specOptions(
  spec: (typeof QUESTION_METADATA)[keyof typeof QUESTION_METADATA],
  descriptionOverrides: Record<string, string> = {},
): PrompterSelectOption<string>[] {
  return spec.options.map((o) => ({
    label: o.label,
    description: descriptionOverrides[o.label] ?? o.description,
  }));
}

async function askQuestion(
  prompter: Prompter,
  key: keyof typeof QUESTION_METADATA,
  descriptionOverrides?: Record<string, string>,
): Promise<string> {
  const spec = QUESTION_METADATA[key];
  const defaultLabel = defaultLabelFor(key);
  return prompter.askSelect(
    spec.question,
    specOptions(spec, descriptionOverrides),
    defaultLabel,
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the 11-question interactive wizard and return an `AnswersFile` ready
 * for `buildPreset()`. Conditional questions are gated inline.
 *
 * Prompter lifecycle is the caller's responsibility — this function never
 * constructs or closes a prompter itself.
 */
export async function runInteractiveWizard(
  prompter: Prompter,
  opts: WizardOptions = {},
): Promise<AnswersFile> {
  // Pre-Q1: print the CLAUDE_CONFIG_DIR-aware banner so the user can see
  // which profile the wizard is targeting BEFORE committing to an answer.
  // Critical for users with multiple profiles (e.g. `~/.claude` vs
  // `~/.claude-personal`) — prevents silently overwriting the wrong file.
  const configContext = opts.configContext ?? resolveConfigContext();
  prompter.write(
    formatConfigBanner(configContext, { colorEnabled: opts.colorEnabled }),
  );

  // Q1: target (local | global). Build fully-custom option labels that
  // embed the resolved absolute path in the LABEL (not just the
  // description) so the user sees exactly which file would be touched
  // as the most prominent piece of text on each line. The decoder still
  // uses `startsWith('Local')` / `startsWith('Global')` so the mapping
  // helper doesn't need to know about the runtime label format.
  const localPath = configContext.localFiles[0];
  const globalPath = configContext.globalFiles[0];
  const targetOptions = [
    {
      label: `Local → ${localPath}`,
      description: 'project-scoped; only affects this working directory.',
    },
    {
      label: `Global → ${globalPath}`,
      description: configContext.envVarSet
        ? `CLAUDE_CONFIG_DIR profile (${configContext.configDir}); affects all Claude Code sessions on this profile.`
        : 'default profile; affects all Claude Code sessions.',
    },
  ];
  const targetDefaultLabel = targetOptions[0].label; // Local is the default
  const targetLabel = await prompter.askSelect(
    QUESTION_METADATA.target.question,
    targetOptions,
    targetDefaultLabel,
  );
  const target = mapTarget(targetLabel);

  // Q2: installStyle — only when target=global AND a non-OMC base CLAUDE.md
  // already exists (caller decides via detectInstallStyleNeeded).
  // Same treatment as Q1: build fully-custom labels with the resolved
  // paths baked in so the user sees exactly which base/companion files
  // each choice will modify, and inject the resolved base path into the
  // question text itself for a third independent visibility point.
  let installStyle: 'overwrite' | 'preserve' = 'overwrite';
  const needInstallStyle =
    target === 'global' && (opts.detectInstallStyleNeeded?.() ?? false);
  if (needInstallStyle) {
    const basePath = configContext.globalFiles[0];
    const companionPath =
      configContext.globalFilesPreserve.find(
        (f) => !configContext.globalFiles.includes(f),
      ) ?? `${configContext.configDir}/CLAUDE-omc.md`;
    const installStyleQuestion =
      `Global setup will modify ${basePath}. Which behavior do you want?`;
    const installStyleOptions = [
      {
        label: `Overwrite ${basePath} (Recommended)`,
        description:
          'plain `claude` and `omc` both load OMC globally from the base file.',
      },
      {
        label: `Keep base ${basePath}; install companion ${companionPath}`,
        description:
          "preserves user's base file; `omc` launcher force-loads the companion at launch.",
      },
    ];
    const installStyleDefaultLabel = installStyleOptions[0].label; // Overwrite
    const installStyleLabel = await prompter.askSelect(
      installStyleQuestion,
      installStyleOptions,
      installStyleDefaultLabel,
    );
    installStyle = mapInstallStyle(installStyleLabel);
  }

  // Q3: executionMode
  const executionModeLabel = await askQuestion(prompter, 'executionMode');
  const executionMode = mapExecutionMode(executionModeLabel);

  // Q4: installCli — skipped when launched from the `omc` CLI itself,
  // because the user obviously already has the CLI installed and asking
  // them to re-install it via `npm i -g` is noise. The default value
  // when skipped is `false` (don't install; we're already installed).
  let installCli = false;
  if (!opts.skipInstallCliQuestion) {
    const installCliLabel = await askQuestion(prompter, 'installCli');
    installCli = mapInstallCli(installCliLabel);
  }

  // Q5: taskTool
  const taskToolLabel = await askQuestion(prompter, 'taskTool');
  const taskTool = mapTaskTool(taskToolLabel);

  // Q6: mcpEnabled
  const mcpEnabledLabel = await askQuestion(prompter, 'mcpEnabled');
  const mcpEnabled = mapMcpEnabled(mcpEnabledLabel);

  // Q6b: MCP credentials (only when mcpEnabled). Blank input → skip that
  // credential; the server is still installed via the same
  // install-without-auth policy as SAFE_DEFAULTS so the user can add the
  // key later without re-running setup.
  const credentials: { exa?: string; github?: string } = {};
  const mcpServers: Array<'context7' | 'exa' | 'filesystem' | 'github'> = [];
  if (mcpEnabled) {
    mcpServers.push('context7', 'exa', 'filesystem', 'github');
    const exaKey = (
      await prompter.askSecret('Exa API key (blank to skip; server stays visible-but-broken):')
    ).trim();
    if (exaKey.length > 0) credentials.exa = exaKey;

    const githubToken = (
      await prompter.askSecret('GitHub token (blank to skip; server stays visible-but-broken):')
    ).trim();
    if (githubToken.length > 0) credentials.github = githubToken;
  }

  // Q7: teamsEnabled
  const teamsEnabledLabel = await askQuestion(prompter, 'teamsEnabled');
  const teamsEnabled = mapTeamsEnabled(teamsEnabledLabel);

  // Q7b-d: team display / count / type — only when teamsEnabled
  let teamsDisplayMode: 'auto' | 'in-process' | 'tmux' = 'auto';
  let teamsAgentCount: 2 | 3 | 5 = 3;
  let teamsAgentType: 'executor' | 'debugger' | 'designer' = 'executor';
  if (teamsEnabled) {
    const displayLabel = await askQuestion(prompter, 'teamsDisplayMode');
    teamsDisplayMode = mapTeamDisplay(displayLabel);

    const countLabel = await askQuestion(prompter, 'teamsAgentCount');
    teamsAgentCount = mapTeamAgentCount(countLabel);

    const typeLabel = await askQuestion(prompter, 'teamsAgentType');
    teamsAgentType = mapTeamAgentType(typeLabel);
  }

  // Q8: starRepo
  const starRepoLabel = await askQuestion(prompter, 'starRepo');
  const starRepo = mapStarRepo(starRepoLabel);

  return {
    target,
    installStyle,
    executionMode,
    installCli,
    taskTool,
    mcp: {
      enabled: mcpEnabled,
      servers: mcpServers,
      credentials,
      // Match SAFE_DEFAULTS — a blank-credential server should still be
      // installed so the user can fix it later with `claude mcp ...`.
      onMissingCredentials: 'install-without-auth',
    },
    teams: {
      enabled: teamsEnabled,
      displayMode: teamsDisplayMode,
      agentCount: teamsAgentCount,
      agentType: teamsAgentType,
    },
    starRepo,
  };
}
