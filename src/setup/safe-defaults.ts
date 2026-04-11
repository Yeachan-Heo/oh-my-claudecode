/**
 * SAFE_DEFAULTS — opinionated out-of-the-box preset used by bare `omc setup`.
 *
 * Separate from DEFAULTS (in ./options.ts) on purpose:
 *   - DEFAULTS is the *minimal-fields fallback* used by programmatic callers
 *     that explicitly want "infra-only, no surprises". It pins the legacy
 *     pre-safe-defaults contract so automation that drives the setup API
 *     directly never regresses.
 *   - SAFE_DEFAULTS is the *user-friendly out-of-box experience* the CLI
 *     wires in when the user types `omc setup` with no opt-in phase flags.
 *     It enables CLAUDE.md, infra, integrations, welcome, a curated MCP
 *     server list with install-without-auth fallback, sane team defaults,
 *     repo star prompt, and a HUD element config that turns on cwd, git
 *     branch, git status, and session health while disabling progress bars.
 *
 * The CLI may also expose SAFE_DEFAULTS via `omc setup --dump-safe-defaults`
 * so users can copy-and-tweak the JSON into a custom preset file.
 */

import type { HudElementConfig } from '../hud/types.js';
import type { SetupOptions, SetupPhase } from './options.js';

/**
 * Canonical safe-defaults preset. Frozen at the top level (nested `Set` and
 * object fields are cloned by callers that need to mutate — see tests).
 */
export const SAFE_DEFAULTS: SetupOptions = Object.freeze({
  phases: new Set<SetupPhase>(['claude-md', 'infra', 'integrations', 'welcome']),
  interactive: false,
  force: false,
  quiet: false,
  target: 'global',
  installStyle: 'overwrite',
  installCli: false,
  executionMode: 'ultrawork',
  taskTool: 'builtin',
  skipHud: false,
  mcp: {
    enabled: true,
    servers: ['context7', 'exa', 'filesystem', 'github'],
    credentials: {},
    onMissingCredentials: 'install-without-auth',
    scope: 'user',
  },
  teams: {
    enabled: true,
    displayMode: 'auto',
    agentCount: 3,
    agentType: 'executor',
  },
  starRepo: true,
  installerOptions: {},
  hud: {
    elements: {
      cwd: true,
      gitBranch: true,
      gitStatus: true,
      sessionHealth: true,
      useBars: false,
      contextBar: false,
    } as Partial<HudElementConfig>,
  },
}) as SetupOptions;

/**
 * Serialize SAFE_DEFAULTS to a JSON string suitable for `omc setup
 * --dump-safe-defaults > my-preset.json`. Phases are emitted as an array
 * (not a Set) so the output round-trips through `loadPreset()`.
 */
export function dumpSafeDefaultsAsJson(): string {
  const snapshot = {
    ...SAFE_DEFAULTS,
    phases: Array.from(SAFE_DEFAULTS.phases),
    mcp: {
      ...SAFE_DEFAULTS.mcp,
      credentials: { ...SAFE_DEFAULTS.mcp.credentials },
      servers: [...SAFE_DEFAULTS.mcp.servers],
    },
    teams: { ...SAFE_DEFAULTS.teams },
    installerOptions: { ...SAFE_DEFAULTS.installerOptions },
    hud: SAFE_DEFAULTS.hud
      ? {
          elements: { ...SAFE_DEFAULTS.hud.elements },
        }
      : undefined,
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
