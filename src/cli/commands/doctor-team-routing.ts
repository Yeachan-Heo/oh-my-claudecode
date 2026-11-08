/**
 * `omc doctor team-routing` — probe configured /team role-routing providers.
 *
 * Iterates every unique provider referenced by `team.roleRouting` (falling back
 * to `claude` when config is empty) and checks CLI presence on PATH.
 * Emits warnings (not errors) for missing binaries — AC-11.
 */

import { colors } from '../utils/formatting.js';
import { loadConfig } from '../../config/loader.js';
import { probeCli } from '../../team/cli-detection.js';
import type { TeamRoleProvider } from '../../shared/types.js';

interface ProviderProbe {
  provider: TeamRoleProvider;
  binary: string;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

const PROVIDER_BINARY: Record<TeamRoleProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  grok: 'grok',
  cursor: 'cursor-agent',
  antigravity: 'agy',
};

function probeProvider(provider: TeamRoleProvider): ProviderProbe {
  const binary = PROVIDER_BINARY[provider];
  return {
    provider,
    binary,
    ...probeCli(binary),
  };
}

function collectConfiguredProviders(): Set<TeamRoleProvider> {
  const cfg = loadConfig();
  const providers = new Set<TeamRoleProvider>();
  // Always include claude so orchestrator presence is reported.
  providers.add('claude');

  const roleRouting = cfg.team?.roleRouting ?? {};
  for (const spec of Object.values(roleRouting)) {
    const provider = spec?.provider as TeamRoleProvider | undefined;
    if (provider === 'claude' || provider === 'codex' || provider === 'gemini' || provider === 'grok' || provider === 'cursor' || provider === 'antigravity') {
      providers.add(provider);
    }
  }
  return providers;
}

export async function doctorTeamRoutingCommand(options: { json?: boolean }): Promise<number> {
  let providers: Set<TeamRoleProvider>;
  try {
    providers = collectConfiguredProviders();
  } catch (err) {
    console.error(`[OMC] Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const probes = [...providers].map(probeProvider);
  const missing = probes.filter((p) => !p.found);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          probes,
          missing: missing.map((p) => p.provider),
        },
        null,
        2,
      ),
    );
  } else {
    const claudeFound = probes.some((probe) => probe.provider === 'claude' && probe.found);
    console.log(colors.bold('Team role routing — provider CLI probe'));
    for (const p of probes) {
      if (p.found) {
        const resolvedPath = p.path ? `: ${p.path}` : '';
        const version = p.version ? ` (${p.version})` : p.error ? ' (version unavailable)' : '';
        console.log(`  ${colors.green('✓')} ${p.provider}${resolvedPath}${version}`);
      } else {
        const fallback = p.provider === 'claude'
          ? 'orchestrator/fallback unavailable'
          : claudeFound
            ? `/team tasks routed to ${p.provider} can fall back to Claude`
            : 'no available Claude fallback';
        console.log(`  ${colors.yellow('⚠')} ${p.provider}: not found on PATH — ${fallback}`);
      }
    }
    if (missing.length === 0) {
      console.log(colors.green('\nAll configured providers are available.'));
    } else if (!claudeFound) {
      console.log(
        colors.yellow(
          `\n${missing.length} provider${missing.length === 1 ? '' : 's'} missing (warn only — no available Claude fallback; orchestrator/fallback unavailable).`,
        ),
      );
    } else {
      console.log(
        colors.yellow(
          `\n${missing.length} provider${missing.length === 1 ? '' : 's'} missing (warn only — /team can fall back to Claude).`,
        ),
      );
    }
  }

  // Never error on missing providers — AC-11 says warn, not error.
  return 0;
}
