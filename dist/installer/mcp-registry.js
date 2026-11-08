import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { isDeepStrictEqual } from 'util';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { getGlobalOmcConfigPath, getGlobalOmcConfigCandidates, getGlobalOmcStatePath, getGlobalOmcStateCandidates, } from '../utils/paths.js';
const MANAGED_START = '# BEGIN OMC MANAGED MCP REGISTRY';
const MANAGED_END = '# END OMC MANAGED MCP REGISTRY';
const DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC = 15;
const CODEX_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
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
const RETIRED_TEAM_MCP_PATH_PATTERN = /(^|[\\/])bridge[\\/]+team-mcp\.cjs$/i;
function isRetiredTeamMcpEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const raw = value;
    const args = Array.isArray(raw.args) && raw.args.every(item => typeof item === 'string')
        ? raw.args
        : [];
    return args.some(arg => RETIRED_TEAM_MCP_PATH_PATTERN.test(arg));
}
function launcherCommandBasename(command) {
    return command.replace(/\\/g, '/').trim().split('/').pop()?.toLowerCase() ?? '';
}
function isLauncherBackedMcpCommand(command, args) {
    const base = launcherCommandBasename(command);
    if (base === 'npx' || base === 'uvx') {
        return true;
    }
    return base === 'npm' && args[0]?.toLowerCase() === 'exec';
}
function normalizeRegistryEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    if (isRetiredTeamMcpEntry(value)) {
        return null;
    }
    const raw = value;
    const command = typeof raw.command === 'string' && raw.command.trim().length > 0
        ? raw.command.trim()
        : undefined;
    const url = typeof raw.url === 'string' && raw.url.trim().length > 0
        ? raw.url.trim()
        : undefined;
    const type = typeof raw.type === 'string' && raw.type.trim().length > 0
        ? raw.type.trim()
        : undefined;
    if (!command && !url) {
        return null;
    }
    const args = Array.isArray(raw.args) && raw.args.every(item => typeof item === 'string')
        ? [...raw.args]
        : [];
    const env = isStringRecord(raw.env) ? { ...raw.env } : undefined;
    const headers = isStringRecord(raw.headers) ? { ...raw.headers } : undefined;
    const timeout = typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0
        ? raw.timeout
        : undefined;
    const effectiveTimeout = timeout ?? (command && isLauncherBackedMcpCommand(command, args) ? DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC : undefined);
    return {
        ...(command ? { command } : {}),
        ...(args.length > 0 ? { args } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(url ? { url } : {}),
        ...(type ? { type } : {}),
        ...(effectiveTimeout ? { timeout: effectiveTimeout } : {}),
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
export function stripRetiredTeamMcpServers(settings) {
    const mcpServers = settings.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
        return { settings, changed: false };
    }
    let changed = false;
    const nextServers = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
        if (isRetiredTeamMcpEntry(entry)) {
            changed = true;
            continue;
        }
        nextServers[name] = entry;
    }
    if (!changed) {
        return { settings, changed: false };
    }
    const nextSettings = { ...settings };
    if (Object.keys(nextServers).length === 0) {
        delete nextSettings.mcpServers;
    }
    else {
        nextSettings.mcpServers = nextServers;
    }
    return { settings: nextSettings, changed: true };
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
function codexEntriesEqual(codexEntry, registryEntry, typeFieldPresent) {
    if (typeFieldPresent && codexEntry.type === undefined) {
        return false;
    }
    const comparableCodexEntry = { ...codexEntry };
    const comparableRegistryEntry = { ...registryEntry };
    if (typeFieldPresent) {
        comparableCodexEntry.type = normalizeCodexMcpType(codexEntry.type);
        comparableRegistryEntry.type = normalizeCodexMcpType(registryEntry.type ?? inferCodexMcpTransportType(registryEntry));
    }
    else {
        const inferredType = inferCodexMcpTransportType(codexEntry);
        if (registryEntry.type !== undefined
            && normalizeCodexMcpType(registryEntry.type) !== inferredType) {
            return false;
        }
        delete comparableRegistryEntry.type;
    }
    return isDeepStrictEqual(comparableCodexEntry, comparableRegistryEntry);
}
function normalizeCodexMcpType(type) {
    return type === 'streamable-http' ? 'http' : type;
}
function inferCodexMcpTransportType(entry) {
    if (entry.command && !entry.url)
        return 'stdio';
    if (entry.url && !entry.command)
        return 'http';
    return undefined;
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
    // TOML basic strings (double-quoted) forbid all control chars U+0000-U+001F except tab (U+0009),
    // and also forbid U+007F (DEL).
    // Escape order: backslash first to avoid re-escaping.
    let result = value.replace(/\\/g, '\\\\');
    // Escape other special characters and control codes
    // An unpaired surrogate is not a Unicode scalar value, so TOML cannot carry it
    // either way: it has no UTF-8 encoding, and a \uXXXX escape naming a surrogate
    // is rejected outright by a conforming parser (Python's tomllib refuses the
    // whole document with "Escaped character is not a Unicode scalar value"), which
    // would make one bad value unreadable for the entire Codex config rather than
    // just for itself.
    //
    // Substitute U+FFFD, which is what the UTF-8 write produced anyway -- now
    // explicitly and with a document that still parses. A matched pair is a real
    // astral character and is left alone.
    result = result.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\uFFFD');
    result = result.replace(/["\n\r\t\b\f\0-\x07\x0b\x0e-\x1f\x7f]/g, (char) => {
        switch (char) {
            case '"':
                return '\\"';
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';
            case '\t':
                return '\\t';
            case '\b':
                return '\\b';
            case '\f':
                return '\\f';
            default: {
                // All other control chars: escape as \uXXXX
                const code = char.charCodeAt(0);
                return `\\u${code.toString(16).padStart(4, '0')}`;
            }
        }
    });
    return result;
}
function unescapeTomlString(value) {
    // Handle escape sequences in a single pass to avoid round-trip bugs:
    // - \uXXXX and \UXXXXXXXX (Unicode escapes)
    // - \" (quote), \\ (backslash), \n (newline), \r (carriage return), \t (tab), \b (backspace), \f (form feed)
    // Single pass prevents issues like C:\\users\\u0041dir being incorrectly decoded.
    return value.replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|["\\nrtbf])/g, (_, escaped) => {
        if (escaped[0] === 'U') {
            const codePoint = parseInt(escaped.slice(1), 16);
            return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
                ? String.fromCodePoint(codePoint)
                : `\\${escaped}`;
        }
        if (escaped[0] === 'u') {
            // \uXXXX: decode unicode escape
            return String.fromCharCode(parseInt(escaped.slice(1), 16));
        }
        // Single-character escapes
        switch (escaped) {
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case 'b':
                return '\b';
            case 'f':
                return '\f';
            case '"':
                return '"';
            case '\\':
                return '\\';
            default:
                return escaped;
        }
    });
}
function renderTomlString(value) {
    return `"${escapeTomlString(value)}"`;
}
function isValidTomlLiteralContent(content, allowNewlines = false) {
    // TOML literal strings permit only tab (U+0009) among control characters.
    // Multiline strings additionally permit line feed (U+000A).
    for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code <= 0x08
            || (code >= 0x0A && code <= 0x1F && !(allowNewlines && code === 0x0A))
            || code === 0x7F) {
            return false;
        }
    }
    return true;
}
function foldTomlMultilineBasicString(value) {
    let result = '';
    for (let index = 0; index < value.length;) {
        if (value[index] !== '\\') {
            result += value[index++];
            continue;
        }
        let backslashEnd = index;
        while (value[backslashEnd] === '\\')
            backslashEnd++;
        let whitespaceEnd = backslashEnd;
        while (value[whitespaceEnd] === ' ' || value[whitespaceEnd] === '\t')
            whitespaceEnd++;
        const backslashCount = backslashEnd - index;
        if (backslashCount % 2 === 1 && value[whitespaceEnd] === '\n') {
            result += '\\'.repeat(backslashCount - 1);
            index = whitespaceEnd + 1;
            while (value[index] === ' ' || value[index] === '\t' || value[index] === '\n')
                index++;
            continue;
        }
        result += '\\'.repeat(backslashCount) + value.slice(backslashEnd, whitespaceEnd);
        index = whitespaceEnd;
    }
    return result;
}
function parseTomlQuotedString(value) {
    const trimmed = value.trim();
    const multilineBasicMatch = trimmed.match(/^"""([\s\S]*?)"""\s*(?:#.*)?$/);
    if (multilineBasicMatch) {
        return unescapeTomlString(foldTomlMultilineBasicString(multilineBasicMatch[1].replace(/^\r?\n/, '')));
    }
    const multilineLiteralMatch = trimmed.match(/^'''([\s\S]*?)'''\s*(?:#.*)?$/);
    if (multilineLiteralMatch) {
        const content = multilineLiteralMatch[1].replace(/^\r?\n/, '');
        return isValidTomlLiteralContent(content, true) ? content : undefined;
    }
    const basicMatch = trimmed.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
    if (basicMatch) {
        return unescapeTomlString(basicMatch[1]);
    }
    // TOML literal string ('...'): single-line, no escape processing.
    // Reject raw CR/LF and multi-line; preserve every interior character verbatim.
    if (trimmed.startsWith("'") && !trimmed.includes('\n') && !trimmed.includes('\r')) {
        const literalMatch = trimmed.match(/^'([^']*)'\s*(?:#.*)?$/);
        if (literalMatch && isValidTomlLiteralContent(literalMatch[1])) {
            return literalMatch[1];
        }
    }
    return undefined;
}
function renderTomlStringArray(values) {
    return `[${values.map(renderTomlString).join(', ')}]`;
}
function parseTomlStringArrayFallback(value) {
    let i = 0;
    // Skip leading whitespace; require opening '['.
    while (i < value.length && (value[i] === ' ' || value[i] === '\t')) {
        i++;
    }
    if (i >= value.length || value[i] !== '[') {
        return undefined;
    }
    i++;
    const result = [];
    for (;;) {
        // Skip horizontal whitespace between tokens.
        while (i < value.length && (value[i] === ' ' || value[i] === '\t')) {
            i++;
        }
        if (i >= value.length) {
            return undefined; // Unterminated: EOF before ']'.
        }
        // Empty array.
        if (value[i] === ']' && result.length === 0) {
            i++;
            // After ']', allow only horizontal whitespace through EOF.
            while (i < value.length) {
                if (value[i] !== ' ' && value[i] !== '\t') {
                    return undefined;
                }
                i++;
            }
            return result;
        }
        // Parse a quoted string member.
        const quote = value[i];
        if (quote !== '"' && quote !== "'") {
            return undefined; // Non-string member.
        }
        let member;
        if (quote === "'") {
            // Literal string: scan to next apostrophe, no escapes.
            i++;
            const start = i;
            while (i < value.length && value[i] !== "'") {
                i++;
            }
            if (i >= value.length) {
                return undefined; // Unterminated literal.
            }
            member = value.slice(start, i);
            if (!isValidTomlLiteralContent(member)) {
                return undefined;
            }
            i++; // Consume closing apostrophe.
        }
        else {
            // Basic string: backslash-aware scan to closing quote, then JSON.parse the full token.
            i++; // Skip opening quote.
            const tokenStart = i - 1;
            while (i < value.length) {
                if (value[i] === '\\') {
                    i += 2; // Skip escaped character.
                }
                else if (value[i] === '"') {
                    break;
                }
                else {
                    i++;
                }
            }
            if (i >= value.length || value[i] !== '"') {
                return undefined; // Unterminated basic string.
            }
            i++; // Consume closing quote.
            const token = value.slice(tokenStart, i);
            try {
                const decoded = JSON.parse(token);
                if (typeof decoded !== 'string') {
                    return undefined;
                }
                member = decoded;
            }
            catch {
                return undefined;
            }
        }
        result.push(member);
        // After member: skip whitespace, require ',' or ']'.
        while (i < value.length && (value[i] === ' ' || value[i] === '\t')) {
            i++;
        }
        if (i >= value.length) {
            return undefined; // Unterminated: EOF after member.
        }
        if (value[i] === ']') {
            i++;
            // After ']', allow only horizontal whitespace through EOF.
            while (i < value.length) {
                if (value[i] !== ' ' && value[i] !== '\t') {
                    return undefined;
                }
                i++;
            }
            return result;
        }
        if (value[i] !== ',') {
            return undefined; // Missing separator.
        }
        i++; // Consume comma.
        // After comma, allow a closing ']' (TOML v1.0 trailing comma) or another quoted member.
        while (i < value.length && (value[i] === ' ' || value[i] === '\t')) {
            i++;
        }
        if (i >= value.length) {
            return undefined; // Unterminated: EOF after comma.
        }
        if (value[i] === ']') {
            i++;
            while (i < value.length) {
                if (value[i] !== ' ' && value[i] !== '\t') {
                    return undefined;
                }
                i++;
            }
            return result;
        }
        if (value[i] !== '"' && value[i] !== "'") {
            return undefined; // Missing member after comma.
        }
    }
}
function parseTomlStringArray(value) {
    const trimmed = value.trim();
    // JSON-first path: all-basic arrays use existing JSON.parse semantics.
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) && parsed.every(item => typeof item === 'string')
            ? parsed
            : undefined;
    }
    catch {
        // Fall through to the literal/mixed-array fallback.
    }
    // Reject raw CR/LF before scanning (single-line arrays only).
    if (value.includes('\n') || value.includes('\r')) {
        return undefined;
    }
    return parseTomlStringArrayFallback(value);
}
function renderTomlBareKey(key) {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : renderTomlString(key);
}
function parseTomlKey(value) {
    const trimmed = value.trim();
    if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        return trimmed;
    }
    const parsed = parseTomlQuotedString(trimmed);
    return parsed && parsed.trim().length > 0 ? parsed : undefined;
}
function parseTomlDottedKey(value) {
    const keys = [];
    let index = 0;
    const skipWhitespace = () => {
        while (value[index] === ' ' || value[index] === '\t') {
            index++;
        }
    };
    skipWhitespace();
    while (index < value.length) {
        const start = index;
        const quote = value[index];
        if (quote === '"') {
            index++;
            let closed = false;
            while (index < value.length) {
                if (value[index] === '\\') {
                    index += 2;
                }
                else if (value[index++] === '"') {
                    closed = true;
                    break;
                }
            }
            if (!closed) {
                return undefined;
            }
        }
        else if (quote === "'") {
            index++;
            while (index < value.length && value[index] !== "'") {
                index++;
            }
            if (index >= value.length) {
                return undefined;
            }
            index++;
        }
        else {
            while (index < value.length && value[index] !== '.' && value[index] !== ' ' && value[index] !== '\t') {
                index++;
            }
        }
        const key = parseTomlKey(value.slice(start, index));
        if (!key) {
            return undefined;
        }
        keys.push(key);
        skipWhitespace();
        if (index === value.length) {
            return keys;
        }
        if (value[index] !== '.') {
            return undefined;
        }
        index++;
        skipWhitespace();
        if (index === value.length) {
            return undefined;
        }
    }
    return undefined;
}
function parseTomlTableHeader(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) {
        return undefined;
    }
    let quote;
    let escaped = false;
    let closingBracket = -1;
    for (let index = 1; index < trimmed.length; index++) {
        const character = trimmed[index];
        if (quote === '"') {
            if (escaped) {
                escaped = false;
            }
            else if (character === '\\') {
                escaped = true;
            }
            else if (character === '"') {
                quote = undefined;
            }
            continue;
        }
        if (quote === "'") {
            if (character === "'") {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        }
        else if (character === ']') {
            closingBracket = index;
            break;
        }
    }
    if (closingBracket < 0 || (trimmed.slice(closingBracket + 1).trim() && !trimmed.slice(closingBracket + 1).trimStart().startsWith('#'))) {
        return undefined;
    }
    return parseTomlDottedKey(trimmed.slice(1, closingBracket));
}
function renderTomlStringMapInline(values) {
    const entries = Object.entries(values)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${renderTomlBareKey(key)} = ${renderTomlString(value)}`);
    return `{ ${entries.join(', ')} }`;
}
function renderTomlEnvTable(env) {
    return renderTomlStringMapInline(env);
}
function parseTomlEnvTable(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    const env = {};
    const inner = trimmed.slice(1, -1);
    const entryPattern = /((?:[A-Za-z0-9_-]+)|(?:"(?:\\.|[^"\\])*"))\s*=\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = entryPattern.exec(inner)) !== null) {
        const key = parseTomlKey(match[1]);
        if (key) {
            env[key] = unescapeTomlString(match[2]);
        }
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
    if (entry.type) {
        lines.push(`type = ${renderTomlString(entry.type)}`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
        lines.push(`env = ${renderTomlEnvTable(entry.env)}`);
    }
    if (entry.timeout) {
        lines.push(`startup_timeout_sec = ${entry.timeout}`);
    }
    if (entry.headers && Object.keys(entry.headers).length > 0) {
        lines.push('', `[mcp_servers.${name}.headers]`);
        for (const [key, value] of Object.entries(entry.headers).sort(([left], [right]) => left.localeCompare(right))) {
            lines.push(`${renderTomlBareKey(key)} = ${renderTomlString(value)}`);
        }
    }
    return lines.join('\n');
}
function stripManagedCodexBlock(content) {
    const managedBlockPattern = new RegExp(`${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
    return content.replace(managedBlockPattern, '').trimEnd();
}
function parseCodexMcpServerNames(content) {
    const names = new Set();
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const tableKeys = parseTomlTableHeader(line);
        if (tableKeys?.[0] === 'mcp_servers' && tableKeys.length >= 2) {
            const name = tableKeys[1];
            if (CODEX_MCP_SERVER_NAME_PATTERN.test(name)) {
                names.add(name);
            }
        }
    }
    return names;
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
    const existingServerNames = parseCodexMcpServerNames(base);
    const managedRegistry = Object.fromEntries(Object.entries(registry).filter(([name]) => (CODEX_MCP_SERVER_NAME_PATTERN.test(name) && !existingServerNames.has(name))));
    const managedBlock = renderManagedCodexMcpBlock(managedRegistry);
    const nextContent = managedBlock
        ? `${base ? `${base}\n\n` : ''}${managedBlock}\n`
        : (base ? `${base}\n` : '');
    return {
        content: nextContent,
        changed: nextContent !== existingContent,
    };
}
function hasClosingTomlMultilineString(value, delimiter) {
    let escaped = false;
    for (let index = delimiter.length; index <= value.length - delimiter.length; index++) {
        if (delimiter === '"""') {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (value[index] === '\\') {
                escaped = true;
                continue;
            }
        }
        if (value.startsWith(delimiter, index)) {
            return true;
        }
    }
    return false;
}
function parseCodexMcpRegistryEntries(content) {
    const entries = {};
    const typeFieldsPresent = new Set();
    const lines = content.split(/\r?\n/);
    let currentName = null;
    let currentEntry = {};
    let currentSection = null;
    const flushCurrent = () => {
        if (!currentName)
            return;
        const normalized = normalizeRegistryEntry(currentEntry);
        if (normalized) {
            entries[currentName] = normalized;
        }
        currentName = null;
        currentEntry = {};
        currentSection = null;
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const rawLine = lines[lineIndex];
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const tableKeys = parseTomlTableHeader(line);
        if (tableKeys) {
            const name = tableKeys[0] === 'mcp_servers' ? tableKeys[1] : undefined;
            if (name && CODEX_MCP_SERVER_NAME_PATTERN.test(name) && tableKeys.length === 3 && tableKeys[2] === 'headers') {
                if (!currentName || currentName !== name) {
                    flushCurrent();
                    currentName = name;
                    currentEntry = {};
                }
                currentSection = 'headers';
            }
            else if (name && CODEX_MCP_SERVER_NAME_PATTERN.test(name) && tableKeys.length === 2) {
                flushCurrent();
                currentName = name;
                currentEntry = {};
                currentSection = 'server';
            }
            else {
                flushCurrent();
            }
            continue;
        }
        if (line.startsWith('[[')) {
            flushCurrent();
            continue;
        }
        if (!currentName || !currentSection) {
            continue;
        }
        const [rawKey, ...rawValueParts] = line.split('=');
        if (!rawKey || rawValueParts.length === 0) {
            continue;
        }
        const key = parseTomlKey(rawKey);
        if (!key) {
            continue;
        }
        let value = rawValueParts.join('=').trim();
        const multilineDelimiter = value.startsWith('"""')
            ? '"""'
            : value.startsWith("'''")
                ? "'''"
                : undefined;
        if (multilineDelimiter && !hasClosingTomlMultilineString(value, multilineDelimiter)) {
            while (lineIndex + 1 < lines.length && !hasClosingTomlMultilineString(value, multilineDelimiter)) {
                value += `\n${lines[++lineIndex]}`;
            }
        }
        if (currentSection === 'headers') {
            const parsed = parseTomlQuotedString(value);
            if (parsed !== undefined) {
                currentEntry.headers = { ...(currentEntry.headers ?? {}), [key]: parsed };
            }
        }
        else if (key === 'command') {
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
        else if (key === 'type') {
            typeFieldsPresent.add(currentName);
            const parsed = parseTomlQuotedString(value);
            if (parsed)
                currentEntry.type = parsed;
        }
        else if (key === 'env') {
            const parsed = parseTomlEnvTable(value);
            if (parsed)
                currentEntry.env = parsed;
        }
        else if (key === 'headers') {
            const parsed = parseTomlEnvTable(value);
            if (parsed)
                currentEntry.headers = parsed;
        }
        else if (key === 'startup_timeout_sec') {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0)
                currentEntry.timeout = parsed;
        }
    }
    flushCurrent();
    return {
        entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
        typeFieldsPresent,
    };
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
    const codexRegistry = existsSync(codexConfigPath)
        ? parseCodexMcpRegistryEntries(readFileSync(codexConfigPath, 'utf-8'))
        : { entries: {}, typeFieldsPresent: new Set() };
    const codexEntries = codexRegistry.entries;
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
        else if (!codexEntriesEqual(codexEntries[name], entry, codexRegistry.typeFieldsPresent.has(name))) {
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