/**
 * Phase 3 glue — plugin verification + MCP install + teams config.
 *
 * Sequence (from plan "Phase 2 / 3 / 4 glue" section):
 *   1. Plugin verification: grep `<configDir>/settings.json` for the
 *      string `oh-my-claudecode`. Emit a status line either way.
 *   2. MCP install when `options.mcp.enabled`: delegate to
 *      `installMcpServers()` from `../mcp-install.js` (worker-2) with
 *      `--scope user` always, passing through servers, credentials,
 *      onMissingCredentials, and `options.interactive`.
 *   3. Teams config when `options.teams.enabled`:
 *        - Write `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"` into
 *          `settings.json` via `config-writer.ts` (preserving existing
 *          `env` keys — the helper deep-merges `env`).
 *        - Write `teammateMode` into `settings.json` when `displayMode`
 *          is not the auto default.
 *        - Write `team.{maxAgents,defaultAgentType,monitorIntervalMs,
 *          shutdownTimeoutMs}` into `.omc-config.json` via
 *          `mergeOmcConfig`. Timing intervals are fixed defaults for now.
 *
 * Pure function: no module-level side effects. All stdout via injected
 * logger; errors propagate via throw.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installMcpServers as realInstallMcpServers } from '../mcp-install.js';
import {
  mergeOmcConfig as realMergeOmcConfig,
  mergeSettingsJson as realMergeSettingsJson,
} from '../config-writer.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import type { SetupOptions } from '../options.js';

export type Logger = (line: string) => void;

/** Structured result surfaced to runSetup + phase4. */
export interface Phase3Result {
  pluginVerified: boolean;
  mcpInstalled: string[];
  mcpSkipped: string[];
  teamsConfigured: boolean;
}

export interface Phase3Deps {
  /** Test seam: replace the MCP installer. Matches `installMcpServers`. */
  installMcpServers?: typeof realInstallMcpServers;
  /** Test seam: replace the `.omc-config.json` writer. */
  mergeOmcConfig?: typeof realMergeOmcConfig;
  /** Test seam: replace the `settings.json` writer. */
  mergeSettingsJson?: typeof realMergeSettingsJson;
  /** Override the config directory (tmpdir isolation). */
  configDir?: string;
  /** Override cwd (plumbed through to `mergeOmcConfig`). */
  cwd?: string;
}

/**
 * Run Phase 3 — plugin verification + MCP + teams config.
 *
 * Returns a structured result so runSetup can aggregate for the welcome
 * message (phase 4) and any post-phase diagnostics.
 */
export async function runPhase3(
  options: SetupOptions,
  logger: Logger,
  deps: Phase3Deps = {},
): Promise<Phase3Result> {
  const installMcp = deps.installMcpServers ?? realInstallMcpServers;
  const mergeOmc = deps.mergeOmcConfig ?? realMergeOmcConfig;
  const mergeSettings = deps.mergeSettingsJson ?? realMergeSettingsJson;
  const configDir = deps.configDir ?? getClaudeConfigDir();

  // 1. Plugin verification — a best-effort grep of settings.json.
  const settingsPath = join(configDir, 'settings.json');
  let pluginVerified = false;
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf8');
      if (content.includes('oh-my-claudecode')) {
        pluginVerified = true;
      }
    } catch {
      /* fall through — treated as NOT verified */
    }
  }
  if (pluginVerified) {
    logger('Plugin verified');
  } else {
    logger('Plugin NOT found - run: claude /install-plugin oh-my-claudecode');
  }

  // 2. MCP install (opt-in).
  let mcpInstalled: string[] = [];
  let mcpSkipped: string[] = [];
  if (options.mcp.enabled) {
    const mcpResult = await installMcp(
      options.mcp.servers,
      options.mcp.credentials,
      {
        interactive: options.interactive,
        onMissingCredentials: options.mcp.onMissingCredentials,
        // Plan: "every `claude mcp add` invocation MUST pass `--scope user`"
        // Intentionally hard-coded here — not taken from `options.mcp.scope`,
        // which is reserved for a future `--mcp-scope` CLI flag.
        scope: 'user',
        logger,
      },
    );
    mcpInstalled = mcpResult.installed;
    mcpSkipped = mcpResult.skippedDueToMissingCreds;
    if (mcpInstalled.length > 0) {
      logger(`Installed MCP servers: ${mcpInstalled.join(', ')}`);
    }
    if (mcpSkipped.length > 0) {
      logger(`Skipped MCP servers (missing credentials): ${mcpSkipped.join(', ')}`);
    }
  }

  // 3. Teams config (opt-in).
  let teamsConfigured = false;
  if (options.teams.enabled) {
    const settingsPatch: Record<string, unknown> = {
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    };
    if (options.teams.displayMode !== 'auto') {
      settingsPatch['teammateMode'] = options.teams.displayMode;
    }
    mergeSettings(settingsPatch, { configDir });

    mergeOmc(
      {
        team: {
          maxAgents: options.teams.agentCount,
          defaultAgentType: options.teams.agentType,
          monitorIntervalMs: 30000,
          shutdownTimeoutMs: 15000,
        },
      },
      { configDir, cwd: deps.cwd },
    );

    teamsConfigured = true;
    logger('Enabled agent teams (experimental)');
  }

  return { pluginVerified, mcpInstalled, mcpSkipped, teamsConfigured };
}
