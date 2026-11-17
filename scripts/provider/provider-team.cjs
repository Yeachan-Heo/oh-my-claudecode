#!/usr/bin/env node
'use strict';
// Runs `omc team ...` so that workers start `claude` through the provider worker shim: the lead
// stays on Claude, workers of the roles listed in the profile run on the provider, every other
// role stays on Claude. Usage: provider-team 1:claude:executor,1:claude:code-reviewer "task text"
// (the arguments are the ones of `omc team`; plain `omc team` is not changed by this command).
//
// Technically: PATH starts with a directory whose `claude` shim runs provider-worker.cjs (OMC
// picks the binary with `which claude`), OMC_TRUSTED_CLI_DIRS admits that directory, and the
// profile selectors reach the clean worker pane environment through OMC_TEAM_WORKER_ENV_PASSTHROUGH,
// so the shim in the pane reads the same profile as the lead.
//
// Exit codes: 2 refused or bad configuration, 4 quota gate refusal, 127 `omc` cannot be started,
// otherwise the exit code of `omc team`.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { ProfileError, loadProfile } = require('./lib/profile.cjs');
const { isForeignProvider } = require('./lib/env.cjs');
const { mask } = require('./lib/redact.cjs');
const settingsLib = require('./lib/settings.cjs');
const { gate } = require('./lib/quota.cjs');

const fail = (code, text) => { console.error(`provider-team: ${mask(text)}`); process.exit(code); };
if (process.env.OMC_PROVIDER || isForeignProvider(process.env)) {
  fail(2, 'refused: a process with a foreign provider address, or a provider session, does not start a team (reviewers on Claude would get the provider address without provider credentials). Start the team from a Claude session.');
}
let loaded;
try { loaded = loadProfile(process.env); } catch (e) {
  if (e instanceof ProfileError) fail(e.exit, e.message);
  throw e;
}
const { profile } = loaded;

(async () => {
  const shims = settingsLib.installShims(profile, process.env, { target: join(__dirname, 'provider-worker.cjs') });
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH || '/usr/bin:/bin'}`,
    OMC_TRUSTED_CLI_DIRS: [shims, process.env.OMC_TRUSTED_CLI_DIRS].filter(Boolean).join(':'),
  };
  // The leader resolves the profile file and name, so the pane (clean environment, no XDG_CONFIG_HOME) reads the same profile.
  env.OMC_PROVIDER_PROFILES_FILE = loaded.file;
  env.OMC_PROVIDER_PROFILE = loaded.name;
  // An empty value also gets 120000 (OMC returns to its 30 s default for it); OMC clamps it to 120000. Without it a provider worker dies at start after about 30 s.
  env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS ||= '120000';
  const passthrough = String(process.env.OMC_TEAM_WORKER_ENV_PASSTHROUGH || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of Object.keys(env)) {
    if (name.startsWith('OMC_PROVIDER_') && name !== 'OMC_PROVIDER_SETTINGS_FILE' && !passthrough.includes(name)) passthrough.push(name);
  }
  // Forward the profile's environment key source (e.g., ACME_API_KEY when apiKey.env is set) so the worker can read it
  const { profile: loadedProfile } = loaded;
  if (loadedProfile?.apiKey?.env && !passthrough.includes(loadedProfile.apiKey.env)) {
    passthrough.push(loadedProfile.apiKey.env);
  }
  env.OMC_TEAM_WORKER_ENV_PASSTHROUGH = passthrough.join(',');
  // A worktree per worker is on by default: mode `named` gives every worker a branch omc-team/<team>/<worker> for review, and removal keeps unmerged commits;
  // an explicit value of the user wins (||= does not overwrite). Without a value OMC uses `disabled` and workers write into one tree.
  env.OMC_TEAM_WORKTREE_MODE ||= 'named';
  // The worktree is created from HEAD, so uncommitted changes of the lead are invisible to workers and a review diff from the base would not show them:
  // warn with the list of dirty tracked files, no refusal (OMC refuses itself: leader_worktree_dirty).
  if (!/^(disabled|0|false|no|off)$/i.test((process.env.OMC_TEAM_WORKTREE_MODE || '').trim())) {
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    const dirty = (status.stdout || '').split('\n')
      .filter((l) => l.trim() !== '' && l.slice(0, 2) !== '??' && !/^\.omc\//.test(l.slice(3).replace(/^"(.*)"$/, '$1')))
      .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
    if (dirty.length > 0) {
      console.error(`provider-team: warning: changes of the lead are invisible to worktrees: dirty tracked files in ${process.cwd()}: ${dirty.join(', ')}; commit or stash before the start (with worktree mode on, OMC refuses to start: leader_worktree_dirty)`);
    }
  }
  // Quota gate before the team starts: a refusal exits with code 4 and a message on stderr, `omc team` does not start.
  // The key comes from the same helper as the workers; no helper or no key lets the gate pass (workers abort their start with exit 3),
  // and a breaker written after an earlier quota refusal blocks even without a key.
  let key = null;
  try {
    const read = settingsLib.readKey(profile, process.env, join(__dirname, 'provider-key-helper.cjs'));
    if (read.key) key = read.key;
  } catch { /* no helper: the gate passes */ }
  const verdict = await gate(profile, env, key);
  if (verdict.refuse) { console.error(`provider-team: ${verdict.message}`); process.exit(verdict.code); }
  const run = spawnSync('omc', ['team', ...process.argv.slice(2)], { stdio: 'inherit', env });
  if (run.error) fail(127, `cannot start omc (${run.error.code || run.error.message})`);
  process.exit(run.status ?? 1);
})();
