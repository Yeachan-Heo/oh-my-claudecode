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
import { join, extname, normalize } from 'path';
import { execFileSync, spawnSync } from 'child_process';
function runCommand(directory, command, args) {
    if (process.platform === 'win32') {
        const shell = process.env.ComSpec || 'cmd.exe';
        const result = spawnSync(shell, ['/d', '/s', '/c', command, ...args], {
            cwd: directory,
            stdio: 'pipe',
            encoding: 'utf-8'
        });
        return { status: result.status };
    }
    const result = spawnSync(command, args, {
        cwd: directory,
        stdio: 'pipe',
        encoding: 'utf-8'
    });
    return { status: result.status };
}
function runNpmCommand(directory, args) {
    return runCommand(directory, 'npm', args);
}
function runNpxCommand(directory, args) {
    return runCommand(directory, 'npx', args);
}
// =============================================================================
// SECURITY UTILITIES
// =============================================================================
/**
 * Validate file path for security
 * Blocks shell metacharacters and path traversal attempts
 */
export function isValidFilePath(filePath) {
    // Normalize Windows path separators to forward slashes before checking.
    // Backslashes are valid path separators on Windows (e.g. src\file.ts,
    // C:\repo\file.ts) and must not be treated as shell metacharacters.
    const normalized = filePath.replace(/\\/g, '/');
    // Block shell metacharacters
    if (/[;&|`$()<>{}[\]*?~!#\n\r\t\0]/.test(normalized))
        return false;
    // Block path traversal
    if (normalize(normalized).includes('..'))
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
    const binary = command.split(' ')[0];
    const checkCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checkCommand, [binary], { stdio: 'ignore' });
    return result.status === 0;
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
        const [formatterBin, ...formatterArgs] = formatter.split(' ');
        execFileSync(formatterBin, [...formatterArgs, filePath], { encoding: 'utf-8', stdio: 'pipe' });
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
    const linterBin = linter.split(' ')[0];
    const checkCommand = process.platform === 'win32' ? 'where' : 'which';
    const checkResult = spawnSync(checkCommand, [linterBin], { stdio: 'ignore' });
    if (checkResult.status !== 0) {
        return { success: true, message: `Linter ${linter} not available` };
    }
    try {
        const [linterCmd, ...linterArgs] = linter.split(' ');
        execFileSync(linterCmd, [...linterArgs, filePath], { encoding: 'utf-8', stdio: 'pipe' });
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
    // Determine effective types: prefer config.types when non-empty
    const effectiveTypes = config?.types?.length ? config.types : DEFAULT_COMMIT_TYPES;
    const commitRegex = effectiveTypes === DEFAULT_COMMIT_TYPES
        ? CONVENTIONAL_COMMIT_REGEX
        : new RegExp(`^(${effectiveTypes.join('|')})(\\([a-z0-9-]+\\))?(!)?:\\s.+$`);
    // Check conventional commit format
    if (!commitRegex.test(subject)) {
        errors.push('Subject must follow conventional commit format: type(scope?): description');
        errors.push(`Allowed types: ${effectiveTypes.join(', ')}`);
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
    const checkCommand = process.platform === 'win32' ? 'where' : 'which';
    const tscCheck = spawnSync(checkCommand, ['tsc'], { stdio: 'ignore' });
    if (tscCheck.status !== 0) {
        return { success: true, message: 'TypeScript not installed' };
    }
    const tscResult = runNpxCommand(directory, ['tsc', '--noEmit']);
    if (tscResult.status === 0) {
        return { success: true, message: 'Type check passed' };
    }
    return { success: false, message: 'Type errors found' };
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
                const testResult = runNpmCommand(directory, ['test']);
                if (testResult.status === 0) {
                    return { success: true, message: 'Tests passed' };
                }
                return { success: false, message: 'Tests failed' };
            }
        }
        catch (_error) {
            return { success: false, message: 'Tests failed' };
        }
    }
    // Check for pytest
    if (existsSync(join(directory, 'pytest.ini')) || existsSync(join(directory, 'pyproject.toml'))) {
        try {
            execFileSync('pytest', [], { cwd: directory, encoding: 'utf-8', stdio: 'pipe' });
            return { success: true, message: 'Tests passed' };
        }
        catch (_error) {
            return { success: false, message: 'Tests failed' };
        }
    }
    return { success: true, message: 'No test runner found' };
}
// =============================================================================
// PROJECT-LEVEL LINT RUNNER PATTERN
// =============================================================================
/**
 * Run project-level lint checks
 */
export function runLint(directory) {
    const packageJsonPath = join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            if (pkg.scripts?.lint) {
                const lintResult = runNpmCommand(directory, ['run', 'lint']);
                if (lintResult.status === 0) {
                    return { success: true, message: 'Lint passed' };
                }
                return { success: false, message: 'Lint errors found' };
            }
        }
        catch {
            // Could not read package.json
        }
    }
    return { success: true, message: 'No lint script found' };
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
    // Test runner
    const testCheck = runTests(directory);
    checks.push({
        name: 'Tests',
        passed: testCheck.success,
        message: testCheck.message
    });
    // Lint
    const lintCheck = runLint(directory);
    checks.push({
        name: 'Lint',
        passed: lintCheck.success,
        message: lintCheck.message
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