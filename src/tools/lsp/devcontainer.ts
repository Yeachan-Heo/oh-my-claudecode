import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join, relative, sep, dirname, parse, basename } from 'path';
import { posix } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseJsonc } from '../../utils/jsonc.js';

const DEVCONTAINER_PRIMARY_CONFIG_PATH = ['.devcontainer', 'devcontainer.json'] as const;
const DEVCONTAINER_DOTFILE_NAME = '.devcontainer.json' as const;
const DEVCONTAINER_CONFIG_DIR = '.devcontainer' as const;
const DEVCONTAINER_LOCAL_FOLDER_LABELS = [
  'devcontainer.local_folder',
  'vsch.local.folder'
] as const;
const DEVCONTAINER_CONFIG_FILE_LABELS = [
  'devcontainer.config_file',
  'vsch.config.file'
] as const;

interface DockerInspectMount {
  Source?: string;
  Destination?: string;
  Type?: string;
}

interface DockerInspectState {
  Running?: boolean;
}

interface DockerInspectConfig {
  Labels?: Record<string, string>;
}

interface DockerInspectResult {
  Id?: string;
  Config?: DockerInspectConfig;
  Mounts?: DockerInspectMount[];
  State?: DockerInspectState;
}

interface DevContainerJson {
  workspaceFolder?: string;
}

export interface DevContainerContext {
  containerId: string;
  hostWorkspaceRoot: string;
  containerWorkspaceRoot: string;
  configFilePath?: string;
}

export function resolveDevContainerContext(workspaceRoot: string): DevContainerContext | null {
  const hostWorkspaceRoot = resolve(workspaceRoot);
  const configFilePath = resolveDevContainerConfigPath(hostWorkspaceRoot);
  const config = readDevContainerConfig(configFilePath);
  const overrideContainerId = process.env.OMC_LSP_CONTAINER_ID?.trim();

  if (overrideContainerId) {
    return buildContextFromContainer(overrideContainerId, hostWorkspaceRoot, configFilePath, config);
  }

  const containerIds = listRunningContainerIds();
  if (containerIds.length === 0) {
    return null;
  }

  let bestMatch: { score: number; context: DevContainerContext } | null = null;

  for (const containerId of containerIds) {
    const inspect = inspectContainer(containerId);
    if (!inspect) {
      continue;
    }

    const score = scoreContainerMatch(inspect, hostWorkspaceRoot, configFilePath);
    if (score <= 0) {
      continue;
    }

    const context = buildContextFromInspect(inspect, hostWorkspaceRoot, configFilePath, config);
    if (!context) {
      continue;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { score, context };
    }
  }

  return bestMatch?.context ?? null;
}

export function hostPathToContainerPath(filePath: string, context: DevContainerContext | null | undefined): string {
  if (!context) {
    return resolve(filePath);
  }

  const resolvedPath = resolve(filePath);
  const relativePath = relative(context.hostWorkspaceRoot, resolvedPath);
  if (relativePath === '') {
    return context.containerWorkspaceRoot;
  }
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    return resolvedPath;
  }

  const posixRelativePath = relativePath.split(sep).join('/');
  return posix.join(context.containerWorkspaceRoot, posixRelativePath);
}

export function containerPathToHostPath(filePath: string, context: DevContainerContext | null | undefined): string {
  if (!context) {
    return resolve(filePath);
  }

  const normalizedContainerPath = normalizeContainerPath(filePath);
  const relativePath = posix.relative(context.containerWorkspaceRoot, normalizedContainerPath);
  if (relativePath === '') {
    return context.hostWorkspaceRoot;
  }
  if (relativePath.startsWith('..') || relativePath.includes('../')) {
    return normalizedContainerPath;
  }

  return resolve(context.hostWorkspaceRoot, ...relativePath.split('/'));
}

export function hostUriToContainerUri(uri: string, context: DevContainerContext | null | undefined): string {
  if (!context || !uri.startsWith('file://')) {
    return uri;
  }

  return containerPathToFileUri(hostPathToContainerPath(fileURLToPath(uri), context));
}

export function containerUriToHostUri(uri: string, context: DevContainerContext | null | undefined): string {
  if (!context || !uri.startsWith('file://')) {
    return uri;
  }

  return pathToFileURL(containerPathToHostPath(fileURLToPath(uri), context)).href;
}

function resolveDevContainerConfigPath(workspaceRoot: string): string | undefined {
  let dir = workspaceRoot;

  while (true) {
    const configFilePath = resolveDevContainerConfigPathAt(dir);
    if (configFilePath) {
      return configFilePath;
    }

    const parsed = parse(dir);
    if (parsed.root === dir) {
      return undefined;
    }

    dir = dirname(dir);
  }
}

function resolveDevContainerConfigPathAt(dir: string): string | undefined {
  const primaryConfigPath = join(dir, ...DEVCONTAINER_PRIMARY_CONFIG_PATH);
  if (existsSync(primaryConfigPath)) {
    return primaryConfigPath;
  }

  const dotfileConfigPath = join(dir, DEVCONTAINER_DOTFILE_NAME);
  if (existsSync(dotfileConfigPath)) {
    return dotfileConfigPath;
  }

  const devcontainerDir = join(dir, DEVCONTAINER_CONFIG_DIR);
  if (!existsSync(devcontainerDir)) {
    return undefined;
  }

  const nestedConfigPaths = readdirSync(devcontainerDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(devcontainerDir, entry.name, 'devcontainer.json'))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right));

  return nestedConfigPaths[0];
}

function deriveHostDevContainerRoot(configFilePath: string): string {
  const resolvedConfigPath = resolve(configFilePath);
  if (basename(resolvedConfigPath) === DEVCONTAINER_DOTFILE_NAME) {
    return dirname(resolvedConfigPath);
  }

  const configParentDir = dirname(resolvedConfigPath);
  if (basename(configParentDir) === DEVCONTAINER_CONFIG_DIR) {
    return dirname(configParentDir);
  }

  const configGrandparentDir = dirname(configParentDir);
  if (basename(configGrandparentDir) === DEVCONTAINER_CONFIG_DIR) {
    return dirname(configGrandparentDir);
  }

  return dirname(configParentDir);
}

function readDevContainerConfig(configFilePath?: string): DevContainerJson | null {
  if (!configFilePath || !existsSync(configFilePath)) {
    return null;
  }

  try {
    const parsed = parseJsonc(readFileSync(configFilePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as DevContainerJson : null;
  } catch {
    return null;
  }
}

function listRunningContainerIds(): string[] {
  const result = runDocker(['ps', '-q']);
  if (!result || result.status !== 0) {
    return [];
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');

  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function inspectContainer(containerId: string): DockerInspectResult | null {
  const result = runDocker(['inspect', containerId]);
  if (!result || result.status !== 0) {
    return null;
  }

  try {
    const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
    const parsed = JSON.parse(stdout) as DockerInspectResult[];
    const inspect = parsed[0];
    if (!inspect?.Id || inspect.State?.Running === false) {
      return null;
    }
    return inspect;
  } catch {
    return null;
  }
}

function buildContextFromContainer(
  containerId: string,
  hostWorkspaceRoot: string,
  configFilePath?: string,
  config?: DevContainerJson | null
): DevContainerContext | null {
  const inspect = inspectContainer(containerId);
  if (!inspect) {
    return null;
  }

  return buildContextFromInspect(inspect, hostWorkspaceRoot, configFilePath, config);
}

function buildContextFromInspect(
  inspect: DockerInspectResult,
  hostWorkspaceRoot: string,
  configFilePath?: string,
  config?: DevContainerJson | null
): DevContainerContext | null {
  const containerWorkspaceRoot = deriveContainerWorkspaceRoot(inspect, hostWorkspaceRoot, config?.workspaceFolder);
  if (!containerWorkspaceRoot || !inspect.Id) {
    return null;
  }

  return {
    containerId: inspect.Id,
    hostWorkspaceRoot,
    containerWorkspaceRoot,
    configFilePath
  };
}

function deriveContainerWorkspaceRoot(
  inspect: DockerInspectResult,
  hostWorkspaceRoot: string,
  workspaceFolder?: string
): string | null {
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];

  let bestMountMatch: { sourceLength: number; destination: string } | null = null;
  for (const mount of mounts) {
    const source = mount.Source ? resolve(mount.Source) : '';
    const destination = mount.Destination ? normalizeContainerPath(mount.Destination) : '';
    if (!source || !destination) {
      continue;
    }

    if (source === hostWorkspaceRoot) {
      return destination;
    }

    const relativePath = relative(source, hostWorkspaceRoot);
    if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      continue;
    }

    if (!bestMountMatch || source.length > bestMountMatch.sourceLength) {
      bestMountMatch = {
        sourceLength: source.length,
        destination: posix.join(destination, relativePath.split(sep).join('/'))
      };
    }
  }

  if (bestMountMatch) {
    return bestMountMatch.destination;
  }

  return workspaceFolder ? normalizeContainerPath(workspaceFolder) : null;
}

function scoreContainerMatch(
  inspect: DockerInspectResult,
  hostWorkspaceRoot: string,
  configFilePath?: string
): number {
  const labels = inspect.Config?.Labels ?? {};
  let score = 0;
  let hasDevContainerLabelMatch = false;
  const expectedLocalFolder = configFilePath
    ? deriveHostDevContainerRoot(configFilePath)
    : resolve(hostWorkspaceRoot);

  for (const label of DEVCONTAINER_LOCAL_FOLDER_LABELS) {
    if (labels[label] && resolve(labels[label]) === expectedLocalFolder) {
      score += 4;
      hasDevContainerLabelMatch = true;
    }
  }

  if (configFilePath) {
    for (const label of DEVCONTAINER_CONFIG_FILE_LABELS) {
      if (labels[label] && resolve(labels[label]) === configFilePath) {
        score += 3;
        hasDevContainerLabelMatch = true;
      }
    }
  }

  const mappedWorkspaceRoot = deriveContainerWorkspaceRoot(inspect, hostWorkspaceRoot);
  if (mappedWorkspaceRoot && (Boolean(configFilePath) || hasDevContainerLabelMatch)) {
    score += 1;
  }

  return score;
}

function normalizeContainerPath(filePath: string): string {
  return posix.normalize(filePath.replace(/\\/g, '/'));
}

function containerPathToFileUri(filePath: string): string {
  const normalizedPath = normalizeContainerPath(filePath);
  const encodedPath = normalizedPath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `file://${encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`}`;
}

function runDocker(args: string[]): ReturnType<typeof spawnSync> | null {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });

  if (result.error) {
    return null;
  }

  return result;
}
