/**
 * Wiki Session Hooks
 *
 * SessionStart: load wiki context, inject relevant pages, lazy index rebuild,
 *   feed project-memory into wiki environment.md
 * SessionEnd: bounded append-only capture of session metadata
 * PreCompact: inject wiki summary for compaction survival
 */
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { getWikiDir, readIndex, readPage, readAllPages, readLog, listPages, withWikiLock, writePageUnsafe, writeEnvironmentUnsafe, updateIndexUnsafe, appendLogUnsafe, } from './storage.js';
import { WIKI_SCHEMA_VERSION, DEFAULT_WIKI_CONFIG } from './types.js';
function captureKeyFor(intent) {
    if (typeof intent.captureKey === 'string' && /^[a-f0-9]{64}$/.test(intent.captureKey)) {
        return intent.captureKey;
    }
    return createHash('sha256')
        .update(`${intent.sessionId}\u0000${intent.filename}\u0000${intent.capturedAt}`)
        .digest('hex');
}
function pageHasCaptureKey(page, captureKey) {
    return page?.content.includes(`<!-- omc-wiki-capture:${captureKey} -->`) ?? false;
}
function logHasCaptureKey(root, captureKey) {
    return readLog(root)?.includes(`omc-wiki-capture:${captureKey}`) ?? false;
}
function isBeforeDeadline(deadlineAt) {
    return deadlineAt === undefined || Date.now() <= deadlineAt;
}
function captureFilename(sessionId, capturedAt) {
    const dateSlug = capturedAt.split('T')[0] ?? 'unknown-date';
    let hash = 0;
    for (let index = 0; index < sessionId.length; index += 1) {
        hash = ((hash << 5) - hash + sessionId.charCodeAt(index)) | 0;
    }
    return `session-log-${dateSlug}-${(hash >>> 0).toString(16).padStart(8, '0')}.md`;
}
/**
 * Load wiki config from .omc-config.json.
 * Returns defaults if config doesn't exist or wiki section is missing.
 */
function loadWikiConfig(root) {
    try {
        const configPath = join(getOmcRoot(root), '.omc-config.json');
        // Try active Claude config too
        const activeConfigPath = join(getClaudeConfigDir(), '.omc-config.json');
        for (const path of [configPath, activeConfigPath]) {
            if (existsSync(path)) {
                const raw = JSON.parse(readFileSync(path, 'utf-8'));
                if (raw?.wiki) {
                    return { ...DEFAULT_WIKI_CONFIG, ...raw.wiki };
                }
            }
        }
    }
    catch {
        // Ignore config errors, use defaults
    }
    return DEFAULT_WIKI_CONFIG;
}
/**
 * Build a JSON-safe SessionEnd capture intent without taking the wiki lock or
 * mutating the filesystem. The manifest worker durably owns and commits it.
 */
export function buildWikiSessionEndCaptureIntent(data) {
    try {
        const root = data.cwd || process.cwd();
        if (!loadWikiConfig(root).autoCapture || !existsSync(getWikiDir(root)))
            return null;
        const sessionId = data.session_id || `session-${Date.now()}`;
        const capturedAt = new Date().toISOString();
        const filename = captureFilename(sessionId, capturedAt);
        const captureKey = captureKeyFor({ sessionId, filename, capturedAt });
        return {
            kind: 'wiki-session-end-capture',
            root,
            sessionId,
            filename,
            capturedAt,
            captureKey,
        };
    }
    catch {
        return null;
    }
}
/**
 * Commit a capture intent under the existing wiki lock. Replaying the same
 * intent never duplicates its page or its log entry.
 */
export function commitWikiSessionEndCaptureIntent(intent, options = {}) {
    if (!isBeforeDeadline(options.deadlineAt))
        return false;
    try {
        const captureKey = captureKeyFor(intent);
        let committed = false;
        withWikiLock(intent.root, () => {
            if (!isBeforeDeadline(options.deadlineAt))
                return;
            const existingPage = readPage(intent.root, intent.filename);
            if (!pageHasCaptureKey(existingPage, captureKey)) {
                const dateSlug = intent.capturedAt.split('T')[0] ?? 'unknown-date';
                writePageUnsafe(intent.root, {
                    filename: intent.filename,
                    frontmatter: {
                        title: `Session Log ${dateSlug}`,
                        tags: ['session-log', 'auto-captured'],
                        created: intent.capturedAt,
                        updated: intent.capturedAt,
                        sources: [intent.sessionId],
                        links: [],
                        category: 'session-log',
                        confidence: 'medium',
                        schemaVersion: WIKI_SCHEMA_VERSION,
                    },
                    content: `\n# Session Log ${dateSlug}\n\nAuto-captured session metadata.\nSession ID: ${intent.sessionId}\n<!-- omc-wiki-capture:${captureKey} -->\n\nReview and promote significant findings to curated wiki pages via \`wiki_ingest\`.\n`,
                });
            }
            if (!isBeforeDeadline(options.deadlineAt))
                return;
            if (!logHasCaptureKey(intent.root, captureKey)) {
                appendLogUnsafe(intent.root, {
                    timestamp: intent.capturedAt,
                    operation: 'ingest',
                    pagesAffected: [intent.filename],
                    summary: `Auto-captured session log for ${intent.sessionId} (omc-wiki-capture:${captureKey})`,
                });
            }
            if (!isBeforeDeadline(options.deadlineAt))
                return;
            committed = pageHasCaptureKey(readPage(intent.root, intent.filename), captureKey)
                && logHasCaptureKey(intent.root, captureKey);
        }, {
            deadlineAt: options.deadlineAt,
            timeoutMs: options.lockTimeoutMs,
        });
        return committed;
    }
    catch {
        return false;
    }
}
/**
 * SessionStart hook: inject wiki context into session.
 *
 * 1. Read wiki index, rebuild if stale
 * 2. Feed project-memory into environment.md if newer
 * 3. Return context summary for injection
 */
export function onSessionStart(data) {
    try {
        const root = data.cwd || process.cwd();
        const wikiDir = getWikiDir(root);
        if (!existsSync(wikiDir)) {
            return {}; // No wiki yet, nothing to inject
        }
        // Lazy index rebuild
        const pages = listPages(root);
        if (pages.length > 0) {
            const indexContent = readIndex(root);
            if (!indexContent) {
                // Index missing — rebuild
                withWikiLock(root, () => { updateIndexUnsafe(root); });
            }
        }
        // Feed project-memory into wiki
        feedProjectMemory(root);
        // Build context summary
        const index = readIndex(root);
        if (!index || pages.length === 0)
            return {};
        const summary = [
            `[LLM Wiki: ${pages.length} pages at .omc/wiki/]`,
            '',
            'Use wiki_query to search, wiki_list to browse, wiki_read to view pages.',
            '',
            index.split('\n').slice(0, 30).join('\n'), // First 30 lines of index
        ].join('\n');
        return { additionalContext: summary };
    }
    catch {
        return {};
    }
}
/**
 * SessionEnd foreground compatibility hook. It deliberately constructs no
 * writes and never acquires the wiki lock; the session wrapper enqueues the
 * intent for the manifest worker to commit.
 */
export function onSessionEnd(_data) {
    return { continue: true };
}
/**
 * PreCompact hook: inject wiki summary for compaction survival.
 */
export function onPreCompact(data) {
    try {
        const root = data.cwd || process.cwd();
        const pages = listPages(root);
        if (pages.length === 0)
            return {};
        const allPages = readAllPages(root);
        const categories = [...new Set(allPages.map(p => p.frontmatter.category))];
        const latestUpdate = allPages
            .map(p => p.frontmatter.updated)
            .sort()
            .reverse()[0] || 'unknown';
        return {
            additionalContext: `[Wiki: ${pages.length} pages | categories: ${categories.join(', ')} | last updated: ${latestUpdate}]`,
        };
    }
    catch {
        return {};
    }
}
/**
 * Feed project-memory auto-detected facts into wiki environment.md.
 * Only updates if project-memory is newer than existing environment.md.
 */
function feedProjectMemory(root) {
    try {
        const pmPath = join(getOmcRoot(root), 'project-memory.json');
        if (!existsSync(pmPath))
            return;
        const pm = JSON.parse(readFileSync(pmPath, 'utf-8'));
        if (!pm.lastScanned)
            return;
        const envSlug = 'environment.md';
        const existing = readPage(root, envSlug);
        // Skip if environment.md exists and is newer than project-memory
        if (existing) {
            const existingTime = new Date(existing.frontmatter.updated).getTime();
            const pmTime = new Date(pm.lastScanned).getTime();
            if (existingTime >= pmTime)
                return;
        }
        // Build environment content from project-memory
        const lines = ['\n# Project Environment\n'];
        if (pm.techStack) {
            const ts = pm.techStack;
            if (ts.languages?.length) {
                const names = ts.languages
                    .map((l) => (typeof l === 'string' ? l : l?.name))
                    .filter(Boolean)
                    .join(', ');
                if (names)
                    lines.push(`**Languages:** ${names}`);
            }
            if (ts.frameworks?.length) {
                const names = ts.frameworks
                    .map((f) => (typeof f === 'string' ? f : f?.name))
                    .filter(Boolean)
                    .join(', ');
                if (names)
                    lines.push(`**Frameworks:** ${names}`);
            }
            if (ts.packageManager)
                lines.push(`**Package Manager:** ${ts.packageManager}`);
            if (ts.runtime)
                lines.push(`**Runtime:** ${ts.runtime}`);
            lines.push('');
        }
        if (pm.build) {
            lines.push('## Build Commands');
            for (const [key, val] of Object.entries(pm.build)) {
                if (val)
                    lines.push(`- **${key}:** \`${val}\``);
            }
            lines.push('');
        }
        const now = new Date().toISOString();
        withWikiLock(root, () => {
            writeEnvironmentUnsafe(root, {
                filename: envSlug,
                frontmatter: {
                    title: 'Project Environment',
                    tags: ['environment', 'auto-detected'],
                    created: existing?.frontmatter.created || now,
                    updated: now,
                    sources: ['project-memory-auto-detect'],
                    links: [],
                    category: 'environment',
                    confidence: 'high',
                    schemaVersion: WIKI_SCHEMA_VERSION,
                },
                content: lines.join('\n'),
            });
            updateIndexUnsafe(root);
        });
    }
    catch {
        // Silently fail — project-memory feeding is best-effort
    }
}
//# sourceMappingURL=session-hooks.js.map