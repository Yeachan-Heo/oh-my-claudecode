/**
 * `omc doctor team-routing` — probe configured /team role-routing providers.
 *
 * Iterates every unique provider referenced by `team.roleRouting` (falling back
 * to `claude` when config is empty) and checks CLI presence on PATH.
 * Emits warnings (not errors) for missing binaries — AC-11.
 */

import { execSync } from 'child_process';
import { colors } from '../utils/formatting.js';
import { loadConfig } from '../../config/loader.js';
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
};

function probeProvider(provider: TeamRoleProvider): ProviderProbe {
  const binary = PROVIDER_BINARY[provider];
  const probe: ProviderProbe = { provider, binary, found: false };

  try {
    const resolved = execSync(`command -v ${binary}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
    if (resolved) {
      probe.found = true;
      probe.path = resolved;
      try {
        const version = execSync(`${binary} --version`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
          .trim()
          .split('\n')[0];
        if (version) probe.version = version;
      } catch {
        // Version probe is best-effort; binary found is enough.
      }
    }
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
  }

  return probe;
}

function collectConfiguredProviders(): Set<TeamRoleProvider> {
  const cfg = loadConfig();
  const providers = new Set<TeamRoleProvider>();
  // Always include claude so orchestrator presence is reported.
  providers.add('claude');

  const roleRouting = cfg.team?.roleRouting ?? {};
  for (const spec of Object.values(roleRouting)) {
    const provider = spec?.provider as TeamRoleProvider | undefined;
    if (provider === 'claude' || provider === 'codex' || provider === 'gemini') {
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
    console.log(colors.bold('Team role routing — provider CLI probe'));
    for (const p of probes) {
      if (p.found) {
        const version = p.version ? ` (${p.version})` : '';
        console.log(`  ${colors.green('✓')} ${p.provider}: ${p.path}${version}`);
      } else {
        console.log(`  ${colors.yellow('⚠')} ${p.provider}: not found on PATH — /team tasks routed to ${p.provider} will fall back to claude`);
      }
    }
    if (missing.length === 0) {
      console.log(colors.green('\nAll configured providers are available.'));
    } else {
      console.log(
        colors.yellow(
          `\n${missing.length} provider${missing.length === 1 ? '' : 's'} missing (warn only — /team falls back to claude).`,
        ),
      );
    }
  }

  // Never error on missing providers — AC-11 says warn, not error.
  return 0;
}
