import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { getGlobalOmcConfigPath, getGlobalOmcConfigCandidates, getGlobalOmcStatePath, getGlobalOmcStateCandidates, } from '../utils/paths.js';
const MANAGED_START = '# BEGIN OMC MANAGED MCP REGISTRY';
const MANAGED_END = '# END OMC MANAGED MCP REGISTRY';
export function getUnifiedMcpRegistryPath() {
    return process.env.OMC_MCP_REGISTRY_PATH?.trim() || getGlobalOmcConfigPath('mcp-registry.json');
}
function getUnifiedMcpRegistryStatePath() {
    return getGlobalOmcStatePath('mcp-registry-state.json');
}
function getUnifiedMcpRegistryPathCandidates() {
    if (process.env.OMC_MCP_REGISTRY_PATH?.trim()) {
        return [process.env.OMC_MCP_REGISTRY_PATH.trim()];
    }
    return getGlobalOmcConfigCandidates('mcp-registry.json');
}
function getUnifiedMcpRegistryStatePathCandidates() {
    return getGlobalOmcStateCandidates('mcp-registry-state.json');
}
export function getClaudeMcpConfigPath() {
    if (process.env.CLAUDE_MCP_CONFIG_PATH?.trim()) {
        return process.env.CLAUDE_MCP_CONFIG_PATH.trim();
    }
    return join(dirname(getClaudeConfigDir()), '.claude.json');
}
export function getCodexConfigPath() {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    return join(codexHome, 'config.toml');
}
function isStringRecord(value) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.values(value).every(item => typeof item === 'string');
}
function normalizeRegistryEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const raw = value;
    const command = typeof raw.command === 'string' && raw.command.trim().length > 0
        ? raw.command.trim()
        : undefined;
    const url = typeof raw.url === 'string' && raw.url.trim().length > 0
        ? raw.url.trim()
        : undefined;
    if (!command && !url) {
        return null;
    }
    const args = Array.isArray(raw.args) && raw.args.every(item => typeof item === 'string')
        ? [...raw.args]
        : undefined;
    const env = isStringRecord(raw.env) ? { ...raw.env } : undefined;
    const timeout = typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0
        ? raw.timeout
        : undefined;
    return {
        ...(command ? { command } : {}),
        ...(args && args.length > 0 ? { args } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
        ...(url ? { url } : {}),
        ...(timeout ? { timeout } : {}),
    };
}
function normalizeRegistry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const entries = {};
    for (const [name, entry] of Object.entries(value)) {
        const trimmedName = name.trim();
        if (!trimmedName)
            continue;
        const normalized = normalizeRegistryEntry(entry);
        if (normalized) {
            entries[trimmedName] = normalized;
        }
    }
    return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
}
export function extractClaudeMcpRegistry(settings) {
    return normalizeRegistry(settings.mcpServers);
}
function loadRegistryFromDisk(path) {
    try {
        return normalizeRegistry(JSON.parse(readFileSync(path, 'utf-8')));
    }
    catch {
        return {};
    }
}
function ensureParentDir(path) {
    const parent = dirname(path);
    if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
    }
}
function readManagedServerNames() {
    for (const statePath of getUnifiedMcpRegistryStatePathCandidates()) {
        if (!existsSync(statePath)) {
            continue;
        }
        try {
            const state = JSON.parse(readFileSync(statePath, 'utf-8'));
            return Array.isArray(state.managedServers)
                ? state.managedServers.filter((item) => typeof item === 'string').sort((a, b) => a.localeCompare(b))
                : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
function writeManagedServerNames(serverNames) {
    const statePath = getUnifiedMcpRegistryStatePath();
    ensureParentDir(statePath);
    writeFileSync(statePath, JSON.stringify({ managedServers: [...serverNames].sort((a, b) => a.localeCompare(b)) }, null, 2));
}
function bootstrapRegistryFromClaude(settings, registryPath) {
    const registry = extractClaudeMcpRegistry(settings);
    if (Object.keys(registry).length === 0) {
        return {};
    }
    ensureParentDir(registryPath);
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    return registry;
}
function loadOrBootstrapRegistry(settings) {
    for (const registryPath of getUnifiedMcpRegistryPathCandidates()) {
        if (existsSync(registryPath)) {
            return {
                registry: loadRegistryFromDisk(registryPath),
                registryExists: true,
                bootstrappedFromClaude: false,
            };
        }
    }
    const registryPath = getUnifiedMcpRegistryPath();
    const registry = bootstrapRegistryFromClaude(settings, registryPath);
    return {
        registry,
        registryExists: Object.keys(registry).length > 0,
        bootstrappedFromClaude: Object.keys(registry).length > 0,
    };
}
function entriesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export function applyRegistryToClaudeSettings(settings) {
    const nextSettings = { ...settings };
    const changed = Object.prototype.hasOwnProperty.call(nextSettings, 'mcpServers');
    delete nextSettings.mcpServers;
    return {
        settings: nextSettings,
        changed,
    };
}
function syncClaudeMcpConfig(existingClaudeConfig, registry, managedServerNames = [], legacySettingsServers = {}) {
    const existingServers = extractClaudeMcpRegistry(existingClaudeConfig);
    const nextServers = { ...legacySettingsServers, ...existingServers };
    for (const managedName of managedServerNames) {
        delete nextServers[managedName];
    }
    for (const [name, entry] of Object.entries(registry)) {
        nextServers[name] = entry;
    }
    const nextClaudeConfig = { ...existingClaudeConfig };
    if (Object.keys(nextServers).length === 0) {
        delete nextClaudeConfig.mcpServers;
    }
    else {
        nextClaudeConfig.mcpServers = nextServers;
    }
    return {
        claudeConfig: nextClaudeConfig,
        changed: !entriesEqual(existingClaudeConfig, nextClaudeConfig),
    };
}
function escapeTomlString(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}
function unescapeTomlString(value) {
    return value
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}
function renderTomlString(value) {
    return `"${escapeTomlString(value)}"`;
}
function parseTomlQuotedString(value) {
    const match = value.trim().match(/^"((?:\\.|[^"\\])*)"$/);
    return match ? unescapeTomlString(match[1]) : undefined;
}
function renderTomlStringArray(values) {
    return `[${values.map(renderTomlString).join(', ')}]`;
}
function parseTomlStringArray(value) {
    try {
        const parsed = JSON.parse(value.trim());
        return Array.isArray(parsed) && parsed.every(item => typeof item === 'string')
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
function renderTomlEnvTable(env) {
    const entries = Object.entries(env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key} = ${renderTomlString(value)}`);
    return `{ ${entries.join(', ')} }`;
}
function parseTomlEnvTable(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    const env = {};
    const inner = trimmed.slice(1, -1);
    const entryPattern = /([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = entryPattern.exec(inner)) !== null) {
        env[match[1]] = unescapeTomlString(match[2]);
    }
    return Object.keys(env).length > 0 ? env : undefined;
}
function renderCodexServerBlock(name, entry) {
    const lines = [`[mcp_servers.${name}]`];
    if (entry.command) {
        lines.push(`command = ${renderTomlString(entry.command)}`);
    }
    if (entry.args && entry.args.length > 0) {
        lines.push(`args = ${renderTomlStringArray(entry.args)}`);
    }
    if (entry.url) {
        lines.push(`url = ${renderTomlString(entry.url)}`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
        lines.push(`env = ${renderTomlEnvTable(entry.env)}`);
    }
    if (entry.timeout) {
        lines.push(`startup_timeout_sec = ${entry.timeout}`);
    }
    return lines.join('\n');
}
function stripManagedCodexBlock(content) {
    const managedBlockPattern = new RegExp(`${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
    return content.replace(managedBlockPattern, '').trimEnd();
}
export function renderManagedCodexMcpBlock(registry) {
    const names = Object.keys(registry);
    if (names.length === 0) {
        return '';
    }
    const blocks = names.map(name => renderCodexServerBlock(name, registry[name]));
    return [MANAGED_START, '', ...blocks.flatMap((block, index) => index === 0 ? [block] : ['', block]), '', MANAGED_END].join('\n');
}
export function syncCodexConfigToml(existingContent, registry) {
    const base = stripManagedCodexBlock(existingContent);
    const managedBlock = renderManagedCodexMcpBlock(registry);
    const nextContent = managedBlock
        ? `${base ? `${base}\n\n` : ''}${managedBlock}\n`
        : (base ? `${base}\n` : '');
    return {
        content: nextContent,
        changed: nextContent !== existingContent,
    };
}
function parseCodexMcpRegistryEntries(content) {
    const entries = {};
    const lines = content.split(/\r?\n/);
    let currentName = null;
    let currentEntry = {};
    const flushCurrent = () => {
        if (!currentName)
            return;
        const normalized = normalizeRegistryEntry(currentEntry);
        if (normalized) {
            entries[currentName] = normalized;
        }
        currentName = null;
        currentEntry = {};
    };
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const sectionMatch = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
        if (sectionMatch) {
            flushCurrent();
            currentName = sectionMatch[1].trim();
            currentEntry = {};
            continue;
        }
        if (!currentName) {
            continue;
        }
        const [rawKey, ...rawValueParts] = line.split('=');
        if (!rawKey || rawValueParts.length === 0) {
            continue;
        }
        const key = rawKey.trim();
        const value = rawValueParts.join('=').trim();
        if (key === 'command') {
            const parsed = parseTomlQuotedString(value);
            if (parsed)
                currentEntry.command = parsed;
        }
        else if (key === 'args') {
            const parsed = parseTomlStringArray(value);
            if (parsed)
                currentEntry.args = parsed;
        }
        else if (key === 'url') {
            const parsed = parseTomlQuotedString(value);
            if (parsed)
                currentEntry.url = parsed;
        }
        else if (key === 'env') {
            const parsed = parseTomlEnvTable(value);
            if (parsed)
                currentEntry.env = parsed;
        }
        else if (key === 'startup_timeout_sec') {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0)
                currentEntry.timeout = parsed;
        }
    }
    flushCurrent();
    return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
}
export function syncUnifiedMcpRegistryTargets(settings) {
    const registryPath = getUnifiedMcpRegistryPath();
    const claudeConfigPath = getClaudeMcpConfigPath();
    const codexConfigPath = getCodexConfigPath();
    const managedServerNames = readManagedServerNames();
    const legacyClaudeRegistry = extractClaudeMcpRegistry(settings);
    const currentClaudeConfig = readJsonObject(claudeConfigPath);
    const claudeConfigForBootstrap = Object.keys(extractClaudeMcpRegistry(currentClaudeConfig)).length > 0
        ? currentClaudeConfig
        : settings;
    const registryState = loadOrBootstrapRegistry(claudeConfigForBootstrap);
    const registry = registryState.registry;
    const serverNames = Object.keys(registry);
    const cleanedSettings = applyRegistryToClaudeSettings(settings);
    const claude = syncClaudeMcpConfig(currentClaudeConfig, registry, managedServerNames, legacyClaudeRegistry);
    if (claude.changed) {
        ensureParentDir(claudeConfigPath);
        writeFileSync(claudeConfigPath, JSON.stringify(claude.claudeConfig, null, 2));
    }
    let codexChanged = false;
    const currentCodexConfig = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, 'utf-8') : '';
    const nextCodexConfig = syncCodexConfigToml(currentCodexConfig, registry);
    if (nextCodexConfig.changed) {
        ensureParentDir(codexConfigPath);
        writeFileSync(codexConfigPath, nextCodexConfig.content);
        codexChanged = true;
    }
    if (registryState.registryExists || Object.keys(legacyClaudeRegistry).length > 0 || managedServerNames.length > 0) {
        writeManagedServerNames(serverNames);
    }
    return {
        settings: cleanedSettings.settings,
        result: {
            registryPath,
            claudeConfigPath,
            codexConfigPath,
            registryExists: registryState.registryExists,
            bootstrappedFromClaude: registryState.bootstrappedFromClaude,
            serverNames,
            claudeChanged: cleanedSettings.changed || claude.changed,
            codexChanged,
        },
    };
}
function readJsonObject(path) {
    if (!existsSync(path)) {
        return {};
    }
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw
            : {};
    }
    catch {
        return {};
    }
}
export function inspectUnifiedMcpRegistrySync() {
    const registryPath = getUnifiedMcpRegistryPath();
    const claudeConfigPath = getClaudeMcpConfigPath();
    const codexConfigPath = getCodexConfigPath();
    if (!existsSync(registryPath)) {
        return {
            registryPath,
            claudeConfigPath,
            codexConfigPath,
            registryExists: false,
            serverNames: [],
            claudeMissing: [],
            claudeMismatched: [],
            codexMissing: [],
            codexMismatched: [],
        };
    }
    const registry = loadRegistryFromDisk(registryPath);
    const serverNames = Object.keys(registry);
    const claudeSettings = readJsonObject(claudeConfigPath);
    const claudeEntries = extractClaudeMcpRegistry(claudeSettings);
    const codexEntries = existsSync(codexConfigPath)
        ? parseCodexMcpRegistryEntries(readFileSync(codexConfigPath, 'utf-8'))
        : {};
    const claudeMissing = [];
    const claudeMismatched = [];
    const codexMissing = [];
    const codexMismatched = [];
    for (const [name, entry] of Object.entries(registry)) {
        if (!claudeEntries[name]) {
            claudeMissing.push(name);
        }
        else if (!entriesEqual(claudeEntries[name], entry)) {
            claudeMismatched.push(name);
        }
        if (!codexEntries[name]) {
            codexMissing.push(name);
        }
        else if (!entriesEqual(codexEntries[name], entry)) {
            codexMismatched.push(name);
        }
    }
    return {
        registryPath,
        claudeConfigPath,
        codexConfigPath,
        registryExists: true,
        serverNames,
        claudeMissing,
        claudeMismatched,
        codexMissing,
        codexMismatched,
    };
}
//# sourceMappingURL=mcp-registry.js.map