import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

export const PACKAGE_ROOT = process.cwd();
export const HOOKS_JSON_PATH = join(PACKAGE_ROOT, 'hooks', 'hooks.json');
export const PLUGIN_JSON_PATH = join(
  PACKAGE_ROOT,
  '.claude-plugin',
  'plugin.json',
);
export const MCP_JSON_PATH = join(PACKAGE_ROOT, '.mcp.json');

const SCRIPTS_ROOT = join(PACKAGE_ROOT, 'scripts');
const LOCAL_IMPORT_RE =
  /(?:import\s+(?:[^'"()]+?\s+from\s+)?|import\s*\(|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+|require\s*\()\s*['"](\.[^'"]+)['"]/g;
const PLUGIN_SCRIPT_RE = /"\$CLAUDE_PLUGIN_ROOT"\/(scripts\/[^\s"]+)/g;

type HookCommandConfig = {
  command?: string;
};

type HooksJson = {
  hooks?: Record<
    string,
    Array<{
      hooks?: HookCommandConfig[];
    }>
  >;
};

export type McpServerConfig = {
  command?: unknown;
  args?: unknown;
};

export type McpJson = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type PluginJson = {
  hooks?: unknown;
  mcpServers?: unknown;
};

export function readMcpServersFromPath(
  filePath: string,
): Record<string, McpServerConfig> {
  const mcpJson = JSON.parse(readFileSync(filePath, 'utf-8')) as McpJson;
  return mcpJson.mcpServers ?? {};
}

export function readPluginMcpServers(): Record<string, McpServerConfig> {
  return readMcpServersFromPath(MCP_JSON_PATH);
}

export function referencesStandardHooksManifest(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.replace(/\\/g, '/');
    return (
      normalized === './hooks/hooks.json' || normalized === 'hooks/hooks.json'
    );
  }

  if (Array.isArray(value)) {
    return value.some(referencesStandardHooksManifest);
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some(referencesStandardHooksManifest);
  }

  return false;
}

export function referencesRootMcpConfig(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.replace(/\\/g, '/');
    return normalized === './.mcp.json' || normalized === '.mcp.json';
  }

  if (Array.isArray(value)) {
    return value.some(referencesRootMcpConfig);
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some(referencesRootMcpConfig);
  }

  return false;
}

function listHookScriptEntries(): string[] {
  const hooksJson = JSON.parse(
    readFileSync(HOOKS_JSON_PATH, 'utf-8'),
  ) as HooksJson;
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

function resolveRelativeScriptImport(
  fromFile: string,
  specifier: string,
): string | null {
  const resolved = normalize(join(dirname(fromFile), specifier));
  if (
    resolved !== SCRIPTS_ROOT &&
    !resolved.startsWith(`${SCRIPTS_ROOT}${sep}`)
  ) {
    return null;
  }

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
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const fromRelPath = relative(PACKAGE_ROOT, fromFile).replace(/\\/g, '/');
  throw new Error(
    `Required local hook dependency is missing: ${specifier} imported from ${fromRelPath}`,
  );
}

function collectRequiredScriptFiles(
  entryRelPath: string,
  collected = new Set<string>(),
): Set<string> {
  const absolutePath = join(PACKAGE_ROOT, entryRelPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required hook file is missing in repo: ${entryRelPath}`);
  }

  const normalizedRel = relative(PACKAGE_ROOT, absolutePath).replace(
    /\\/g,
    '/',
  );
  if (collected.has(normalizedRel)) {
    return collected;
  }
  collected.add(normalizedRel);

  const content = readFileSync(absolutePath, 'utf-8');
  for (const match of content.matchAll(LOCAL_IMPORT_RE)) {
    const resolved = resolveRelativeScriptImport(absolutePath, match[1]);
    if (resolved) {
      collectRequiredScriptFiles(
        relative(PACKAGE_ROOT, resolved).replace(/\\/g, '/'),
        collected,
      );
    }
  }

  return collected;
}

function listTemplateHookLibFiles(): string[] {
  const templatesLibDir = join(PACKAGE_ROOT, 'templates', 'hooks', 'lib');
  return readdirSync(templatesLibDir)
    .filter((filename) => statSync(join(templatesLibDir, filename)).isFile())
    .map((filename) => `templates/hooks/lib/${filename}`)
    .sort();
}

export function listSourceControlledPackageFiles(): string[] {
  const requiredFiles = new Set<string>([
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'commands/omc-setup.md',
    'hooks/hooks.json',
  ]);

  for (const entryRelPath of listHookScriptEntries()) {
    for (const file of collectRequiredScriptFiles(entryRelPath)) {
      requiredFiles.add(file);
    }
  }

  for (const file of listTemplateHookLibFiles()) {
    requiredFiles.add(file);
  }

  return [...requiredFiles].sort();
}
