// Drift fixture for scripts/ci/check-multirepo-paths.mjs
//
// This file intentionally contains a raw .omc construction that bypasses
// resolveSessionStatePaths()/getOmcRoot(). The gate must DETECT this when
// the file is scanned outside its whitelisted parent directory.
//
// Usage (manual verification):
//   node scripts/ci/check-multirepo-paths.mjs --root tests/fixtures/multirepo
//
// Expected: exit code 1, hit reported at the join() call below.
//
// (The 'tests' directory is whitelisted by default for legitimate test fixtures,
// so an unmodified run against REPO_ROOT will skip this file. The --root override
// is what proves the gate is functional.)

import { join } from 'node:path';

export function intentionallyWrong(dir) {
  // ↓ This is the construction the gate is designed to catch.
  return join(dir, '.omc', 'state', 'fixture.json');
}

export function homeStateIsStillWorkspaceState(home) {
  // ↓ Caught too: only `join(home, '.omc', 'config.json')` is the global config.
  return join(home, '.omc', 'state', 'fixture.json');
}

export function homeConfigOutsideTheResolver(home) {
  // ↓ Caught too: `home` may name a workspace root outside getGlobalOmcConfigCandidates().
  return join(home, '.omc', 'config.json');
}

export function getGlobalOmcConfigCandidates(home) {
  // Not reported: the hook-side mirror of the per-user global config resolver.
  return [join(home, '.omc', 'config.json')];
}
