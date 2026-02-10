/**
 * Prompt Persistence - Audit trail for external model prompts and responses
 *
 * Writes assembled prompts and model responses to .omc/prompts/ before/after
 * sending to Codex/Gemini, providing visibility, debugging, and compliance audit trail.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { initJobDb, isJobDbInitialized, upsertJob, getJob, getActiveJobs as getActiveJobsFromDb, cleanupOldJobs as cleanupOldJobsInDb } from './job-state-db.js';
// Lazy-init guard: fires initJobDb at most once per process.
// initJobDb is async (dynamic import of better-sqlite3). If it hasn't resolved
// yet, isJobDbInitialized() returns false and callers use JSON fallback.
// This is best-effort: the first 1-2 status writes may be JSON-only.
let _dbInitAttempted = false;
// In-memory index: provider:jobId → workingDirectory used at creation time.
// Allows job management handlers to find JSON status files for cross-directory jobs.
// Keyed by provider:jobId to avoid collisions (8-hex IDs are short).
const jobWorkingDirs = new Map();
function ensureJobDb(workingDirectory) {
    if (_dbInitAttempted || isJobDbInitialized())
        return;
    _dbInitAttempted = true;
    const root = getWorktreeRoot(workingDirectory) || workingDirectory || process.cwd();
    initJobDb(root).catch(() => { });
}
function yamlString(value) {
    // JSON strings are valid YAML scalars and safely escape quotes/newlines.
    return JSON.stringify(value);
}
function renameOverwritingSync(fromPath, toPath) {
    // On Windows, renameSync does not overwrite existing destination.
    try {
        renameSync(fromPath, toPath);
        return;
    }
    catch {
        // retry after unlink
    }
    try {
        if (existsSync(toPath)) {
            unlinkSync(toPath);
        }
    }
    catch {
        // ignore
    }
    renameSync(fromPath, toPath);
}
/**
 * Convert text to a filesystem-safe slug for filename
 *
 * @param text - The text to slugify (typically the user prompt)
 * @param maxWords - Maximum number of words to include (default 4)
 * @returns A filesystem-safe slug
 */
export function slugify(text, maxWords = 4) {
    if (!text || typeof text !== 'string') {
        return 'prompt';
    }
    // Take first maxWords words
    const words = text.trim().split(/\s+/).slice(0, maxWords);
    // Join, lowercase, replace non-alphanumeric with hyphens
    let slug = words
        .join('-')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-') // Collapse multiple hyphens
        .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens
    // Truncate to 40 chars max
    if (slug.length > 40) {
        slug = slug.substring(0, 40).replace(/-$/, '');
    }
    return slug || 'prompt';
}
/**
 * Generate a short unique identifier
 *
 * @returns 8-character hex string
 */
export function generatePromptId() {
    return randomBytes(4).toString('hex');
}
/**
 * Get the prompts directory path under the worktree
 */
export function getPromptsDir(workingDirectory) {
    const root = getWorktreeRoot(workingDirectory) || workingDirectory || process.cwd();
    return join(root, '.omc', 'prompts');
}
/**
 * Build YAML frontmatter for a prompt file
 */
function buildPromptFrontmatter(options) {
    const lines = [
        '---',
        `provider: ${yamlString(options.provider)}`,
        `agent_role: ${yamlString(options.agentRole)}`,
        `model: ${yamlString(options.model)}`,
    ];
    if (options.files && options.files.length > 0) {
        lines.push('files:');
        for (const file of options.files) {
            lines.push(`  - ${yamlString(file)}`);
        }
    }
    lines.push(`timestamp: ${yamlString(new Date().toISOString())}`);
    lines.push('---');
    return lines.join('\n');
}
/**
 * Build YAML frontmatter for a response file
 */
function buildResponseFrontmatter(options) {
    const lines = [
        '---',
        `provider: ${yamlString(options.provider)}`,
        `agent_role: ${yamlString(options.agentRole)}`,
        `model: ${yamlString(options.model)}`,
        `prompt_id: ${yamlString(options.promptId)}`,
    ];
    if (options.usedFallback && options.fallbackModel) {
        lines.push(`used_fallback: true`);
        lines.push(`fallback_model: ${yamlString(options.fallbackModel)}`);
    }
    lines.push(`timestamp: ${yamlString(new Date().toISOString())}`);
    lines.push('---');
    return lines.join('\n');
}
/**
 * Persist a prompt to disk with YAML frontmatter
 *
 * @param options - The prompt details to persist
 * @returns The file path and metadata, or undefined on failure
 */
export function persistPrompt(options) {
    try {
        const promptsDir = getPromptsDir(options.workingDirectory);
        mkdirSync(promptsDir, { recursive: true });
        const slug = slugify(options.prompt);
        const id = generatePromptId();
        const filename = `${options.provider}-prompt-${slug}-${id}.md`;
        const filePath = join(promptsDir, filename);
        const frontmatter = buildPromptFrontmatter(options);
        const content = `${frontmatter}\n\n${options.fullPrompt}`;
        writeFileSync(filePath, content, 'utf-8');
        return { filePath, id, slug };
    }
    catch (err) {
        console.warn(`[prompt-persistence] Failed to persist prompt: ${err.message}`);
        return undefined;
    }
}
/**
 * Get the expected response file path without writing it
 * Useful for returning the path immediately before background execution completes
 *
 * @param provider - The provider (codex or gemini)
 * @param slug - The slug from the prompt
 * @param promptId - The ID from the prompt
 * @param workingDirectory - Optional working directory
 * @returns The expected file path for the response
 */
export function getExpectedResponsePath(provider, slug, promptId, workingDirectory) {
    const promptsDir = getPromptsDir(workingDirectory);
    const filename = `${provider}-response-${slug}-${promptId}.md`;
    return join(promptsDir, filename);
}
/**
 * Persist a model response to disk with YAML frontmatter
 *
 * @param options - The response details to persist
 * @returns The file path, or undefined on failure
 */
export function persistResponse(options) {
    try {
        const promptsDir = getPromptsDir(options.workingDirectory);
        mkdirSync(promptsDir, { recursive: true });
        const filename = `${options.provider}-response-${options.slug}-${options.promptId}.md`;
        const filePath = join(promptsDir, filename);
        const frontmatter = buildResponseFrontmatter(options);
        const content = `${frontmatter}\n\n${options.response}`;
        writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }
    catch (err) {
        console.warn(`[prompt-persistence] Failed to persist response: ${err.message}`);
        return undefined;
    }
}
// --- Job Status Utilities for Background Execution ---
/**
 * Get the status file path for a background job
 */
export function getStatusFilePath(provider, slug, promptId, workingDirectory) {
    const promptsDir = getPromptsDir(workingDirectory);
    return join(promptsDir, `${provider}-status-${slug}-${promptId}.json`);
}
/**
 * Write job status atomically (temp file + rename)
 */
export function writeJobStatus(status, workingDirectory) {
    ensureJobDb(workingDirectory);
    // Track the working directory for this job on initial creation
    const mapKey = `${status.provider}:${status.jobId}`;
    if (status.status === 'spawned' && workingDirectory) {
        jobWorkingDirs.set(mapKey, workingDirectory);
    }
    // Clean up map entry on terminal states to prevent unbounded growth
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'timeout') {
        jobWorkingDirs.delete(mapKey);
    }
    try {
        const promptsDir = getPromptsDir(workingDirectory);
        mkdirSync(promptsDir, { recursive: true });
        const statusPath = getStatusFilePath(status.provider, status.slug, status.jobId, workingDirectory);
        const tempPath = statusPath + '.tmp';
        writeFileSync(tempPath, JSON.stringify(status, null, 2), 'utf-8');
        renameOverwritingSync(tempPath, statusPath);
        // SQLite write-through: also persist to jobs.db if available
        if (isJobDbInitialized()) {
            upsertJob(status);
        }
    }
    catch (err) {
        console.warn(`[prompt-persistence] Failed to write job status: ${err.message}`);
    }
}
/**
 * Look up the working directory that was used when a job was created.
 * Returns undefined if the job was created in the server's CWD (no override).
 */
export function getJobWorkingDir(provider, jobId) {
    return jobWorkingDirs.get(`${provider}:${jobId}`);
}
/**
 * Read job status from disk
 */
export function readJobStatus(provider, slug, promptId, workingDirectory) {
    ensureJobDb(workingDirectory);
    // Try SQLite first if available
    if (isJobDbInitialized()) {
        const dbResult = getJob(provider, promptId);
        if (dbResult)
            return dbResult;
    }
    // Fallback to JSON file
    const statusPath = getStatusFilePath(provider, slug, promptId, workingDirectory);
    if (!existsSync(statusPath)) {
        return undefined;
    }
    try {
        const content = readFileSync(statusPath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return undefined;
    }
}
/**
 * Check if a background job's response is ready
 */
export function checkResponseReady(provider, slug, promptId, workingDirectory) {
    const responsePath = getExpectedResponsePath(provider, slug, promptId, workingDirectory);
    const ready = existsSync(responsePath);
    const status = readJobStatus(provider, slug, promptId, workingDirectory);
    return { ready, responsePath, status };
}
/**
 * Read a completed response, stripping YAML frontmatter
 */
export function readCompletedResponse(provider, slug, promptId, workingDirectory) {
    const responsePath = getExpectedResponsePath(provider, slug, promptId, workingDirectory);
    if (!existsSync(responsePath)) {
        return undefined;
    }
    const status = readJobStatus(provider, slug, promptId, workingDirectory);
    if (!status) {
        return undefined;
    }
    try {
        const content = readFileSync(responsePath, 'utf-8');
        const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n\n/);
        const response = frontmatterMatch
            ? content.slice(frontmatterMatch[0].length)
            : content;
        return { response, status };
    }
    catch {
        return undefined;
    }
}
/**
 * List all active (spawned or running) background jobs
 */
export function listActiveJobs(provider, workingDirectory) {
    ensureJobDb(workingDirectory);
    // Try SQLite first if available
    if (isJobDbInitialized()) {
        return getActiveJobsFromDb(provider);
    }
    const promptsDir = getPromptsDir(workingDirectory);
    if (!existsSync(promptsDir)) {
        return [];
    }
    try {
        const files = readdirSync(promptsDir);
        const statusFiles = files.filter((f) => {
            if (!f.endsWith('.json'))
                return false;
            if (provider) {
                return f.startsWith(`${provider}-status-`);
            }
            return f.includes('-status-');
        });
        const activeJobs = [];
        for (const file of statusFiles) {
            try {
                const content = readFileSync(join(promptsDir, file), 'utf-8');
                const status = JSON.parse(content);
                if (status.status === 'spawned' || status.status === 'running') {
                    activeJobs.push(status);
                }
            }
            catch {
                // Skip malformed files
            }
        }
        return activeJobs;
    }
    catch {
        return [];
    }
}
/**
 * Mark stale background jobs (older than maxAgeMs) as timed out
 */
export function cleanupStaleJobs(maxAgeMs, workingDirectory) {
    ensureJobDb(workingDirectory);
    // Also cleanup old terminal jobs in SQLite
    if (isJobDbInitialized()) {
        cleanupOldJobsInDb(maxAgeMs);
    }
    const promptsDir = getPromptsDir(workingDirectory);
    if (!existsSync(promptsDir)) {
        return 0;
    }
    try {
        const files = readdirSync(promptsDir);
        const statusFiles = files.filter((f) => f.includes('-status-') && f.endsWith('.json'));
        let cleanedCount = 0;
        const now = Date.now();
        for (const file of statusFiles) {
            try {
                const filePath = join(promptsDir, file);
                const content = readFileSync(filePath, 'utf-8');
                const status = JSON.parse(content);
                if (status.status === 'spawned' || status.status === 'running') {
                    const spawnedAt = new Date(status.spawnedAt).getTime();
                    if (now - spawnedAt > maxAgeMs) {
                        status.status = 'timeout';
                        status.completedAt = new Date().toISOString();
                        status.error = 'Job exceeded maximum age and was marked stale';
                        writeJobStatus(status, workingDirectory);
                        cleanedCount++;
                    }
                }
            }
            catch {
                // Skip malformed files
            }
        }
        return cleanedCount;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=prompt-persistence.js.map