#!/usr/bin/env node
// Read-only report on the git worktrees of one or more repositories: for each worktree it says whether it is
// safe to clean up (locked, current, external, merged, dirty, missing on disk). It never deletes anything:
// no worktree removal, no prune, no branch deletion, no file removal. Only read commands of git are run.
//
//   node tools/maintenance/worktree_report.mjs [--repo <path>]... [--repos-file <file>] [--main-branch <name>]
//        [--min-age-days <n>] [--exclude <prefix>]... [--git-timeout <seconds>] [--json]
//
// --repo            repository to report on (repeatable); with no --repo and no --repos-file the repository of the
//                   current directory is used
// --repos-file      text file with one repository path per line; only lines starting with "/" are paths, comments
//                   and blank lines are ignored
// --main-branch     main branch of the repositories (default main); "merged" means contained in this branch
// --min-age-days    a worktree directory not modified for more than this many days counts as old (default 0 = off)
// --exclude         path prefix that marks worktrees as external (repeatable; "~" is the home directory)
// --git-timeout     time limit of every git call in seconds (default 30); a call that runs out of time skips the
//                   worktree (reason git_timeout, kept) or, for a repository-level call, the whole repository
// --json            JSON output instead of a text table
// Exit code: 0 report printed (also when some repositories were skipped), 2 usage error (unknown option, missing
// value, missing repository list file). Node 20+, built-in modules only; needs git.
//
// Decision per worktree, first matching rule wins (this order is the documented, stable reason order):
//   keep   locked            the worktree is locked
//   keep   current           the worktree is the one the tool was started from, or the main worktree
//   keep   external          the path is, or lies under, an --exclude prefix
//   prune  missing           the path no longer exists (a stale registration)
//   keep   dirty             the status listing is not empty, or the status command failed
//   keep   unmerged          neither merged into the main branch nor old
//   sweep  merged            not protected, and merged into the main branch
//   sweep  old_unmerged      not protected, not merged, but older than --min-age-days
// A worktree whose git call timed out is reported as keep with the reason git_timeout and "skipped": "git_timeout".
// A locked, current or external worktree is never reported as prune or sweep (these protections win over cleanup, also
// for a missing directory). The dirty and unmerged rules apply only to worktrees that exist on disk.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node worktree_report.mjs [--repo <path>]... [--repos-file <file>] [--main-branch <name>] [--min-age-days <n>] [--exclude <prefix>]... [--git-timeout <seconds>] [--json]';
const DAY_MS = 86400000;
const DEFAULT_GIT_TIMEOUT_SECONDS = 30;

class UsageError extends Error {}
class GitTimeout extends Error {}

/** Parse the output of `git worktree list --porcelain` into worktree records. The first one is the main worktree. */
export function parseWorktreeList(text) {
  const blocks = [];
  let block = null;
  const flush = () => { if (block && block.path) blocks.push(block); block = null; };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') { flush(); continue; }
    if (!block) block = { path: '', head: '', branch: '', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' };
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') block.path = value;
    else if (key === 'HEAD') block.head = value;
    else if (key === 'branch') block.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') block.detached = true;
    else if (key === 'bare') block.bare = true;
    else if (key === 'locked') { block.locked = true; block.lockReason = value; }
    else if (key === 'prunable') { block.prunable = true; block.pruneReason = value; }
    // unknown lines are ignored
  }
  flush();
  return blocks;
}

/** The decision and reason of one worktree record (see the rule order in the header). */
export function decide(w) {
  if (w.locked) return { decision: 'keep', reason: 'locked' };
  if (w.current) return { decision: 'keep', reason: 'current' };
  if (w.external) return { decision: 'keep', reason: 'external' };
  if (!w.exists) return { decision: 'prune', reason: 'missing' };
  if (w.dirty) return { decision: 'keep', reason: 'dirty' };
  if (w.merged !== true && !w.old) return { decision: 'keep', reason: 'unmerged' };
  return { decision: 'sweep', reason: w.merged === true ? 'merged' : 'old_unmerged' };
}

/** Expand a leading "~" to the home directory and resolve the path. */
export function expandPrefix(prefix) {
  const expanded = prefix === '~' ? homedir() : (prefix.startsWith('~/') ? homedir() + prefix.slice(1) : prefix);
  return resolve(expanded);
}

/** True when `path` equals a prefix or lies under it (a whole path segment, not a text prefix). */
export function isExternal(path, prefixes) {
  const p = resolve(path);
  return prefixes.some((x) => p === x || p.startsWith(x.endsWith(sep) ? x : x + sep));
}

/** Repository paths from a list file: lines starting with "/" are paths; comments and blank lines are ignored. */
export function parseRepoList(text) {
  return String(text).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
}

// Runs one read-only git command; throws GitTimeout when it runs longer than timeoutMs.
function git(cwd, args, timeoutMs) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new GitTimeout(`git ${args[0]} timed out`);
  return { status: r.error ? -1 : r.status, stdout: r.stdout || '' };
}

const realOrResolved = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Exit 0: ancestor (equality included); exit 1: not an ancestor; anything else: unknown.
function isAncestor(repo, ancestor, descendant, timeoutMs) {
  const r = git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], timeoutMs);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

function isOld(path, minAgeDays, now) {
  if (!(minAgeDays > 0)) return false;
  try { return now - statSync(path).mtimeMs > minAgeDays * DAY_MS; } catch { return false; }
}

/** Report on one repository. Returns { repo, skipped?, hint?, mainBranch, worktrees }. */
export function reportRepo(repo, { mainBranch = 'main', minAgeDays = 0, exclude = [], cwd = process.cwd(), now = Date.now(), gitTimeoutSeconds = DEFAULT_GIT_TIMEOUT_SECONDS } = {}) {
  const base = { repo, mainBranch };
  const timeoutMs = gitTimeoutSeconds * 1000;
  const skippedRepo = (skipped, hint) => ({ ...base, skipped, hint, worktrees: [] });
  let listed;
  let startedFrom = null;
  try {
    if (!existsSync(repo) || git(repo, ['rev-parse', '--git-dir'], timeoutMs).status !== 0) {
      return skippedRepo('not_a_repository', 'the path is not a git repository');
    }
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${mainBranch}`], timeoutMs).status !== 0) {
      return skippedRepo('no_main_branch', `branch "${mainBranch}" not found; use --main-branch <name>`);
    }
    listed = git(repo, ['worktree', 'list', '--porcelain'], timeoutMs);
    if (listed.status !== 0) return skippedRepo('worktree_list_failed', 'git worktree list failed');
  } catch (e) {
    if (!(e instanceof GitTimeout)) throw e;
    return skippedRepo('git_timeout', `a git call took longer than ${gitTimeoutSeconds} seconds`);
  }
  const mainRef = `refs/heads/${mainBranch}`;
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel'], timeoutMs);
    startedFrom = top.status === 0 ? realOrResolved(top.stdout.trim()) : null;
  } catch (e) {
    if (!(e instanceof GitTimeout)) throw e;
  }
  const prefixes = exclude.map(expandPrefix);
  const records = parseWorktreeList(listed.stdout);
  const worktrees = records.map((rec, index) => {
    const exists = existsSync(rec.path);
    const w = {
      path: rec.path,
      branch: rec.branch,
      head: rec.head,
      detached: rec.detached,
      bare: rec.bare,
      locked: rec.locked,
      lock_reason: rec.lockReason,
      prunable: rec.prunable,
      prune_reason: rec.pruneReason,
      exists,
      dirty: false,
      dirty_reason: null,
      merged: null,
      class: '',
      old: false,
      current: index === 0 || (startedFrom !== null && realOrResolved(rec.path) === startedFrom),
      external: isExternal(rec.path, prefixes),
    };
    try {
      const known = rec.head && !/^0+$/.test(rec.head);
      w.merged = known ? isAncestor(repo, rec.head, mainRef, timeoutMs) : null;
      if (w.merged === true) w.class = 'merged';
      else if (w.merged === false) {
        const back = isAncestor(repo, mainRef, rec.head, timeoutMs);
        w.class = back === true ? 'ahead' : (back === false ? 'diverged' : '');
      }
      if (exists && !rec.bare) {
        const status = git(rec.path, ['status', '--porcelain', '--untracked-files=normal'], timeoutMs);
        if (status.status !== 0) { w.dirty = true; w.dirty_reason = 'status_failed'; }
        else if (status.stdout.trim() !== '') { w.dirty = true; w.dirty_reason = 'changes'; }
      }
    } catch (e) {
      if (!(e instanceof GitTimeout)) throw e;
      return { ...w, decision: 'keep', reason: 'git_timeout', skipped: 'git_timeout' };
    }
    w.old = exists ? isOld(rec.path, minAgeDays, now) : false;
    return { ...w, ...decide(w) };
  });
  return { ...base, worktrees };
}

/** Counts of decisions over a list of repository reports. */
export function summarizeReports(reports) {
  const summary = { keep: 0, prune: 0, sweep: 0, repositories: reports.length, skipped: 0, skipped_worktrees: 0 };
  for (const r of reports) {
    if (r.skipped) summary.skipped += 1;
    for (const w of r.worktrees) {
      summary[w.decision] += 1;
      if (w.skipped) summary.skipped_worktrees += 1;
    }
  }
  return summary;
}

function flagsOf(w) {
  const flags = [];
  if (w.current) flags.push('current');
  if (w.external) flags.push('external');
  if (w.locked) flags.push('locked');
  if (w.dirty) flags.push(w.dirty_reason === 'status_failed' ? 'dirty(status_failed)' : 'dirty');
  if (w.old) flags.push('old');
  if (!w.exists) flags.push('missing');
  if (w.prunable) flags.push('prunable');
  if (w.skipped) flags.push(`skipped(${w.skipped})`);
  return flags.join(',') || '-';
}

export function textReport(reports, summary) {
  const lines = [];
  for (const r of reports) {
    if (r.skipped) {
      lines.push(`== ${r.repo}: skipped (${r.skipped}): ${r.hint}`);
      continue;
    }
    lines.push(`== ${r.repo} (main branch: ${r.mainBranch})`);
    lines.push('decision | reason | branch | class | flags | path');
    for (const w of r.worktrees) {
      lines.push([w.decision, w.reason, w.branch || (w.detached ? '(detached)' : '-'), w.class || '-', flagsOf(w), w.path].join(' | '));
    }
  }
  const skippedWorktrees = summary.skipped_worktrees > 0 ? `, skipped_worktrees=${summary.skipped_worktrees}` : '';
  lines.push(`summary: keep=${summary.keep} prune=${summary.prune} sweep=${summary.sweep}, repositories=${summary.repositories}, skipped=${summary.skipped}${skippedWorktrees}`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const opts = { repos: [], reposFile: null, mainBranch: 'main', minAgeDays: 0, exclude: [], gitTimeoutSeconds: DEFAULT_GIT_TIMEOUT_SECONDS, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${a}`);
      return v;
    };
    if (a === '--repo') opts.repos.push(value());
    else if (a === '--repos-file') opts.reposFile = value();
    else if (a === '--main-branch') opts.mainBranch = value();
    else if (a === '--min-age-days') {
      const v = value();
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new UsageError(`invalid value for --min-age-days: ${v}`);
      opts.minAgeDays = n;
    } else if (a === '--git-timeout') {
      const v = value();
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n <= 0) throw new UsageError(`invalid value for --git-timeout: ${v}`);
      opts.gitTimeoutSeconds = n;
    } else if (a === '--exclude') opts.exclude.push(value());
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new UsageError(`unknown option: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  const repos = [];
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(USAGE); return; }
    repos.push(...opts.repos.map((p) => resolve(p)));
    if (opts.reposFile) {
      if (!existsSync(opts.reposFile)) throw new UsageError(`missing repository list file: ${opts.reposFile}`);
      repos.push(...parseRepoList(readFileSync(opts.reposFile, 'utf8')));
    }
    if (!repos.length) repos.push(process.cwd());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const unique = [...new Set(repos)];
  const reports = unique.map((repo) => reportRepo(repo, { mainBranch: opts.mainBranch, minAgeDays: opts.minAgeDays, exclude: opts.exclude, gitTimeoutSeconds: opts.gitTimeoutSeconds }));
  const summary = summarizeReports(reports);
  if (opts.json) console.log(JSON.stringify({ repositories: reports, summary }, null, 2));
  else console.log(textReport(reports, summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
