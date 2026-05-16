import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const PACKAGE_ROOT = process.cwd();
const HOOKS_JSON_PATH = join(PACKAGE_ROOT, 'hooks', 'hooks.json');
const PLUGIN_JSON_PATH = join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json');
const SCRIPTS_ROOT = join(PACKAGE_ROOT, 'scripts');

type HookCommandConfig = {
  command?: string;
};

type HooksJson = {
  hooks?: Record<string, Array<{
    hooks?: HookCommandConfig[];
  }>>;
};

type NpmPackDryRunEntry = {
  path: string;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunEntry[];
};

type PluginJson = {
  hooks?: unknown;
};

function referencesStandardHooksManifest(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.replace(/\\/g, '/');
    return normalized === './hooks/hooks.json' || normalized === 'hooks/hooks.json';
  }

  if (Array.isArray(value)) {
    return value.some(referencesStandardHooksManifest);
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some(referencesStandardHooksManifest);
  }

  return false;
}

const LOCAL_IMPORT_RE = /(?:import\s+(?:[^'"()]+?\s+from\s+)?|import\s*\(|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+|require\s*\()\s*['"](\.[^'"]+)['"]/g;
const PLUGIN_SCRIPT_RE = /"\$CLAUDE_PLUGIN_ROOT"\/(scripts\/[^\s"]+)/g;
let packedFilesCache: Set<string> | null = null;

function listHookScriptEntries(): string[] {
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8')) as HooksJson;
  const entries = new Set<string>(['scripts/run.cjs']);

  for (const eventHooks of Object.values(hooksJson.hooks ?? {})) {
    for (const matcherEntry of eventHooks) {
      for (const hook of matcherEntry.hooks ?? []) {
        const command = hook.command ?? '';
        for (const match of command.matchAll(PLUGIN_SCRIPT_RE)) {
          entries.add(match[1]);
        }
      }
    }
  }

  return [...entries].sort();
}

function resolveRelativeScriptImport(fromFile: string, specifier: string): string | null {
  const resolved = normalize(join(dirname(fromFile), specifier));
  const candidates = [
    resolved,
    `${resolved}.mjs`,
    `${resolved}.cjs`,
    `${resolved}.js`,
    join(resolved, 'index.mjs'),
    join(resolved, 'index.cjs'),
    join(resolved, 'index.js'),
  ];

  for (const candidate of candidates) {
    if (candidate.startsWith(SCRIPTS_ROOT) && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function collectRequiredScriptFiles(entryRelPath: string, collected = new Set<string>()): Set<string> {
  const absolutePath = join(PACKAGE_ROOT, entryRelPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required hook file is missing in repo: ${entryRelPath}`);
  }

  const normalizedRel = relative(PACKAGE_ROOT, absolutePath).replace(/\\/g, '/');
  if (collected.has(normalizedRel)) {
    return collected;
  }
  collected.add(normalizedRel);

  const content = readFileSync(absolutePath, 'utf-8');
  for (const match of content.matchAll(LOCAL_IMPORT_RE)) {
    const resolved = resolveRelativeScriptImport(absolutePath, match[1]);
    if (!resolved) {
      continue;
    }
    collectRequiredScriptFiles(relative(PACKAGE_ROOT, resolved).replace(/\\/g, '/'), collected);
  }

  return collected;
}

function getPackedFiles(): Set<string> {
  if (packedFilesCache) {
    return packedFilesCache;
  }

  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
  });

  const results = JSON.parse(stdout) as NpmPackDryRunResult[];
  packedFilesCache = new Set((results[0]?.files ?? []).map(file => file.path));
  return packedFilesCache;
}

describe('npm package hook surface regression', () => {
  it('does not explicitly reference the auto-loaded standard hooks manifest from plugin.json', () => {
    const pluginJson = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf-8')) as PluginJson;
    expect(referencesStandardHooksManifest(pluginJson.hooks)).toBe(false);

    const packedFiles = getPackedFiles();
    expect(packedFiles.has('.claude-plugin/plugin.json')).toBe(true);
  });

  it('packs hooks.json, hook entry scripts, and their local script dependencies', () => {
    const requiredFiles = new Set<string>(['hooks/hooks.json']);

    for (const entryRelPath of listHookScriptEntries()) {
      for (const file of collectRequiredScriptFiles(entryRelPath)) {
        requiredFiles.add(file);
      }
    }

    const packedFiles = getPackedFiles();
    expect([...requiredFiles].sort()).not.toHaveLength(0);

    const missing = [...requiredFiles].filter(file => !packedFiles.has(file)).sort();
    expect(missing).toEqual([]);
  });
});
