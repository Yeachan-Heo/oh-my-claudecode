import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generatePromptId, slugify } from './prompt-persistence.js';

/**
 * Normalize ask_codex arguments so background executions always use prompt_file mode.
 *
 * Contract enforced at call-site:
 * - foreground: inline prompt mode is allowed
 * - background: prompt_file mode only
 *
 * For explicit natural-language invocations (background + inline prompt, no prompt_file),
 * this helper deterministically persists the inline prompt and injects prompt_file/output_file.
 */
export function normalizeCodexAskArgsForCallSite(rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? { ...rawArgs }
        : {};
    const hasPromptFileField = Object.prototype.hasOwnProperty.call(args, 'prompt_file') && args.prompt_file !== undefined;
    const inlinePrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
    const hasInlineIntent = inlinePrompt !== undefined && !hasPromptFileField;
    const isInlineMode = hasInlineIntent && inlinePrompt.trim().length > 0;
    if (!args.background || !isInlineMode) {
        return args;
    }
    const workingDirectoryInput = typeof args.working_directory === 'string' && args.working_directory.trim()
        ? args.working_directory
        : process.cwd();
    let workingDirectory;
    try {
        // If workdir is invalid, let core validation return the canonical E_WORKDIR_INVALID error.
        workingDirectory = realpathSync(workingDirectoryInput);
    }
    catch {
        return args;
    }
    const promptsDir = join(workingDirectory, '.omc', 'prompts');
    try {
        mkdirSync(promptsDir, { recursive: true });
        const requestId = generatePromptId();
        const slug = slugify(inlinePrompt);
        const promptFile = join(promptsDir, `codex-inline-bg-${slug}-${requestId}.md`);
        writeFileSync(promptFile, inlinePrompt, { encoding: 'utf-8', mode: 0o600 });
        const outputFile = (typeof args.output_file === 'string' && args.output_file.trim())
            ? args.output_file
            : join(promptsDir, `codex-inline-bg-response-${slug}-${requestId}.md`);
        const { prompt: _inlinePrompt, ...rest } = args;
        return {
            ...rest,
            working_directory: workingDirectory,
            prompt_file: promptFile,
            output_file: outputFile,
        };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to persist inline prompt for background execution: ${reason}`);
    }
}
