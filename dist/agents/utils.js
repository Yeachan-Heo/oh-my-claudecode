/**
 * Agent Utilities
 *
 * Shared utilities for agent creation and management.
 * Includes prompt builders and configuration helpers.
 *
 * Ported from oh-my-opencode's agent utils.
 */
import { readFileSync } from 'fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../utils/frontmatter.js';
/**
 * Get the package root directory (where agents/ folder lives).
 * Handles both ESM (import.meta.url) and CJS bundle (__dirname) contexts.
 * In CJS bundles, __dirname is always reliable and should take precedence.
 * This avoids path skew when import.meta.url is shimmed during bundling.
 */
function getPackageDir() {
    // __dirname is available in bundled CJS and in some test transpilation contexts.
    if (typeof __dirname !== 'undefined' && __dirname) {
        const currentDirName = basename(__dirname);
        const parentDirName = basename(dirname(__dirname));
        // Bundled CLI path: bridge/cli.cjs -> package root is one level up.
        if (currentDirName === 'bridge') {
            return join(__dirname, '..');
        }
        // Source/dist module path (src/agents or dist/agents) -> package root is two levels up.
        if (currentDirName === 'agents' && (parentDirName === 'src' || parentDirName === 'dist')) {
            return join(__dirname, '..', '..');
        }
    }
    // ESM path (works in dev via ts/dist)
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const currentDirName = basename(__dirname);
        if (currentDirName === 'bridge') {
            return join(__dirname, '..');
        }
        // From src/agents/ or dist/agents/ go up to package root
        return join(__dirname, '..', '..');
    }
    catch {
        // import.meta.url unavailable — last resort
    }
    // Last resort
    return process.cwd();
}
/**
 * Strip YAML frontmatter from markdown content.
 */
export function stripFrontmatter(content) {
    return parseFrontmatter(content).body.trim();
}
/**
 * Load an agent prompt from /agents/{agentName}.md
 * Uses build-time embedded prompts when available (CJS bundles),
 * falls back to runtime file reads (dev/test environments).
 *
 * Security: Validates agent name to prevent path traversal attacks
 */
export function loadAgentPrompt(agentName) {
    // Security: Validate agent name contains only safe characters (alphanumeric and hyphens)
    // This prevents path traversal attacks like "../../etc/passwd"
    if (!/^[a-z0-9-]+$/i.test(agentName)) {
        throw new Error(`Invalid agent name: contains disallowed characters`);
    }
    // Prefer build-time embedded prompts (always available in CJS bundles)
    try {
        if (typeof __AGENT_PROMPTS__ !== 'undefined' && __AGENT_PROMPTS__ !== null) {
            const prompt = __AGENT_PROMPTS__[agentName];
            if (prompt)
                return prompt;
        }
    }
    catch {
        // __AGENT_PROMPTS__ not defined — fall through to runtime file read
    }
    // Runtime fallback: read from filesystem (dev/test environments)
    try {
        const agentsDir = join(getPackageDir(), 'agents');
        const agentPath = join(agentsDir, `${agentName}.md`);
        // Security: Verify resolved path is within the agents directory
        const resolvedPath = resolve(agentPath);
        const resolvedAgentsDir = resolve(agentsDir);
        const rel = relative(resolvedAgentsDir, resolvedPath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error(`Invalid agent name: path traversal detected`);
        }
        const content = readFileSync(agentPath, 'utf-8');
        return stripFrontmatter(content);
    }
    catch (error) {
        // Don't leak internal paths in error messages
        const message = error instanceof Error && error.message.includes('Invalid agent name')
            ? error.message
            : 'Agent prompt file not found';
        console.warn(`[loadAgentPrompt] ${message}`);
        return `Agent: ${agentName}\n\nPrompt unavailable.`;
    }
}
/**
 * Create tool restrictions configuration
 * Returns an object that can be spread into agent config to restrict tools
 */
export function createAgentToolRestrictions(blockedTools) {
    const restrictions = {};
    for (const tool of blockedTools) {
        restrictions[tool.toLowerCase()] = false;
    }
    return { tools: restrictions };
}
/**
 * Merge agent configuration with overrides
 */
export function mergeAgentConfig(base, override) {
    const { prompt_append, ...rest } = override;
    const merged = {
        ...base,
        ...(rest.model && { model: rest.model }),
        ...(rest.enabled !== undefined && { enabled: rest.enabled })
    };
    if (prompt_append && merged.prompt) {
        merged.prompt = merged.prompt + '\n\n' + prompt_append;
    }
    return merged;
}
/**
 * Build delegation table section for OMC prompt
 */
export function buildDelegationTable(availableAgents) {
    if (availableAgents.length === 0) {
        return '';
    }
    const rows = availableAgents
        .filter(a => a.metadata.triggers.length > 0)
        .map(a => {
        const triggers = a.metadata.triggers
            .map(t => `${t.domain}: ${t.trigger}`)
            .join('; ');
        return `| ${a.metadata.promptAlias || a.name} | ${a.metadata.cost} | ${triggers} |`;
    });
    if (rows.length === 0) {
        return '';
    }
    return `### Agent Delegation Table

| Agent | Cost | When to Use |
|-------|------|-------------|
${rows.join('\n')}`;
}
/**
 * Build use/avoid section for an agent
 */
export function buildUseAvoidSection(metadata) {
    const sections = [];
    if (metadata.useWhen && metadata.useWhen.length > 0) {
        sections.push(`**USE when:**
${metadata.useWhen.map(u => `- ${u}`).join('\n')}`);
    }
    if (metadata.avoidWhen && metadata.avoidWhen.length > 0) {
        sections.push(`**AVOID when:**
${metadata.avoidWhen.map(a => `- ${a}`).join('\n')}`);
    }
    return sections.join('\n\n');
}
/**
 * Create environment context for agents
 */
export function createEnvContext() {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const timeStr = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
    return `
<env-context>
  Current time: ${timeStr}
  Timezone: ${timezone}
  Locale: ${locale}
</env-context>`;
}
/**
 * Get all available agents as AvailableAgent descriptors
 */
export function getAvailableAgents(agents) {
    return Object.entries(agents)
        .filter(([_, config]) => config.metadata)
        .map(([name, config]) => ({
        name,
        description: config.description,
        metadata: config.metadata
    }));
}
/**
 * Build key triggers section for OMC prompt
 */
export function buildKeyTriggersSection(availableAgents) {
    const triggers = [];
    for (const agent of availableAgents) {
        for (const trigger of agent.metadata.triggers) {
            triggers.push(`- **${trigger.domain}** → ${agent.metadata.promptAlias || agent.name}: ${trigger.trigger}`);
        }
    }
    if (triggers.length === 0) {
        return '';
    }
    return `### Key Triggers (CHECK BEFORE ACTING)

${triggers.join('\n')}`;
}
/**
 * Validate agent configuration
 */
export function validateAgentConfig(config) {
    const errors = [];
    if (!config.name) {
        errors.push('Agent name is required');
    }
    if (!config.description) {
        errors.push('Agent description is required');
    }
    if (!config.prompt) {
        errors.push('Agent prompt is required');
    }
    // Note: tools is now optional - agents get all tools by default if omitted
    return errors;
}
/**
 * Parse disallowedTools from agent markdown frontmatter
 */
export function parseDisallowedTools(agentName) {
    // Security: Validate agent name contains only safe characters (alphanumeric and hyphens)
    if (!/^[a-z0-9-]+$/i.test(agentName)) {
        return undefined;
    }
    try {
        const agentsDir = join(getPackageDir(), 'agents');
        const agentPath = join(agentsDir, `${agentName}.md`);
        // Security: Verify resolved path is within the agents directory
        const resolvedPath = resolve(agentPath);
        const resolvedAgentsDir = resolve(agentsDir);
        const rel = relative(resolvedAgentsDir, resolvedPath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            return undefined;
        }
        const content = readFileSync(agentPath, 'utf-8');
        return extractDisallowedTools(content);
    }
    catch {
        return undefined;
    }
}
/**
 * Read the comma-separated disallowedTools list from agent frontmatter.
 */
export function extractDisallowedTools(content) {
    const value = parseFrontmatter(content).metadata.disallowedTools;
    if (!value)
        return undefined;
    return value.split(',').map(t => t.trim()).filter(Boolean);
}
/**
 * Environment variable that adds tools to every agent's disallowedTools list.
 * Comma-separated tool names or patterns; unset or empty changes nothing.
 */
export const EXTRA_DISALLOWED_TOOLS_ENV = 'OMC_AGENT_EXTRA_DISALLOWED_TOOLS';
/**
 * Tool names and patterns the `desktop` preset expands to: the desktop app's
 * artifact tools and its turn, session, visualize and browser tool families.
 */
export const DESKTOP_APP_DISALLOWED_TOOLS = [
    'Artifact',
    'ArtifactComments',
    'ArtifactData',
    'ArtifactCheck',
    'mcp__ccd_turn__*',
    'mcp__ccd_session__*',
    'mcp__visualize__*',
    'mcp__Claude_Browser__*',
];
/**
 * Read the extra disallowed tools from OMC_AGENT_EXTRA_DISALLOWED_TOOLS.
 * Tokens are trimmed, empty tokens and tokens containing a line break are
 * ignored, `desktop` (any case) expands to DESKTOP_APP_DISALLOWED_TOOLS, and
 * duplicates are removed keeping the first occurrence.
 */
export function getExtraDisallowedTools(env = process.env) {
    const raw = env[EXTRA_DISALLOWED_TOOLS_ENV];
    if (!raw)
        return [];
    const tokens = [];
    for (const part of raw.split(',')) {
        const token = part.trim();
        if (!token || /[\r\n]/.test(token))
            continue;
        if (token.toLowerCase() === 'desktop') {
            tokens.push(...DESKTOP_APP_DISALLOWED_TOOLS);
        }
        else {
            tokens.push(token);
        }
    }
    return [...new Set(tokens)];
}
/**
 * Append extra tools to an agent's own disallowedTools list. Entries of the
 * agent's list are never removed or reordered. With no extra tools the
 * original value is returned unchanged (including `undefined`).
 */
export function mergeDisallowedTools(base, extra) {
    if (extra.length === 0)
        return base;
    const merged = [...(base ?? [])];
    for (const tool of extra) {
        if (!merged.includes(tool))
            merged.push(tool);
    }
    return merged;
}
/**
 * Whether a token can be written into a frontmatter line as a plain YAML
 * text value. Rejected: line breaks (including U+0085, U+2028 and U+2029), a
 * colon followed by whitespace or ending the token, a `#` preceded by
 * whitespace, a leading character that YAML gives a meaning (`-`, `?`, `:`,
 * `#`, `&`, `*`, `!`, `|`, `>`, quotes, `%`, `@`, a backtick, `[`, `{`, `]`, `}`), and
 * words YAML reads as null, boolean or number instead of text. A `*` inside
 * a pattern such as `mcp__server__*` is accepted.
 */
export function isPlainYamlToken(token) {
    if (/[\r\n\u0085\u2028\u2029]/.test(token))
        return false;
    if (/^[-?:#&*!|>'"%@`[{\}\]]/.test(token))
        return false;
    if (/:(\s|$)/.test(token) || /\s#/.test(token))
        return false;
    if (/^(?:~|null|true|false|\.inf|\.nan|0x[0-9a-f]+|0o[0-7]+|\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.test(token)) {
        return false;
    }
    return true;
}
/**
 * Apply extra disallowed tools to agent markdown: append them to the
 * `disallowedTools:` frontmatter line, or add that line when the agent has
 * none. Tokens that are not plain YAML text (see isPlainYamlToken) are
 * skipped. Returns the content unchanged when no usable extra tool remains,
 * there is no frontmatter, or the existing `disallowedTools:` entry is
 * written in a form this does not rewrite (empty value, block list, flow
 * list, trailing comment).
 */
export function applyExtraDisallowedToolsToMarkdown(content, extra) {
    const usable = extra.filter(isPlainYamlToken);
    if (usable.length === 0)
        return content;
    const match = content.match(/^(\uFEFF?---)(\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/);
    if (!match)
        return content;
    const [head, open, newline, yaml, close] = match;
    const base = extractDisallowedTools(content);
    const existing = /^disallowedTools:(.*)$/m;
    const existingMatch = yaml.match(existing);
    const line = `disallowedTools: ${(mergeDisallowedTools(base, usable) ?? []).join(', ')}`;
    let nextYaml;
    if (base === undefined) {
        // A key that exists but yields no list (empty value, block list) is left alone.
        if (existingMatch !== null)
            return content;
        nextYaml = `${yaml}${newline}${line}`;
    }
    else {
        if (existingMatch === null)
            return content;
        const value = existingMatch[1].trim();
        if (value.startsWith('[') || /\s#/.test(value))
            return content;
        // A replacer function keeps `$` sequences in the tokens literal.
        nextYaml = yaml.replace(existing, () => line);
    }
    return `${open}${newline}${nextYaml}${close}${content.slice(head.length)}`;
}
/**
 * Standard path for open questions file
 */
export const OPEN_QUESTIONS_PATH = '.omc/plans/open-questions.md';
/**
 * Format open questions for appending to the standard open-questions.md file.
 *
 * @param topic - The plan or analysis topic name
 * @param questions - Array of { question, reason } objects
 * @returns Formatted markdown string ready to append
 */
export function formatOpenQuestions(topic, questions) {
    if (questions.length === 0)
        return '';
    const date = new Date().toISOString().split('T')[0];
    const items = questions
        .map(q => `- [ ] ${q.question} — ${q.reason}`)
        .join('\n');
    return `\n## ${topic} - ${date}\n${items}\n`;
}
/**
 * Deep merge utility for configurations
 */
export function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
            continue;
        const sourceValue = source[key];
        const targetValue = target[key];
        if (sourceValue &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)) {
            result[key] = deepMerge(targetValue, sourceValue);
        }
        else if (sourceValue !== undefined) {
            result[key] = sourceValue;
        }
    }
    return result;
}
//# sourceMappingURL=utils.js.map