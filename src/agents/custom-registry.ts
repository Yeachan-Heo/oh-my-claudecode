import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

import type { PluginConfig } from '../shared/types.js';
import { getConfigDir } from '../utils/paths.js';
import type {
  AgentCategory,
  AgentConfig,
  AgentCost,
  AgentPromptMetadata,
  DelegationTrigger,
} from './types.js';

const SAFE_AGENT_NAME = /^[a-z0-9-]+$/i;
const AGENT_CATEGORIES = new Set<AgentCategory>([
  'exploration',
  'specialist',
  'advisor',
  'utility',
  'orchestration',
  'planner',
  'reviewer',
]);
const AGENT_COSTS = new Set<AgentCost>(['FREE', 'CHEAP', 'EXPENSIVE']);
const DEFAULT_MAX_CUSTOM_AGENTS = 20;

type FrontmatterValue = string | string[] | Array<string | Record<string, string>> | Record<string, unknown>;
type FrontmatterObject = Record<string, FrontmatterValue>;

export interface CustomAgentDiscoveryResult {
  agents: Record<string, AgentConfig>;
  warnings: string[];
}

export function getCustomAgentDirs(config?: PluginConfig, cwd: string = process.cwd()): string[] {
  const customConfig = config?.customAgents;
  if (customConfig?.enabled === false) {
    return [];
  }

  const dirs = [
    join(getConfigDir(), 'claude-omc', 'agents'),
    ...(customConfig?.dirs ?? []).map(dir => resolve(cwd, dir)),
    join(cwd, '.omc', 'agents'),
  ];

  return [...new Set(dirs.map(dir => resolve(dir)))];
}

export function discoverCustomAgents(
  config?: PluginConfig,
  options?: {
    builtInNames?: Iterable<string>;
    cwd?: string;
    maxAgents?: number;
  },
): CustomAgentDiscoveryResult {
  const cwd = options?.cwd ?? process.cwd();
  const builtInNames = new Set(options?.builtInNames ?? []);
  const maxAgents = options?.maxAgents ?? config?.customAgents?.maxAgents ?? DEFAULT_MAX_CUSTOM_AGENTS;
  const warnings: string[] = [];
  const agents: Record<string, AgentConfig> = {};
  let acceptedCount = 0;

  for (const dir of getCustomAgentDirs(config, cwd)) {
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir)
        .filter(file => file.endsWith('.md') && file !== 'AGENTS.md')
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      warnings.push(`Could not scan custom agents directory ${dir}: ${formatError(error)}`);
      continue;
    }

    for (const file of files) {
      if (acceptedCount >= maxAgents) {
        warnings.push(`Skipping ${join(dir, file)}: customAgents.maxAgents limit (${maxAgents}) reached`);
        continue;
      }

      const filePath = join(dir, file);
      const parsed = parseCustomAgentFile(filePath);
      if (!parsed.agent) {
        warnings.push(...parsed.warnings);
        continue;
      }

      const overrideBuiltin = parsed.overrideBuiltin === true;
      if (builtInNames.has(parsed.agent.name) && !overrideBuiltin) {
        warnings.push(`Skipping ${filePath}: custom agent "${parsed.agent.name}" collides with a built-in agent`);
        continue;
      }

      const isReplacement = agents[parsed.agent.name] !== undefined;
      agents[parsed.agent.name] = parsed.agent;
      warnings.push(...parsed.warnings);
      if (!isReplacement) acceptedCount++;
    }
  }

  return { agents, warnings };
}

export function getDiscoveredCustomAgentNames(config?: PluginConfig): string[] {
  return Object.keys(discoverCustomAgents(config).agents);
}

export function loadCustomAgentPrompt(agentName: string, config?: PluginConfig): string | undefined {
  if (!SAFE_AGENT_NAME.test(agentName)) {
    return undefined;
  }

  for (const dir of getCustomAgentDirs(config).reverse()) {
    const filePath = join(dir, `${agentName}.md`);
    if (!existsSync(filePath)) continue;
    const parsed = parseCustomAgentFile(filePath);
    if (parsed.agent?.name === agentName) {
      return parsed.agent.prompt;
    }
  }

  return undefined;
}

function parseCustomAgentFile(filePath: string): {
  agent?: AgentConfig;
  overrideBuiltin?: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let content: string;

  try {
    if (!statSync(filePath).isFile()) {
      return { warnings: [`Skipping ${filePath}: not a regular file`] };
    }
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return { warnings: [`Skipping ${filePath}: ${formatError(error)}`] };
  }

  const { frontmatter, body } = parseFrontmatterObject(content);
  const fallbackName = basename(filePath, '.md');
  const name = asString(frontmatter.name) || fallbackName;
  const description = asString(frontmatter.description);
  const metadata = parseOmcMetadata(frontmatter.omc, warnings, filePath);

  const agent: AgentConfig = {
    name,
    description: description ?? '',
    prompt: body.trim(),
    model: asString(frontmatter.model),
    defaultModel: asString(frontmatter.defaultModel) ?? asString(frontmatter.model),
    tools: asStringList(frontmatter.tools),
    disallowedTools: asStringList(frontmatter.disallowedTools),
    metadata,
  };

  if (!SAFE_AGENT_NAME.test(agent.name)) {
    warnings.push(`Skipping ${filePath}: invalid custom agent name "${agent.name}"`);
    return { warnings };
  }

  const validationErrors = validateParsedAgentConfig(agent);
  if (validationErrors.length > 0) {
    warnings.push(`Skipping ${filePath}: ${validationErrors.join('; ')}`);
    return { warnings };
  }

  const omc = isRecord(frontmatter.omc) ? frontmatter.omc : undefined;
  return {
    agent,
    overrideBuiltin: asBoolean(omc?.overrideBuiltin),
    warnings,
  };
}

function validateParsedAgentConfig(config: AgentConfig): string[] {
  const errors: string[] = [];
  if (!config.name) errors.push('Agent name is required');
  if (!config.description) errors.push('Agent description is required');
  if (!config.prompt) errors.push('Agent prompt is required');
  return errors;
}

function parseFrontmatterObject(content: string): { frontmatter: FrontmatterObject; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  return {
    frontmatter: parseYamlSubset(match[1]),
    body: match[2],
  };
}

function parseYamlSubset(yaml: string): FrontmatterObject {
  const root: FrontmatterObject = {};
  const lines = yaml.replace(/\t/g, '  ').split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\s/.test(rawLine)) continue;

    const separator = rawLine.indexOf(':');
    if (separator === -1) continue;
    const key = rawLine.slice(0, separator).trim();
    const rawValue = rawLine.slice(separator + 1).trim();

    if (rawValue) {
      root[key] = parseScalarOrInlineList(rawValue);
      continue;
    }

    const block = collectIndentedBlock(lines, index + 1);
    if (block.lines.length === 0) {
      root[key] = '';
      continue;
    }

    root[key] = parseIndentedBlock(block.lines);
    index = block.endIndex - 1;
  }

  return root;
}

function collectIndentedBlock(lines: string[], startIndex: number): { lines: string[]; endIndex: number } {
  const block: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      block.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break;
    block.push(line.replace(/^\s{2}/, ''));
  }
  return { lines: block, endIndex: index };
}

function parseIndentedBlock(lines: string[]): FrontmatterValue {
  const meaningful = lines.filter(line => line.trim().length > 0);
  if (meaningful[0]?.trimStart().startsWith('- ')) {
    return parseYamlList(meaningful);
  }

  const record: Record<string, unknown> = {};
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue) {
      record[key] = parseScalarOrInlineList(rawValue);
      continue;
    }

    const block = collectIndentedBlock(lines, index + 1);
    record[key] = parseIndentedBlock(block.lines);
    index = block.endIndex - 1;
  }
  return record;
}

function parseYamlList(lines: string[]): Array<string | Record<string, string>> {
  const items: Array<string | Record<string, string>> = [];
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trimStart();
    if (!trimmed.startsWith('- ')) continue;
    const value = trimmed.slice(2).trim();

    if (!value.includes(':')) {
      items.push(stripOptionalQuotes(value));
      continue;
    }

    const item: Record<string, string> = {};
    const firstSeparator = value.indexOf(':');
    item[value.slice(0, firstSeparator).trim()] = stripOptionalQuotes(value.slice(firstSeparator + 1));

    for (let next = index + 1; next < lines.length; next++) {
      const continuation = lines[next];
      if (!/^\s{2,}\S/.test(continuation)) break;
      const separator = continuation.indexOf(':');
      if (separator !== -1) {
        item[continuation.slice(0, separator).trim()] = stripOptionalQuotes(continuation.slice(separator + 1));
        index = next;
      }
    }

    items.push(item);
  }
  return items;
}

function parseScalarOrInlineList(value: string): string | string[] {
  const trimmed = stripOptionalQuotes(value);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(item => stripOptionalQuotes(item)).filter(Boolean);
  }
  if (trimmed.includes(',') && /^[A-Za-z0-9_, -]+$/.test(trimmed)) {
    return trimmed.split(',').map(item => stripOptionalQuotes(item)).filter(Boolean);
  }
  return trimmed;
}

function parseOmcMetadata(value: FrontmatterValue | undefined, warnings: string[], filePath: string): AgentPromptMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`Ignoring omc metadata in ${filePath}: expected an object`);
    return undefined;
  }

  const category = asString(value.category);
  const cost = asString(value.cost);
  const hasPromptMetadata = category !== undefined ||
    cost !== undefined ||
    value.promptAlias !== undefined ||
    value.triggers !== undefined ||
    value.useWhen !== undefined ||
    value.avoidWhen !== undefined ||
    value.promptDescription !== undefined ||
    value.tools !== undefined;
  if (!hasPromptMetadata) {
    return undefined;
  }

  if (!category || !AGENT_CATEGORIES.has(category as AgentCategory)) {
    warnings.push(`Ignoring omc metadata in ${filePath}: invalid category "${String(category)}"`);
    return undefined;
  }
  if (!cost || !AGENT_COSTS.has(cost as AgentCost)) {
    warnings.push(`Ignoring omc metadata in ${filePath}: invalid cost "${String(cost)}"`);
    return undefined;
  }

  return {
    category: category as AgentCategory,
    cost: cost as AgentCost,
    promptAlias: asString(value.promptAlias),
    triggers: parseTriggers(value.triggers).slice(0, 3),
    useWhen: asStringList(value.useWhen),
    avoidWhen: asStringList(value.avoidWhen),
    promptDescription: asString(value.promptDescription),
    tools: asStringList(value.tools),
  };
}

function parseTriggers(value: unknown): DelegationTrigger[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const domain = asString(item.domain);
    const trigger = asString(item.trigger);
    return domain && trigger ? [{ domain, trigger }] : [];
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return items.length > 0 ? items : undefined;
  }
  const single = asString(value);
  return single ? [single] : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
