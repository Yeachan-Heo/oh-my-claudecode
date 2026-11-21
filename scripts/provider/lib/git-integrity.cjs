// Integrity digest of the shared part of a git repository (config, hooks, info/*).
// A worktree shares these files with the main repository (git rev-parse --git-common-dir), so a digest taken
// in a worktree also covers files whose change (for example a hook in .git/hooks) would run at the next commit of the user.
// gitDigest returns { digest, entries }: entries are [relative path, sha256 of the content] sorted by path
// (an unreadable file is recorded as a marker, so a permission change shows up too); null when cwd is not
// a git repository or git is unavailable (no check then, nothing is blocked).
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

// Only config keys that matter for identity and isolation are hashed, not the whole file: unrelated
// keys changed during a run (for example an upstream set by another session) do not count as a change.
const RELEVANT_CONFIG_KEYS = /^(user\.|remote\.|core\.hookspath|core\.sshcommand|alias\.|include|credential\.|url\.)/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function gitDigest(cwd) {
  let common;
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    common = resolve(cwd, r.stdout.trim());
  } catch { return null; }
  if (!common) return null;

  const entries = [];
  const markerOf = (path) => {
    try { return sha256(readFileSync(path)); } catch { return 'unreadable'; }
  };

  try {
    const text = readFileSync(join(common, 'config'), 'utf8');
    let section = '';
    const lines = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const header = /^\[([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\]$/.exec(line);
      if (header) { section = `${header[1].toLowerCase()}${header[2] ? `.${header[2]}` : ''}`; continue; }
      const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line);
      if (!entry || !section) continue;
      const key = `${section}.${entry[1].toLowerCase()}`;
      if (RELEVANT_CONFIG_KEYS.test(key)) lines.push(`${key}${entry[2] !== undefined ? ` = ${entry[2].trim()}` : ''}`);
    }
    lines.sort();
    entries.push(['config (relevant keys)', sha256(lines.join('\n'))]);
  } catch {
    // Missing or unreadable config: digest of the whole file (behaviour before the key filter).
    entries.push(['config', markerOf(join(common, 'config'))]);
  }

  const readDir = (dir, prefix) => {
    let list;
    try { list = readdirSync(join(common, dir), { withFileTypes: true }); } catch { return; } // missing directory: no entries
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) {
      if (item.isDirectory()) readDir(join(dir, item.name), `${prefix}${item.name}/`);
      else entries.push([`${prefix}${item.name}`, markerOf(join(common, dir, item.name))]);
    }
  };
  readDir('hooks', 'hooks/');
  readDir('info', 'info/');

  const h = createHash('sha256');
  for (const [rel, mark] of entries) h.update(`${rel}\0${mark}\0`);
  return { digest: h.digest('hex'), entries };
}

// Compares two gitDigest results. Returns null when equal (or both absent), otherwise a description of the
// change for the user: added, removed or changed paths, at most 20 items with the count of the rest.
function compareDigest(before, after) {
  if (!before && !after) return null;
  if (!before || !after) return 'the git repository disappeared or appeared during the task';
  if (before.digest === after.digest) return null;
  const now = new Map(after.entries);
  const earlier = new Set(before.entries.map((e) => e[0]));
  const changes = [];
  for (const [path, mark] of before.entries) {
    const current = now.get(path);
    if (current === undefined) changes.push(`removed ${path}`);
    else if (current !== mark) changes.push(`changed ${path}`);
  }
  for (const [path] of after.entries) if (!earlier.has(path)) changes.push(`added ${path}`);
  if (!changes.length) return 'git directory content changed without a change in the list of config, hooks and info/* files';
  const list = changes.slice(0, 20).join(', ');
  return changes.length > 20 ? `${list}, +${changes.length - 20} more` : list;
}

module.exports = { gitDigest, compareDigest, RELEVANT_CONFIG_KEYS };
