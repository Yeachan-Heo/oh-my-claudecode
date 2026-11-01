#!/usr/bin/env node

import { hardenWindowsExeSearch } from '../../../scripts/lib/windows-search.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveOmcStateRoot } from '../../../scripts/lib/state-root.mjs';

hardenWindowsExeSearch();

const DEFAULT_TOPIC_SLUG = 'default';
const TOPICS_DIR = 'topics';
const SESSIONS_DIR = 'sessions';

function slugify(value) {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s_-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_TOPIC_SLUG;
}

function parseArgs(argv) {
  const result = {
    projectRoot: process.cwd(),
    topic: '',
    slug: '',
    sessionId: '',
    format: 'json',
    ensureDirs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--project-root' && next) {
      result.projectRoot = next;
      index += 1;
    } else if (arg.startsWith('--project-root=')) {
      result.projectRoot = arg.slice('--project-root='.length);
    } else if (arg === '--topic' && next) {
      result.topic = next;
      index += 1;
    } else if (arg.startsWith('--topic=')) {
      result.topic = arg.slice('--topic='.length);
    } else if (arg === '--slug' && next) {
      result.slug = next;
      index += 1;
    } else if (arg.startsWith('--slug=')) {
      result.slug = arg.slice('--slug='.length);
    } else if (arg === '--session-id' && next) {
      result.sessionId = next;
      index += 1;
    } else if (arg.startsWith('--session-id=')) {
      result.sessionId = arg.slice('--session-id='.length);
    } else if (arg === '--format' && next) {
      result.format = next;
      index += 1;
    } else if (arg.startsWith('--format=')) {
      result.format = arg.slice('--format='.length);
    } else if (arg === '--ensure-dirs') {
      result.ensureDirs = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['json', 'shell'].includes(result.format)) {
    throw new Error(`Unsupported format: ${result.format}`);
  }

  return result;
}

function hasLegacyLayout(baseRoot) {
  return existsSync(join(baseRoot, 'config', 'settings.json'))
    || existsSync(join(baseRoot, 'state', 'agent-settings.json'));
}

function buildPaths(root, projectRoot, topicSlug, scopeMode, baseRoot) {
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const trackingDir = join(root, 'tracking');
  const paths = {
    project_root: projectRoot,
    base_root: baseRoot,
    topic_slug: topicSlug,
    scope_mode: scopeMode,
    root,
    config_dir: configDir,
    state_dir: stateDir,
    plans_dir: join(root, 'plans'),
    tracking_dir: trackingDir,
    settings_path: join(configDir, 'settings.json'),
    goal_path: join(configDir, 'goal.md'),
    harness_path: join(configDir, 'harness.md'),
    idea_path: join(configDir, 'idea.md'),
    agent_settings_path: join(stateDir, 'agent-settings.json'),
    iteration_state_path: join(stateDir, 'iteration_state.json'),
    research_briefs_dir: join(stateDir, 'research_briefs'),
    iteration_history_dir: join(stateDir, 'iteration_history'),
    merge_reports_dir: join(stateDir, 'merge_reports'),
    plan_archive_dir: join(stateDir, 'plan_archive'),
    raw_data_path: join(trackingDir, 'raw_data.json'),
    baseline_path: join(trackingDir, 'baseline.json'),
    events_path: join(trackingDir, 'events.json'),
    progress_path: join(trackingDir, 'progress.png'),
  };
  return paths;
}

function ensureDirs(paths) {
  for (const dirPath of [
    paths.config_dir,
    paths.state_dir,
    paths.plans_dir,
    paths.tracking_dir,
    paths.research_briefs_dir,
    paths.iteration_history_dir,
    paths.merge_reports_dir,
    paths.plan_archive_dir,
  ]) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export async function resolveSelfImprovePaths({ projectRoot = process.cwd(), topic = '', slug = '', sessionId = '' } = {}) {
  const resolvedProjectRoot = resolve(projectRoot);
  const omcRoot = await resolveOmcStateRoot(resolvedProjectRoot);
  const baseRoot = join(omcRoot, 'self-improve');
  const explicitSlug = slugify(slug || topic);
  const legacyLayout = hasLegacyLayout(baseRoot);
  const shouldUseLegacyRoot = !slug && !topic && legacyLayout;
  const topicSlug = shouldUseLegacyRoot ? DEFAULT_TOPIC_SLUG : explicitSlug;

  // When a sessionId is provided, scope beneath topics/<slug>/sessions/<sid>/
  // so concurrent runs sharing the same topic slug don't collide.
  // Falls back to OMC_SESSION_ID env var when explicit arg is absent.
  // Legacy layout (no topic/slug supplied, flat .omc/self-improve/ exists) is
  // preserved as-is — session scoping only applies to the topic-scoped layout.
  const rawSessionId = sessionId && sessionId.trim()
    ? sessionId.trim()
    : (process.env.OMC_SESSION_ID && process.env.OMC_SESSION_ID.trim() ? process.env.OMC_SESSION_ID.trim() : '');
  const effectiveSessionId = shouldUseLegacyRoot ? '' : rawSessionId;
  const root = shouldUseLegacyRoot
    ? baseRoot
    : effectiveSessionId
      ? join(baseRoot, TOPICS_DIR, topicSlug, SESSIONS_DIR, effectiveSessionId)
      : join(baseRoot, TOPICS_DIR, topicSlug);
  const scopeMode = shouldUseLegacyRoot
    ? 'legacy-flat-root'
    : effectiveSessionId
      ? 'session-scoped'
      : (slug || topic ? 'topic-scoped' : 'default-scoped');

  return { ...buildPaths(root, resolvedProjectRoot, topicSlug, scopeMode, baseRoot), session_id: effectiveSessionId || null };
}

function renderShell(paths) {
  return Object.entries(paths)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node resolve-paths.mjs [--project-root PATH] [--topic TEXT | --slug SLUG] [--session-id SID] [--ensure-dirs] [--format json|shell]',
      '',
      'Resolves self-improve artifact paths.',
      '- New runs default to .omc/self-improve/topics/<topic-slug>/',
      '- Pass --session-id to isolate parallel runs: .omc/self-improve/topics/<slug>/sessions/<sid>/',
      '- Legacy flat .omc/self-improve/ is preserved only when no topic/slug is supplied and a flat layout already exists',
      '',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const paths = await resolveSelfImprovePaths({
    projectRoot: args.projectRoot,
    topic: args.topic,
    slug: args.slug,
    sessionId: args.sessionId,
  });

  if (args.ensureDirs) {
    ensureDirs(paths);
  }

  if (args.format === 'shell') {
    process.stdout.write(`${renderShell(paths)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
