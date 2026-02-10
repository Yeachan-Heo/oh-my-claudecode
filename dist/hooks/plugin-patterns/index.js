/**
 * Popular Plugin Patterns
 *
 * Common hook patterns from the Claude Code community:
 * - Auto-format on file save
 * - Lint validation before commit
 * - Commit message validation
 * - Test runner before commit
 * - Type checking enforcement
 */
import { existsSync, readFileSync } from 'fs';
import { join, extname, normalize, isAbsolute } from 'path';
import { execSync } from 'child_process';
// =============================================================================
// SECURITY UTILITIES
// =============================================================================
/**
 * Validate file path for security
 * Blocks shell metacharacters and path traversal attempts
 */
export function isValidFilePath(filePath) {
    // Block shell metacharacters (sync with DANGEROUS_SHELL_CHARS but add \t)
    if (/[;&|`$()<>{}[\]*?~!#\n\r\t\0\\]/.test(filePath))
        return false;
    // Block path traversal
    const normalized = normalize(filePath);
    if (normalized.includes('..') || isAbsolute(normalized))
        return false;
    return true;
}
const DEFAULT_FORMATTERS = {
    '.ts': 'prettier --write',
    '.tsx': 'prettier --write',
    '.js': 'prettier --write',
    '.jsx': 'prettier --write',
    '.json': 'prettier --write',
    '.css': 'prettier --write',
    '.scss': 'prettier --write',
    '.md': 'prettier --write',
    '.py': 'black',
    '.go': 'gofmt -w',
    '.rs': 'rustfmt'
};
/**
 * Get formatter command for a file extension
 */
export function getFormatter(ext) {
    return DEFAULT_FORMATTERS[ext] || null;
}
/**
 * Check if a formatter is available
 */
export function isFormatterAvailable(command) {
    try {
        const binary = command.split(' ')[0];
        const checkCommand = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${checkCommand} ${binary}`, { encoding: 'utf-8', stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Format a file using the appropriate formatter
 */
export function formatFile(filePath) {
    // Validate file path for security
    if (!isValidFilePath(filePath)) {
        return { success: false, message: 'Invalid file path: contains unsafe characters or path traversal' };
    }
    const ext = extname(filePath);
    const formatter = getFormatter(ext);
    if (!formatter) {
        return { success: true, message: `No formatter configured for ${ext}` };
    }
    if (!isFormatterAvailable(formatter)) {
        return { success: true, message: `Formatter ${formatter} not available` };
    }
    try {
        execSync(`${formatter} "${filePath}"`, { encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, message: `Formatted ${filePath}` };
    }
    catch (_error) {
        return { success: false, message: `Format failed: ${_error}` };
    }
}
const DEFAULT_LINTERS = {
    '.ts': 'eslint --fix',
    '.tsx': 'eslint --fix',
    '.js': 'eslint --fix',
    '.jsx': 'eslint --fix',
    '.py': 'ruff check --fix',
    '.go': 'golangci-lint run',
    '.rs': 'cargo clippy'
};
/**
 * Get linter command for a file extension
 */
export function getLinter(ext) {
    return DEFAULT_LINTERS[ext] || null;
}
/**
 * Run linter on a file
 */
export function lintFile(filePath) {
    // Validate file path for security
    if (!isValidFilePath(filePath)) {
        return { success: false, message: 'Invalid file path: contains unsafe characters or path traversal' };
    }
    const ext = extname(filePath);
    const linter = getLinter(ext);
    if (!linter) {
        return { success: true, message: `No linter configured for ${ext}` };
    }
    try {
        const binary = linter.split(' ')[0];
        const checkCommand = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${checkCommand} ${binary}`, { encoding: 'utf-8', stdio: 'pipe' });
    }
    catch {
        return { success: true, message: `Linter ${linter} not available` };
    }
    try {
        execSync(`${linter} "${filePath}"`, { encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, message: `Lint passed for ${filePath}` };
    }
    catch (_error) {
        return { success: false, message: `Lint errors in ${filePath}` };
    }
}
const DEFAULT_COMMIT_TYPES = [
    'feat', // New feature
    'fix', // Bug fix
    'docs', // Documentation
    'style', // Formatting, no code change
    'refactor', // Refactoring
    'perf', // Performance improvement
    'test', // Adding tests
    'build', // Build system changes
    'ci', // CI configuration
    'chore', // Maintenance
    'revert' // Revert previous commit
];
const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?(!)?:\s.+$/;
/**
 * Validate a commit message against conventional commit format
 */
export function validateCommitMessage(message, config) {
    const errors = [];
    const lines = message.trim().split('\n');
    const subject = lines[0];
    // Check subject line
    if (!subject) {
        errors.push('Commit message cannot be empty');
        return { valid: false, errors };
    }
    // Check conventional commit format
    if (!CONVENTIONAL_COMMIT_REGEX.test(subject)) {
        errors.push('Subject must follow conventional commit format: type(scope?): description');
        errors.push(`Allowed types: ${DEFAULT_COMMIT_TYPES.join(', ')}`);
    }
    // Check subject length
    const maxLength = config?.maxSubjectLength || 72;
    if (subject.length > maxLength) {
        errors.push(`Subject line exceeds ${maxLength} characters`);
    }
    // Check for scope if required
    if (config?.requireScope) {
        const hasScope = /\([a-z0-9-]+\)/.test(subject);
        if (!hasScope) {
            errors.push('Scope is required in commit message');
        }
    }
    // Check for body if required
    if (config?.requireBody) {
        if (lines.length < 3 || !lines[2]) {
            errors.push('Commit body is required');
        }
    }
    return { valid: errors.length === 0, errors };
}
// =============================================================================
// TYPE CHECKING PATTERN
// =============================================================================
/**
 * Run TypeScript type checking
 */
export function runTypeCheck(directory) {
    const tsconfigPath = join(directory, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
        return { success: true, message: 'No tsconfig.json found' };
    }
    try {
        const checkCommand = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${checkCommand} tsc`, { encoding: 'utf-8', stdio: 'pipe' });
    }
    catch {
        return { success: true, message: 'TypeScript not installed' };
    }
    try {
        execSync('tsc --noEmit', { cwd: directory, encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, message: 'Type check passed' };
    }
    catch (_error) {
        return { success: false, message: 'Type errors found' };
    }
}
// =============================================================================
// TEST RUNNER PATTERN
// =============================================================================
/**
 * Detect and run tests for a project
 */
export function runTests(directory) {
    const packageJsonPath = join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            if (pkg.scripts?.test) {
                execSync('npm test', { cwd: directory, encoding: 'utf-8', stdio: 'pipe' });
                return { success: true, message: 'Tests passed' };
            }
        }
        catch (_error) {
            return { success: false, message: 'Tests failed' };
        }
    }
    // Check for pytest
    if (existsSync(join(directory, 'pytest.ini')) || existsSync(join(directory, 'pyproject.toml'))) {
        try {
            execSync('pytest', { cwd: directory, encoding: 'utf-8', stdio: 'pipe' });
            return { success: true, message: 'Tests passed' };
        }
        catch (_error) {
            return { success: false, message: 'Tests failed' };
        }
    }
    return { success: true, message: 'No test runner found' };
}
/**
 * Run all pre-commit checks
 */
export function runPreCommitChecks(directory, commitMessage) {
    const checks = [];
    // Type checking
    const typeCheck = runTypeCheck(directory);
    checks.push({
        name: 'Type Check',
        passed: typeCheck.success,
        message: typeCheck.message
    });
    // Commit message validation
    if (commitMessage) {
        const commitCheck = validateCommitMessage(commitMessage);
        checks.push({
            name: 'Commit Message',
            passed: commitCheck.valid,
            message: commitCheck.valid ? 'Valid format' : commitCheck.errors.join('; ')
        });
    }
    // All checks must pass
    const canCommit = checks.every(c => c.passed);
    return { canCommit, checks };
}
// =============================================================================
// HOOK MESSAGE GENERATORS
// =============================================================================
/**
 * Generate pre-commit check reminder message
 */
export function getPreCommitReminderMessage(result) {
    if (result.canCommit) {
        return '';
    }
    const failedChecks = result.checks.filter(c => !c.passed);
    return `<pre-commit-validation>

[PRE-COMMIT CHECKS FAILED]

The following checks did not pass:
${failedChecks.map(c => `- ${c.name}: ${c.message}`).join('\n')}

Please fix these issues before committing.

</pre-commit-validation>

---

`;
}
/**
 * Generate auto-format reminder message
 */
export function getAutoFormatMessage(filePath, result) {
    if (result.success) {
        return '';
    }
    return `<auto-format>

[FORMAT WARNING]

File ${filePath} could not be auto-formatted:
${result.message}

Please check the file manually.

</auto-format>

---

`;
}
//# sourceMappingURL=index.js.map