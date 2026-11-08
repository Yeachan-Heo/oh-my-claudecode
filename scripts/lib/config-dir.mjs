import { homedir } from 'node:os';
import { join, normalize, parse, sep } from 'node:path';

function stripTrailingSep(p) {
  if (!p.endsWith(sep)) {
    return p;
  }

  return p === parse(p).root ? p : p.slice(0, -1);
}

export function getClaudeConfigDir() {
  const home = homedir();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();

  if (!configured) {
    return stripTrailingSep(normalize(join(home, '.claude')));
  }

  if (configured === '~') {
    return stripTrailingSep(normalize(home));
  }

  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return stripTrailingSep(normalize(join(home, configured.slice(2))));
  }

  return stripTrailingSep(normalize(configured));
}

export function getOmcConfigDir() {
  return join(getClaudeConfigDir(), '.omc');
}

export function getUpdateCheckCachePath() {
  return join(getOmcConfigDir(), 'update-check.json');
}
