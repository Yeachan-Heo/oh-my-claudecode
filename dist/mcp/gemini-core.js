/**
 * Gemini Core Business Logic - Shared between SDK and Standalone MCP servers
 *
 * This module contains all the business logic for Gemini CLI integration:
 * - Constants and configuration
 * - CLI execution with timeout handling
 * - File validation and reading
 * - Complete tool handler logic with role validation, fallback chain, etc.
 *
 * This module is SDK-agnostic and can be imported by both:
 * - gemini-server.ts (in-process SDK MCP server)
 * - gemini-standalone-server.ts (stdio-based external process server)
 */
import { spawn } from 'child_process';
import { readFileSync, realpathSync, statSync } from 'fs';
import { resolve, relative, sep, isAbsolute } from 'path';
import { createStdoutCollector, safeWriteOutputFile } from './shared-exec.js';
import { detectGeminiCli } from './cli-detection.js';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { isExternalPromptAllowed } from './mcp-config.js';
import { resolveSystemPrompt, buildPromptWithSystemContext, wrapUntrustedFileContent, isValidAgentRoleName, VALID_AGENT_ROLES } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath, readJobStatus } from './prompt-persistence.js';
import { resolveExternalModel, buildFallbackChain, GEMINI_MODEL_FALLBACKS, } from '../features/model-routing/external-model-policy.js';
import { loadConfig } from '../config/loader.js';
// Module-scoped PID registry - tracks PIDs spawned by this process
const spawnedPids = new Set();
export function isSpawnedPid(pid) {
    return spawnedPids.has(pid);
}
export function clearSpawnedPids() {
    spawnedPids.clear();
}
// Model name validation: alphanumeric start, then alphanumeric/dots/hyphens/underscores, max 64 chars
const MODEL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function validateModelName(model) {
    if (!MODEL_NAME_REGEX.test(model)) {
        throw new Error(`Invalid model name: "${model}". Model names must match pattern: alphanumeric start, followed by alphanumeric, dots, hyphens, or underscores (max 64 chars).`);
    }
}
// Default model can be overridden via environment variable
export const GEMINI_DEFAULT_MODEL = process.env.OMC_GEMINI_DEFAULT_MODEL || 'gemini-3-pro-preview';
export const GEMINI_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_GEMINI_TIMEOUT || '3600000', 10) || 3600000), 3600000);
// Gemini is best for design review and implementation tasks (recommended, not enforced)
export const GEMINI_RECOMMENDED_ROLES = ['designer', 'writer', 'vision'];
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB stdout cap
/**
 * Check if Gemini output/stderr indicates a rate-limit (429) or quota error
 * that should trigger a fallback to the next model in the chain.
 */
export function isGeminiRetryableError(stdout, stderr = '') {
    const combined = `${stdout}\n${stderr}`;
    // Check for model not found / not supported
    if (/model.?not.?found|model is not supported|model.+does not exist|not.+available/i.test(combined)) {
        const match = combined.match(/.*(?:model.?not.?found|model is not supported|model.+does not exist|not.+available).*/i);
        return { isError: true, message: match?.[0]?.trim() || 'Model not available', type: 'model' };
    }
    // Check for 429/rate limit errors
    if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(combined)) {
        const match = combined.match(/.*(?:429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted).*/i);
        return { isError: true, message: match?.[0]?.trim() || 'Rate limit error detected', type: 'rate_limit' };
    }
    return { isError: false, message: '', type: 'none' };
}
/**
 * Execute Gemini CLI command and return the response
 */
export function executeGemini(prompt, model, cwd) {
    return new Promise((resolve, reject) => {
        if (model)
            validateModelName(model);
        let settled = false;
        const args = ['-p=.', '--yolo'];
        if (model) {
            args.push('--model', model);
        }
        const child = spawn('gemini', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
            // shell: true needed on Windows for .cmd/.bat executables.
            // Safe: args are array-based and model names are regex-validated.
            ...(process.platform === 'win32' ? { shell: true } : {})
        });
        const timeoutHandle = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
                reject(new Error(`Gemini timed out after ${GEMINI_TIMEOUT}ms`));
            }
        }, GEMINI_TIMEOUT);
        const collector = createStdoutCollector(MAX_STDOUT_BYTES);
        let stderr = '';
        child.stdout.on('data', (data) => {
            collector.append(data.toString());
        });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('close', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                const stdout = collector.toString();
                if (code === 0 || stdout.trim()) {
                    // Check for retryable errors even on "successful" exit
                    const retryable = isGeminiRetryableError(stdout, stderr);
                    if (retryable.isError) {
                        reject(new Error(`Gemini ${retryable.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryable.message}`));
                    }
                    else {
                        resolve(stdout.trim());
                    }
                }
                else {
                    // Check stderr for rate limit errors before generic failure
                    const retryableExit = isGeminiRetryableError(stderr, stdout);
                    if (retryableExit.isError) {
                        reject(new Error(`Gemini ${retryableExit.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryableExit.message}`));
                    }
                    else {
                        reject(new Error(`Gemini exited with code ${code}: ${stderr || 'No output'}`));
                    }
                }
            }
        });
        child.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                child.kill('SIGTERM');
                reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
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
/**
 * Execute Gemini CLI in background with fallback chain support
 * Retries with next model on model errors and 429/rate-limit errors
 */
export function executeGeminiBackground(fullPrompt, modelInput, jobMeta, workingDirectory) {
    try {
        const modelExplicit = modelInput !== undefined && modelInput !== null && modelInput !== '';
        const effectiveModel = modelInput || GEMINI_DEFAULT_MODEL;
        // Build fallback chain
        const modelsToTry = modelExplicit
            ? [effectiveModel] // No fallback if model explicitly provided
            : (GEMINI_MODEL_FALLBACKS.includes(effectiveModel)
                ? GEMINI_MODEL_FALLBACKS.slice(GEMINI_MODEL_FALLBACKS.indexOf(effectiveModel))
                : [effectiveModel, ...GEMINI_MODEL_FALLBACKS]);
        // Helper to try spawning with a specific model
        const trySpawnWithModel = (tryModel, remainingModels) => {
            validateModelName(tryModel);
            const args = ['-p=.', '--yolo', '--model', tryModel];
            const child = spawn('gemini', args, {
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                ...(workingDirectory ? { cwd: workingDirectory } : {}),
                ...(process.platform === 'win32' ? { shell: true } : {})
            });
            if (!child.pid) {
                return { error: 'Failed to get process ID' };
            }
            const pid = child.pid;
            spawnedPids.add(pid);
            child.unref();
            const initialStatus = {
                provider: 'gemini',
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
                    try {
                        if (process.platform !== 'win32')
                            process.kill(-pid, 'SIGTERM');
                        else
                            child.kill('SIGTERM');
                    }
                    catch {
                        // ignore
                    }
                    writeJobStatus({
                        ...initialStatus,
                        status: 'timeout',
                        completedAt: new Date().toISOString(),
                        error: `Gemini timed out after ${GEMINI_TIMEOUT}ms`,
                    }, workingDirectory);
                }
            }, GEMINI_TIMEOUT);
            child.stdout?.on('data', (data) => {
                collector.append(data.toString());
            });
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
            child.on('close', (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutHandle);
                spawnedPids.delete(pid);
                const stdout = collector.toString();
                // Check if user killed this job
                const currentStatus = readJobStatus('gemini', jobMeta.slug, jobMeta.jobId, workingDirectory);
                if (currentStatus?.killedByUser) {
                    return;
                }
                if (code === 0 || stdout.trim()) {
                    // Check for retryable errors (model errors + rate limit/429)
                    const retryableErr = isGeminiRetryableError(stdout, stderr);
                    if (retryableErr.isError && remainingModels.length > 0) {
                        const nextModel = remainingModels[0];
                        const newRemainingModels = remainingModels.slice(1);
                        const retryResult = trySpawnWithModel(nextModel, newRemainingModels);
                        if ('error' in retryResult) {
                            writeJobStatus({
                                ...initialStatus,
                                status: 'failed',
                                completedAt: new Date().toISOString(),
                                error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                            }, workingDirectory);
                        }
                        return;
                    }
                    if (retryableErr.isError) {
                        writeJobStatus({
                            ...initialStatus,
                            status: 'failed',
                            completedAt: new Date().toISOString(),
                            error: `All models in fallback chain failed. Last error (${retryableErr.type}): ${retryableErr.message}`,
                        }, workingDirectory);
                        return;
                    }
                    const response = stdout.trim();
                    const usedFallback = tryModel !== effectiveModel;
                    persistResponse({
                        provider: 'gemini',
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
                    // Check if the failure is a retryable error before giving up
                    const retryableExit = isGeminiRetryableError(stderr, stdout);
                    if (retryableExit.isError && remainingModels.length > 0) {
                        const nextModel = remainingModels[0];
                        const newRemainingModels = remainingModels.slice(1);
                        const retryResult = trySpawnWithModel(nextModel, newRemainingModels);
                        if ('error' in retryResult) {
                            writeJobStatus({
                                ...initialStatus,
                                status: 'failed',
                                completedAt: new Date().toISOString(),
                                error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                            }, workingDirectory);
                        }
                        return;
                    }
                    writeJobStatus({
                        ...initialStatus,
                        status: 'failed',
                        completedAt: new Date().toISOString(),
                        error: `Gemini exited with code ${code}: ${stderr || 'No output'}`,
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
                    error: `Failed to spawn Gemini CLI: ${err.message}`,
                }, workingDirectory);
            });
            return { pid };
        };
        // Start execution with the first model in the chain
        return trySpawnWithModel(modelsToTry[0], modelsToTry.slice(1));
    }
    catch (err) {
        return { error: `Failed to start background execution: ${err.message}` };
    }
}
/**
 * Validate and read a file for context inclusion
 */
export function validateAndReadFile(filePath, baseDir) {
    if (typeof filePath !== 'string') {
        return `--- File: ${filePath} --- (Invalid path type)`;
    }
    try {
        const resolvedAbs = resolve(baseDir || process.cwd(), filePath);
        // Security: ensure file is within working directory (worktree boundary)
        const cwd = baseDir || process.cwd();
        const cwdReal = realpathSync(cwd);
        const relAbs = relative(cwdReal, resolvedAbs);
        if (relAbs === '..' || relAbs.startsWith('..' + sep) || isAbsolute(relAbs)) {
            return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
        }
        // Symlink-safe check: ensure the real path also stays inside the boundary.
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
/**
 * Handle ask_gemini tool request - contains ALL business logic
 *
 * This function is called by both the SDK server and standalone server.
 * It performs:
 * - Agent role validation
 * - CLI detection
 * - System prompt resolution
 * - File context building
 * - Full prompt assembly
 * - Fallback chain execution
 * - Error handling
 *
 * @returns MCP-compatible response with content array
 */
export async function handleAskGemini(args) {
    const { agent_role, files } = args;
    // Resolve model based on configuration and agent role
    const config = loadConfig();
    const resolved = resolveExternalModel(config.externalModels, {
        agentRole: agent_role,
        explicitProvider: 'gemini',
        explicitModel: args.model, // user explicitly passed model
    });
    const resolvedModel = resolved.model;
    // Derive baseDir from working_directory if provided
    let baseDir = args.working_directory || process.cwd();
    let baseDirReal;
    // Path policy for error messages
    const pathPolicy = process.env.OMC_ALLOW_EXTERNAL_WORKDIR === '1' ? 'permissive' : 'strict';
    try {
        baseDirReal = realpathSync(baseDir);
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `E_WORKDIR_INVALID: working_directory '${args.working_directory}' does not exist or is not accessible.\nError: ${err.message}\nResolved working directory: ${baseDir}\nPath policy: ${pathPolicy}\nSuggested: ensure the working directory exists and is accessible` }],
            isError: true
        };
    }
    // Security: validate working_directory is within worktree (unless bypass enabled)
    if (process.env.OMC_ALLOW_EXTERNAL_WORKDIR !== '1') {
        const worktreeRoot = getWorktreeRoot(baseDirReal);
        if (worktreeRoot) {
            let worktreeReal;
            try {
                worktreeReal = realpathSync(worktreeRoot);
            }
            catch {
                // If worktree root can't be resolved, skip boundary check rather than break
                worktreeReal = '';
            }
            if (worktreeReal) {
                const relToWorktree = relative(worktreeReal, baseDirReal);
                if (relToWorktree.startsWith('..') || isAbsolute(relToWorktree)) {
                    return {
                        content: [{
                                type: 'text',
                                text: `E_WORKDIR_INVALID: working_directory '${args.working_directory}' is outside the project worktree (${worktreeRoot}).\nRequested: ${args.working_directory}\nResolved working directory: ${baseDirReal}\nWorktree root: ${worktreeRoot}\nPath policy: ${pathPolicy}\nSuggested: use a working_directory within the project worktree, or set OMC_ALLOW_EXTERNAL_WORKDIR=1 to bypass`
                            }],
                        isError: true
                    };
                }
            }
        }
    }
    // Validate agent_role - must be non-empty and pass character validation
    if (!agent_role || !agent_role.trim()) {
        return {
            content: [{
                    type: 'text',
                    text: `agent_role is required. Recommended roles for Gemini: ${GEMINI_RECOMMENDED_ROLES.join(', ')}`
                }],
            isError: true
        };
    }
    if (!isValidAgentRoleName(agent_role)) {
        return {
            content: [{
                    type: 'text',
                    text: `Invalid agent_role: "${agent_role}". Role names must contain only lowercase letters, numbers, and hyphens. Recommended for Gemini: ${GEMINI_RECOMMENDED_ROLES.join(', ')}`
                }],
            isError: true
        };
    }
    // Validate agent_role exists in discovered roles (allowlist enforcement)
    if (!VALID_AGENT_ROLES.includes(agent_role)) {
        return {
            content: [{
                    type: 'text',
                    text: `Unknown agent_role: "${agent_role}". Available roles: ${VALID_AGENT_ROLES.join(', ')}. Recommended for Gemini: ${GEMINI_RECOMMENDED_ROLES.join(', ')}`
                }],
            isError: true
        };
    }
    // Validate output_file is provided
    if (!args.output_file || !args.output_file.trim()) {
        return {
            content: [{ type: 'text', text: 'output_file is required. Specify a path where the response should be written.' }],
            isError: true
        };
    }
    // Check if old 'prompt' parameter is used (hard error)
    if ('prompt' in args) {
        return {
            content: [{ type: 'text', text: "The 'prompt' parameter has been removed. Write the prompt to a file (recommended: .omc/prompts/) and pass 'prompt_file' instead." }],
            isError: true
        };
    }
    // Validate prompt_file is provided
    if (!args.prompt_file || !args.prompt_file.trim()) {
        return {
            content: [{ type: 'text', text: 'prompt_file is required.' }],
            isError: true
        };
    }
    // Resolve prompt from prompt_file
    let resolvedPrompt;
    const resolvedPath = resolve(baseDir, args.prompt_file);
    const cwdReal = realpathSync(baseDir);
    const relPath = relative(cwdReal, resolvedPath);
    if (!isExternalPromptAllowed() && (relPath === '..' || relPath.startsWith('..' + sep) || isAbsolute(relPath))) {
        return {
            content: [{
                    type: 'text',
                    text: `E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${args.prompt_file}' resolves outside working_directory '${baseDirReal}'.\nRequested: ${args.prompt_file}\nWorking directory: ${baseDirReal}\nResolved working directory: ${baseDirReal}\nPath policy: ${pathPolicy}\nSuggested: place the prompt file within the working directory or set working_directory to a common ancestor`
                }],
            isError: true
        };
    }
    // Symlink-safe check: resolve and validate BEFORE reading
    let resolvedReal;
    try {
        resolvedReal = realpathSync(resolvedPath);
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Failed to resolve prompt_file '${args.prompt_file}': ${err.message}` }],
            isError: true
        };
    }
    const relReal = relative(cwdReal, resolvedReal);
    if (!isExternalPromptAllowed() && (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal))) {
        return {
            content: [{
                    type: 'text',
                    text: `E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${args.prompt_file}' resolves to a path outside working_directory '${baseDirReal}'.\nRequested: ${args.prompt_file}\nResolved path: ${resolvedReal}\nWorking directory: ${baseDirReal}\nResolved working directory: ${baseDirReal}\nPath policy: ${pathPolicy}\nSuggested: place the prompt file within the working directory or set working_directory to a common ancestor`
                }],
            isError: true
        };
    }
    // Now safe to read from the validated real path
    try {
        resolvedPrompt = readFileSync(resolvedReal, 'utf-8');
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Failed to read prompt_file '${args.prompt_file}': ${err.message}` }],
            isError: true
        };
    }
    // Check for empty prompt
    if (!resolvedPrompt.trim()) {
        return {
            content: [{ type: 'text', text: `prompt_file '${args.prompt_file}' is empty.` }],
            isError: true
        };
    }
    // Add headless execution context so Gemini produces comprehensive output
    const userPrompt = `[HEADLESS SESSION] You are running non-interactively in a headless pipeline. Produce your FULL, comprehensive analysis directly in your response. Do NOT ask for clarification or confirmation - work thoroughly with all provided context. Do NOT write brief acknowledgments - your response IS the deliverable.

${resolvedPrompt}`;
    // Check CLI availability
    const detection = detectGeminiCli();
    if (!detection.available) {
        return {
            content: [{
                    type: 'text',
                    text: `Gemini CLI is not available: ${detection.error}\n\n${detection.installHint}`
                }],
            isError: true
        };
    }
    // Resolve system prompt from agent role
    const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role);
    // Build file context
    let fileContext;
    if (files && files.length > 0) {
        fileContext = files.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
    }
    // Combine: system prompt > file context > user prompt
    const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);
    // Persist prompt for audit trail (once, before fallback loop)
    const promptResult = persistPrompt({
        provider: 'gemini',
        agentRole: agent_role,
        model: resolvedModel,
        files,
        prompt: resolvedPrompt,
        fullPrompt,
        workingDirectory: baseDir,
    });
    // Compute expected response path for immediate return
    const expectedResponsePath = promptResult
        ? getExpectedResponsePath('gemini', promptResult.slug, promptResult.id, baseDir)
        : undefined;
    // Background mode: return immediately with job metadata
    if (args.background) {
        if (!promptResult) {
            return {
                content: [{ type: 'text', text: 'Failed to persist prompt for background execution' }],
                isError: true
            };
        }
        const statusFilePath = getStatusFilePath('gemini', promptResult.slug, promptResult.id, baseDir);
        // Build fallback chain for display (executeGeminiBackground builds its own internally)
        const fallbackChainBg = buildFallbackChain('gemini', resolvedModel, config.externalModels);
        const result = executeGeminiBackground(fullPrompt, args.model, {
            provider: 'gemini',
            jobId: promptResult.id,
            slug: promptResult.slug,
            agentRole: agent_role,
            model: resolvedModel,
            promptFile: promptResult.filePath,
            responseFile: expectedResponsePath,
        }, baseDir);
        if ('error' in result) {
            return {
                content: [{ type: 'text', text: `Failed to spawn background job: ${result.error}` }],
                isError: true
            };
        }
        return {
            content: [{
                    type: 'text',
                    text: [
                        `**Mode:** Background (non-blocking)`,
                        `**Job ID:** ${promptResult.id}`,
                        `**Agent Role:** ${agent_role}`,
                        `**Model (attempting):** ${fallbackChainBg[0]}`,
                        `**Fallback chain:** ${fallbackChainBg.join(' -> ')}`,
                        `**PID:** ${result.pid}`,
                        `**Prompt File:** ${promptResult.filePath}`,
                        `**Response File:** ${expectedResponsePath}`,
                        `**Status File:** ${statusFilePath}`,
                        ``,
                        `Job dispatched. Will automatically try fallback models on 429/rate-limit or model errors.`,
                    ].join('\n')
                }]
        };
    }
    // Build parameter visibility block
    const paramLines = [
        `**Agent Role:** ${agent_role}`,
        files?.length ? `**Files:** ${files.join(', ')}` : null,
        promptResult ? `**Prompt File:** ${promptResult.filePath}` : null,
        expectedResponsePath ? `**Response File:** ${expectedResponsePath}` : null,
    ].filter(Boolean).join('\n');
    // Build fallback chain using the resolver
    const fallbackChain = buildFallbackChain('gemini', resolvedModel, config.externalModels);
    let resolvedOutputPath;
    if (args.output_file) {
        resolvedOutputPath = resolve(baseDirReal, args.output_file);
    }
    const errors = [];
    for (const tryModel of fallbackChain) {
        try {
            const response = await executeGemini(fullPrompt, tryModel, baseDir);
            const usedFallback = tryModel !== resolvedModel;
            const fallbackNote = usedFallback ? `[Fallback: used ${tryModel} instead of ${resolvedModel}]\n\n` : '';
            // Persist response to disk (audit trail)
            if (promptResult) {
                persistResponse({
                    provider: 'gemini',
                    agentRole: agent_role,
                    model: tryModel,
                    promptId: promptResult.id,
                    slug: promptResult.slug,
                    response,
                    usedFallback,
                    fallbackModel: usedFallback ? tryModel : undefined,
                    workingDirectory: baseDir,
                });
            }
            // Always write response to output_file.
            if (args.output_file && resolvedOutputPath) {
                const writeResult = safeWriteOutputFile(args.output_file, response, baseDirReal, '[gemini-core]');
                if (!writeResult.success) {
                    return {
                        content: [{
                                type: 'text',
                                text: `${fallbackNote}${paramLines}\n\n---\n\n${writeResult.errorMessage}\n\nresolved_working_directory: ${baseDirReal}\npath_policy: ${pathPolicy}`
                            }],
                        isError: true
                    };
                }
            }
            // Build success response with metadata for path policy transparency
            const responseLines = [
                `${fallbackNote}${paramLines}`,
                `**Resolved Working Directory:** ${baseDirReal}`,
                `**Path Policy:** OMC_ALLOW_EXTERNAL_WORKDIR=${process.env.OMC_ALLOW_EXTERNAL_WORKDIR || '0 (enforced)'}`,
            ];
            return {
                content: [{
                        type: 'text',
                        text: responseLines.join('\n')
                    }]
            };
        }
        catch (err) {
            const errMsg = err.message;
            errors.push(`${tryModel}: ${errMsg}`);
            // Only retry on retryable errors (model not found, 429/rate limit)
            if (!/model error|model.?not.?found|model is not supported|429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(errMsg)) {
                // Non-retryable error — stop immediately
                return {
                    content: [{
                            type: 'text',
                            text: `${paramLines}\n\n---\n\nGemini CLI error: ${errMsg}`
                        }],
                    isError: true
                };
            }
            // Continue to next model in chain
        }
    }
    return {
        content: [{
                type: 'text',
                text: `${paramLines}\n\n---\n\nGemini CLI error: all models in fallback chain failed.\n${errors.join('\n')}`
            }],
        isError: true
    };
}
//# sourceMappingURL=gemini-core.js.map