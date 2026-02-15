/**
 * Provider Core - Shared business logic for MCP CLI provider integration
 *
 * Extracts the common patterns between codex-core.ts and gemini-core.ts
 * into a single parameterized implementation. Each provider defines a
 * ProviderConfig with its CLI-specific differences; the generic functions
 * handle execution, fallback chains, background jobs, and the full
 * handleAsk flow.
 */
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { resolve, relative, sep, isAbsolute, join } from 'path';
import { createStdoutCollector, safeWriteOutputFile } from './shared-exec.js';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { isExternalPromptAllowed } from './mcp-config.js';
import { resolveSystemPrompt, buildPromptWithSystemContext, wrapUntrustedFileContent, wrapUntrustedCliResponse, isValidAgentRoleName, VALID_AGENT_ROLES, singleErrorBlock, inlineSuccessBlocks, } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath, getPromptsDir, generatePromptId, slugify, writeJobStatus, getStatusFilePath, readJobStatus, } from './prompt-persistence.js';
import { resolveExternalModel, buildFallbackChain, } from '../features/model-routing/external-model-policy.js';
import { loadConfig } from '../config/loader.js';
// ─── Shared Constants ─────────────────────────────────────────────────────────
export const MODEL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB stdout cap
export const PLATFORM_SHELL_OPTS = process.platform === 'win32' ? { shell: true } : {};
export const RATE_LIMIT_PATTERN = /429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i;
// ─── Shared Utility Functions ─────────────────────────────────────────────────
export function validateModelName(model) {
    if (!MODEL_NAME_REGEX.test(model)) {
        throw new Error(`Invalid model name: "${model}". Model names must match pattern: alphanumeric start, followed by alphanumeric, dots, hyphens, or underscores (max 64 chars).`);
    }
}
/**
 * Compute exponential backoff delay with jitter for rate limit retries.
 * Returns delay in ms: min(initialDelay * 2^attempt, maxDelay) * random(0.5, 1.0)
 */
export function computeBackoffDelay(attempt, initialDelay, maxDelay) {
    const exponential = initialDelay * Math.pow(2, attempt);
    const capped = Math.min(exponential, maxDelay);
    const jitter = capped * (0.5 + Math.random() * 0.5);
    return Math.round(jitter);
}
/** Sleep for the specified duration. Exported for test mockability. */
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function createPidRegistry() {
    const pids = new Set();
    return {
        add: (pid) => { pids.add(pid); },
        delete: (pid) => { pids.delete(pid); },
        has: (pid) => pids.has(pid),
        clear: () => { pids.clear(); },
    };
}
// ─── File Validation ──────────────────────────────────────────────────────────
export function validateAndReadFile(filePath, baseDir) {
    if (typeof filePath !== 'string') {
        return `--- File: ${filePath} --- (Invalid path type)`;
    }
    try {
        const workingDir = baseDir || process.cwd();
        const resolvedAbs = resolve(workingDir, filePath);
        const cwdReal = realpathSync(workingDir);
        const relAbs = relative(cwdReal, resolvedAbs);
        if (relAbs === '..' || relAbs.startsWith('..' + sep) || isAbsolute(relAbs)) {
            return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
        }
        const resolvedReal = realpathSync(resolvedAbs);
        const relReal = relative(cwdReal, resolvedReal);
        if (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal)) {
            return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
        }
        const stats = statSync(resolvedReal);
        if (!stats.isFile()) {
            return `--- File: ${filePath} --- (Not a regular file)`;
        }
        if (stats.size > MAX_FILE_SIZE) {
            return `--- File: ${filePath} --- (File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB, max 5MB)`;
        }
        return wrapUntrustedFileContent(filePath, readFileSync(resolvedReal, 'utf-8'));
    }
    catch {
        return `--- File: ${filePath} --- (Error reading file)`;
    }
}
// ─── Generic CLI Execution ────────────────────────────────────────────────────
/**
 * Execute a provider CLI command synchronously (waits for completion).
 */
export function executeCli(config, prompt, model, cwd, extra) {
    return new Promise((resolve, reject) => {
        validateModelName(model);
        let settled = false;
        const args = config.buildCliArgs(model, extra);
        const child = spawn(config.cliCommand, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
            ...PLATFORM_SHELL_OPTS,
        });
        const timeoutHandle = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
                reject(new Error(`${config.name} timed out after ${config.timeout}ms`));
            }
        }, config.timeout);
        const collector = createStdoutCollector(MAX_STDOUT_BYTES);
        let stderr = '';
        child.stdout.on('data', (data) => { collector.append(data.toString()); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('close', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                const stdout = collector.toString();
                if (code === 0 || stdout.trim()) {
                    const retryable = config.isRetryableError(stdout, stderr);
                    if (retryable.isError) {
                        reject(new Error(`${config.name} ${retryable.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryable.message}`));
                    }
                    else {
                        resolve(config.parseOutput(stdout));
                    }
                }
                else {
                    const retryableExit = config.isRetryableError(stderr, stdout);
                    if (retryableExit.isError) {
                        reject(new Error(`${config.name} ${retryableExit.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryableExit.message}`));
                    }
                    else {
                        reject(new Error(`${config.name} exited with code ${code}: ${stderr || 'No output'}`));
                    }
                }
            }
        });
        child.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                child.kill('SIGTERM');
                reject(new Error(`Failed to spawn ${config.name} CLI: ${err.message}`));
            }
        });
        child.stdin.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                child.kill('SIGTERM');
                reject(new Error(`Stdin write error: ${err.message}`));
            }
        });
        child.stdin.write(prompt);
        child.stdin.end();
    });
}
// ─── Generic CLI Execution with Fallback Chain ────────────────────────────────
export async function executeCliWithFallback(config, prompt, model, cwd, fallbackChain, extra, overrides) {
    const exec = overrides?.executor ?? executeCli;
    const sleepFn = overrides?.sleepFn ?? sleep;
    const modelExplicit = model !== undefined && model !== null && model !== '';
    const effectiveModel = model || config.defaultModel;
    const rlConfig = config.rateLimitConfig;
    // Explicit model with rate-limit config: retry same model with backoff
    if (modelExplicit && rlConfig) {
        let lastError = null;
        for (let attempt = 0; attempt <= rlConfig.retryCount; attempt++) {
            try {
                const response = await exec(config, prompt, effectiveModel, cwd, extra);
                return { response, usedFallback: false, actualModel: effectiveModel };
            }
            catch (err) {
                lastError = err;
                if (!RATE_LIMIT_PATTERN.test(lastError.message))
                    throw lastError;
                if (attempt < rlConfig.retryCount) {
                    await sleepFn(computeBackoffDelay(attempt, rlConfig.initialDelay, rlConfig.maxDelay));
                }
            }
        }
        throw lastError || new Error(`${config.name} rate limit: all retries exhausted`);
    }
    // Use provided fallback chain or build from defaults
    const chain = fallbackChain || config.modelFallbacks;
    const modelsToTry = chain.includes(effectiveModel)
        ? chain.slice(chain.indexOf(effectiveModel))
        : [effectiveModel, ...chain];
    let lastError = null;
    let rateLimitAttempt = 0;
    for (const tryModel of modelsToTry) {
        try {
            const response = await exec(config, prompt, tryModel, cwd, extra);
            return { response, usedFallback: tryModel !== effectiveModel, actualModel: tryModel };
        }
        catch (err) {
            lastError = err;
            // Non-retryable error: throw immediately
            if (!/model error|model_not_found|model is not supported|429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(lastError.message)) {
                throw lastError;
            }
            // Add backoff delay for rate limit errors before trying next model
            if (rlConfig && RATE_LIMIT_PATTERN.test(lastError.message)) {
                await sleepFn(computeBackoffDelay(rateLimitAttempt, rlConfig.initialDelay, rlConfig.maxDelay));
                rateLimitAttempt++;
            }
        }
    }
    throw lastError || new Error(`All ${config.name} models in fallback chain failed`);
}
// ─── Generic Background Execution ────────────────────────────────────────────
export function executeCliBackground(config, pidRegistry, fullPrompt, modelInput, jobMeta, workingDirectory, extra) {
    try {
        const modelExplicit = modelInput !== undefined && modelInput !== null && modelInput !== '';
        const effectiveModel = modelInput || config.defaultModel;
        const rlConfig = config.rateLimitConfig;
        const modelsToTry = modelExplicit
            ? [effectiveModel]
            : (config.modelFallbacks.includes(effectiveModel)
                ? config.modelFallbacks.slice(config.modelFallbacks.indexOf(effectiveModel))
                : [effectiveModel, ...config.modelFallbacks]);
        const trySpawnWithModel = (tryModel, remainingModels, rateLimitAttempt = 0) => {
            validateModelName(tryModel);
            const args = config.buildCliArgs(tryModel, extra);
            const child = spawn(config.cliCommand, args, {
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                ...(workingDirectory ? { cwd: workingDirectory } : {}),
                ...PLATFORM_SHELL_OPTS,
            });
            if (!child.pid)
                return { error: 'Failed to get process ID' };
            const pid = child.pid;
            pidRegistry.add(pid);
            child.unref();
            const initialStatus = {
                provider: config.name,
                jobId: jobMeta.jobId,
                slug: jobMeta.slug,
                status: 'spawned',
                pid,
                promptFile: jobMeta.promptFile,
                responseFile: jobMeta.responseFile,
                model: tryModel,
                agentRole: jobMeta.agentRole,
                spawnedAt: new Date().toISOString(),
            };
            writeJobStatus(initialStatus, workingDirectory);
            const collector = createStdoutCollector(MAX_STDOUT_BYTES);
            let stderr = '';
            let settled = false;
            const timeoutHandle = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    pidRegistry.delete(pid);
                    try {
                        if (process.platform !== 'win32')
                            process.kill(-pid, 'SIGTERM');
                        else
                            child.kill('SIGTERM');
                    }
                    catch { /* ignore */ }
                    writeJobStatus({
                        ...initialStatus,
                        status: 'timeout',
                        completedAt: new Date().toISOString(),
                        error: `${config.name} timed out after ${config.timeout}ms`,
                    }, workingDirectory);
                }
            }, config.timeout);
            child.stdout?.on('data', (data) => { collector.append(data.toString()); });
            child.stderr?.on('data', (data) => { stderr += data.toString(); });
            child.stdin?.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutHandle);
                writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Stdin write error: ${err.message}`,
                }, workingDirectory);
            });
            child.stdin?.write(fullPrompt);
            child.stdin?.end();
            writeJobStatus({ ...initialStatus, status: 'running' }, workingDirectory);
            /** Shared retry handler for retryable errors in close callback */
            const handleRetryable = (retryableErr) => {
                const isRateLimit = retryableErr.type === 'rate_limit';
                // Rate limit with explicit model: retry same model with backoff
                if (isRateLimit && modelExplicit && rlConfig && rateLimitAttempt < rlConfig.retryCount) {
                    const delay = computeBackoffDelay(rateLimitAttempt, rlConfig.initialDelay, rlConfig.maxDelay);
                    setTimeout(() => {
                        const retryResult = trySpawnWithModel(tryModel, remainingModels, rateLimitAttempt + 1);
                        if ('error' in retryResult) {
                            writeJobStatus({
                                ...initialStatus, status: 'failed', completedAt: new Date().toISOString(),
                                error: `Rate limit retry failed for model ${tryModel}: ${retryResult.error}`,
                            }, workingDirectory);
                        }
                    }, delay);
                    return;
                }
                // Fallback chain: try next model
                if (remainingModels.length > 0) {
                    const nextModel = remainingModels[0];
                    const newRemaining = remainingModels.slice(1);
                    const nextRlAttempt = isRateLimit ? rateLimitAttempt + 1 : rateLimitAttempt;
                    const doRetry = () => {
                        const retryResult = trySpawnWithModel(nextModel, newRemaining, nextRlAttempt);
                        if ('error' in retryResult) {
                            writeJobStatus({
                                ...initialStatus, status: 'failed', completedAt: new Date().toISOString(),
                                error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                            }, workingDirectory);
                        }
                    };
                    if (isRateLimit && rlConfig) {
                        setTimeout(doRetry, computeBackoffDelay(rateLimitAttempt, rlConfig.initialDelay, rlConfig.maxDelay));
                    }
                    else {
                        doRetry();
                    }
                    return;
                }
                // All models exhausted
                writeJobStatus({
                    ...initialStatus, status: 'failed', completedAt: new Date().toISOString(),
                    error: `All models in fallback chain failed. Last error (${retryableErr.type}): ${retryableErr.message}`,
                }, workingDirectory);
            };
            child.on('close', (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutHandle);
                pidRegistry.delete(pid);
                const stdout = collector.toString();
                // Respect user-initiated kill
                const currentStatus = readJobStatus(config.name, jobMeta.slug, jobMeta.jobId, workingDirectory);
                if (currentStatus?.killedByUser)
                    return;
                const hasOutput = code === 0 || !!stdout.trim();
                // Check for retryable errors (prioritize stdout when we have output)
                const retryable = hasOutput
                    ? config.isRetryableError(stdout, stderr)
                    : config.isRetryableError(stderr, stdout);
                if (retryable.isError) {
                    handleRetryable(retryable);
                    return;
                }
                if (hasOutput) {
                    const response = config.parseOutput(stdout);
                    const usedFallback = tryModel !== effectiveModel;
                    persistResponse({
                        provider: config.name,
                        agentRole: jobMeta.agentRole,
                        model: tryModel,
                        promptId: jobMeta.jobId,
                        slug: jobMeta.slug,
                        response,
                        workingDirectory,
                        usedFallback,
                        fallbackModel: usedFallback ? tryModel : undefined,
                    });
                    writeJobStatus({
                        ...initialStatus,
                        model: tryModel,
                        status: 'completed',
                        completedAt: new Date().toISOString(),
                        usedFallback: usedFallback || undefined,
                        fallbackModel: usedFallback ? tryModel : undefined,
                    }, workingDirectory);
                }
                else {
                    writeJobStatus({
                        ...initialStatus,
                        status: 'failed',
                        completedAt: new Date().toISOString(),
                        error: `${config.name} exited with code ${code}: ${stderr || 'No output'}`,
                    }, workingDirectory);
                }
            });
            child.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutHandle);
                writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Failed to spawn ${config.name} CLI: ${err.message}`,
                }, workingDirectory);
            });
            return { pid };
        };
        return trySpawnWithModel(modelsToTry[0], modelsToTry.slice(1));
    }
    catch (err) {
        return { error: `Failed to start background execution: ${err.message}` };
    }
}
/**
 * Generic tool handler for ask_codex / ask_gemini.
 *
 * Contains ALL the shared business logic: working-directory validation,
 * worktree boundary checks, agent-role validation, inline-prompt handling,
 * prompt-file resolution, CLI detection, system-prompt resolution,
 * file-context building, prompt persistence, background dispatch,
 * foreground execution with fallback, response persistence, and output-file writing.
 */
export async function handleAskProvider(config, pidRegistry, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return singleErrorBlock('Invalid request: args must be an object.');
    }
    const { agent_role, contextFiles, extra } = args;
    // Resolve model based on configuration and agent role
    const appConfig = loadConfig();
    const resolved = resolveExternalModel(appConfig.externalModels, {
        agentRole: agent_role,
        explicitProvider: config.name,
        explicitModel: args.model,
    });
    const fallbackChain = buildFallbackChain(config.name, resolved.model, appConfig.externalModels);
    const model = resolved.model || config.defaultModel;
    // ── Working directory validation ──────────────────────────────────────────
    let baseDir = args.working_directory || process.cwd();
    let baseDirReal;
    const pathPolicy = process.env.OMC_ALLOW_EXTERNAL_WORKDIR === '1' ? 'permissive' : 'strict';
    try {
        baseDirReal = realpathSync(baseDir);
        baseDir = baseDirReal;
    }
    catch (err) {
        return singleErrorBlock(`E_WORKDIR_INVALID: working_directory '${args.working_directory}' does not exist or is not accessible.\n` +
            `Error: ${err.message}\nResolved working directory: ${baseDir}\n` +
            `Path policy: ${pathPolicy}\nSuggested: ensure the working directory exists and is accessible`);
    }
    // Worktree boundary check
    if (pathPolicy === 'strict') {
        const worktreeRoot = getWorktreeRoot(baseDirReal);
        if (worktreeRoot) {
            let worktreeReal;
            try {
                worktreeReal = realpathSync(worktreeRoot);
            }
            catch {
                worktreeReal = '';
            }
            if (worktreeReal) {
                const relToWorktree = relative(worktreeReal, baseDirReal);
                if (relToWorktree.startsWith('..') || isAbsolute(relToWorktree)) {
                    return singleErrorBlock(`E_WORKDIR_INVALID: working_directory '${args.working_directory}' is outside the project worktree (${worktreeRoot}).\n` +
                        `Requested: ${args.working_directory}\nResolved working directory: ${baseDirReal}\n` +
                        `Worktree root: ${worktreeRoot}\nPath policy: ${pathPolicy}\n` +
                        `Suggested: use a working_directory within the project worktree, or set OMC_ALLOW_EXTERNAL_WORKDIR=1 to bypass`);
                }
            }
        }
    }
    // ── Agent role validation ─────────────────────────────────────────────────
    if (typeof agent_role !== 'string' || !agent_role.trim()) {
        return singleErrorBlock('agent_role is required and must be a non-empty string.');
    }
    if (!isValidAgentRoleName(agent_role)) {
        return singleErrorBlock(`Invalid agent_role: "${agent_role}". Role names must contain only lowercase letters, numbers, and hyphens. ` +
            `Recommended for ${config.name}: ${config.recommendedRoles.join(', ')}`);
    }
    if (!VALID_AGENT_ROLES.includes(agent_role)) {
        return singleErrorBlock(`Unknown agent_role: "${agent_role}". Available roles: ${VALID_AGENT_ROLES.join(', ')}. ` +
            `Recommended for ${config.name}: ${config.recommendedRoles.join(', ')}`);
    }
    // ── Inline prompt handling ────────────────────────────────────────────────
    const inlinePrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
    const hasPromptFileField = Object.prototype.hasOwnProperty.call(args, 'prompt_file') && args.prompt_file !== undefined;
    const promptFileInput = hasPromptFileField && typeof args.prompt_file === 'string'
        ? args.prompt_file.trim() || undefined : undefined;
    let resolvedPromptFile = promptFileInput;
    let resolvedOutputFile = typeof args.output_file === 'string' ? args.output_file : undefined;
    const hasInlineIntent = inlinePrompt !== undefined && !hasPromptFileField;
    const isInlineMode = hasInlineIntent && inlinePrompt.trim().length > 0;
    if (hasInlineIntent && !inlinePrompt?.trim()) {
        return singleErrorBlock('Inline prompt is empty. Provide a non-empty prompt string.');
    }
    const MAX_INLINE_PROMPT_BYTES = 256 * 1024;
    if (isInlineMode && Buffer.byteLength(inlinePrompt, 'utf-8') > MAX_INLINE_PROMPT_BYTES) {
        return singleErrorBlock(`Inline prompt exceeds maximum size (${MAX_INLINE_PROMPT_BYTES} bytes). Use prompt_file for large prompts.`);
    }
    if (isInlineMode && args.background) {
        return singleErrorBlock('Inline prompt mode is foreground only. Use prompt_file for background execution.');
    }
    if (hasPromptFileField && !promptFileInput) {
        return singleErrorBlock('prompt_file must be a non-empty string when provided. Received non-string or empty value.');
    }
    let inlineRequestId;
    if (isInlineMode) {
        inlineRequestId = generatePromptId();
        try {
            const promptsDir = getPromptsDir(baseDir);
            mkdirSync(promptsDir, { recursive: true });
            const slug = slugify(inlinePrompt);
            const inlinePromptFile = join(promptsDir, `${config.name}-inline-${slug}-${inlineRequestId}.md`);
            writeFileSync(inlinePromptFile, inlinePrompt, { encoding: 'utf-8', mode: 0o600 });
            resolvedPromptFile = inlinePromptFile;
            if (!resolvedOutputFile || !resolvedOutputFile.trim()) {
                resolvedOutputFile = join(promptsDir, `${config.name}-inline-response-${slug}-${inlineRequestId}.md`);
            }
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : 'unknown error';
            return singleErrorBlock(`Failed to persist inline prompt (${reason}). Check working directory permissions and disk space.`);
        }
    }
    const effectivePromptFile = resolvedPromptFile;
    if (!effectivePromptFile || !effectivePromptFile.trim()) {
        return singleErrorBlock("Either 'prompt' (inline) or 'prompt_file' (file path) is required.");
    }
    const effectiveOutputFile = resolvedOutputFile;
    if (!effectiveOutputFile || !effectiveOutputFile.trim()) {
        return singleErrorBlock('output_file is required. Specify a path where the response should be written.');
    }
    // ── Prompt file resolution ────────────────────────────────────────────────
    let resolvedPrompt;
    const promptFile = effectivePromptFile;
    const resolvedPath = resolve(baseDir, promptFile);
    const cwdReal = realpathSync(baseDir);
    const relPath = relative(cwdReal, resolvedPath);
    if (!isExternalPromptAllowed() && (relPath === '..' || relPath.startsWith('..' + sep) || isAbsolute(relPath))) {
        return singleErrorBlock(`E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${promptFile}' resolves outside working_directory '${baseDirReal}'.\n` +
            `Requested: ${promptFile}\nWorking directory: ${baseDirReal}\nResolved working directory: ${baseDirReal}\n` +
            `Path policy: ${pathPolicy}\nSuggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
    }
    let resolvedReal;
    try {
        resolvedReal = realpathSync(resolvedPath);
    }
    catch (err) {
        return singleErrorBlock(`E_PATH_RESOLUTION_FAILED: Failed to resolve prompt_file '${promptFile}'.\n` +
            `Error: ${err.message}\nResolved working directory: ${baseDirReal}\n` +
            `Path policy: ${pathPolicy}\nSuggested: ensure the prompt file exists and is accessible`);
    }
    const relReal = relative(cwdReal, resolvedReal);
    if (!isExternalPromptAllowed() && (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal))) {
        return singleErrorBlock(`E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${promptFile}' resolves to a path outside working_directory '${baseDirReal}'.\n` +
            `Requested: ${promptFile}\nResolved path: ${resolvedReal}\nWorking directory: ${baseDirReal}\n` +
            `Resolved working directory: ${baseDirReal}\nPath policy: ${pathPolicy}\n` +
            `Suggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
    }
    try {
        resolvedPrompt = readFileSync(resolvedReal, 'utf-8');
    }
    catch (err) {
        return singleErrorBlock(`Failed to read prompt_file '${promptFile}': ${err.message}`);
    }
    if (!resolvedPrompt.trim()) {
        return singleErrorBlock(`prompt_file '${promptFile}' is empty.`);
    }
    // ── Build full prompt ─────────────────────────────────────────────────────
    const userPrompt = `[HEADLESS SESSION] You are running non-interactively in a headless pipeline. Produce your FULL, comprehensive analysis directly in your response. Do NOT ask for clarification or confirmation - work thoroughly with all provided context. Do NOT write brief acknowledgments - your response IS the deliverable.\n\n${resolvedPrompt}`;
    const detection = config.detectCli();
    if (!detection.available) {
        return singleErrorBlock(`${config.name} CLI is not available: ${detection.error}\n\n${detection.installHint}`);
    }
    const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role, config.name);
    let fileContext;
    if (contextFiles && contextFiles.length > 0) {
        fileContext = contextFiles.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
    }
    const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);
    const promptResult = persistPrompt({
        provider: config.name,
        agentRole: agent_role,
        model,
        files: contextFiles,
        prompt: resolvedPrompt,
        fullPrompt,
        workingDirectory: baseDir,
    });
    const expectedResponsePath = promptResult
        ? getExpectedResponsePath(config.name, promptResult.slug, promptResult.id, baseDir)
        : undefined;
    // ── Background mode ───────────────────────────────────────────────────────
    if (args.background) {
        if (!promptResult) {
            return singleErrorBlock('Failed to persist prompt for background execution');
        }
        const statusFilePath = getStatusFilePath(config.name, promptResult.slug, promptResult.id, baseDir);
        const result = executeCliBackground(config, pidRegistry, fullPrompt, args.model, {
            provider: config.name,
            jobId: promptResult.id,
            slug: promptResult.slug,
            agentRole: agent_role,
            model,
            promptFile: promptResult.filePath,
            responseFile: expectedResponsePath,
        }, baseDir, extra);
        if ('error' in result) {
            return singleErrorBlock(`Failed to spawn background job: ${result.error}`);
        }
        const bgLines = [
            `**Mode:** Background (non-blocking)`,
            `**Job ID:** ${promptResult.id}`,
            `**Agent Role:** ${agent_role}`,
            `**Model:** ${model}`,
            fallbackChain.length > 1 ? `**Fallback chain:** ${fallbackChain.join(' -> ')}` : null,
            `**PID:** ${result.pid}`,
            `**Prompt File:** ${promptResult.filePath}`,
            `**Response File:** ${expectedResponsePath}`,
            `**Status File:** ${statusFilePath}`,
            ``,
            `Job dispatched. Check response file or status file for completion.`,
        ].filter(Boolean);
        return { content: [{ type: 'text', text: bgLines.join('\n') }] };
    }
    // ── Foreground execution ──────────────────────────────────────────────────
    const paramLines = [
        `**Agent Role:** ${agent_role}`,
        ...(args.extraParamLines || []),
        contextFiles?.length ? `**Files:** ${contextFiles.join(', ')}` : null,
        promptResult ? `**Prompt File:** ${promptResult.filePath}` : null,
        expectedResponsePath ? `**Response File:** ${expectedResponsePath}` : null,
        `**Resolved Working Directory:** ${baseDirReal}`,
        `**Path Policy:** ${pathPolicy}`,
    ].filter(Boolean).join('\n');
    try {
        const { response, usedFallback, actualModel } = await executeCliWithFallback(config, fullPrompt, args.model, baseDir, fallbackChain, extra);
        if (promptResult) {
            persistResponse({
                provider: config.name,
                agentRole: agent_role,
                model: actualModel,
                promptId: promptResult.id,
                slug: promptResult.slug,
                response,
                workingDirectory: baseDir,
                usedFallback,
                fallbackModel: usedFallback ? actualModel : undefined,
            });
        }
        if (effectiveOutputFile) {
            const writeResult = safeWriteOutputFile(effectiveOutputFile, response, baseDirReal, `[${config.name}-core]`);
            if (!writeResult.success) {
                return singleErrorBlock(`${paramLines}\n\n---\n\n${writeResult.errorMessage}\n\nresolved_working_directory: ${baseDirReal}\npath_policy: ${pathPolicy}`);
            }
        }
        const responseLines = [paramLines];
        if (usedFallback)
            responseLines.push(`Fallback: used model ${actualModel}`);
        if (isInlineMode) {
            responseLines.push(`**Request ID:** ${inlineRequestId}`);
            const metadataText = responseLines.join('\n');
            const wrappedResponse = wrapUntrustedCliResponse(response, {
                source: 'inline-cli-response',
                tool: `ask_${config.name}`,
            });
            return inlineSuccessBlocks(metadataText, wrappedResponse);
        }
        return { content: [{ type: 'text', text: responseLines.join('\n') }] };
    }
    catch (err) {
        return singleErrorBlock(`${paramLines}\n\n---\n\n${config.name} CLI error: ${err.message}`);
    }
}
//# sourceMappingURL=provider-core.js.map