/**
 * Verification Module
 *
 * Reusable verification protocol logic extracted from ralph, ultrawork, and autopilot.
 * Provides a single source of truth for verification requirements and execution.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
/**
 * Standard verification checks used across workflows
 */
export const STANDARD_CHECKS = {
    BUILD: {
        id: 'build',
        name: 'Build Success',
        description: 'Code compiles without errors',
        evidenceType: 'build_success',
        required: true,
        command: undefined,
        completed: false
    },
    TEST: {
        id: 'test',
        name: 'Tests Pass',
        description: 'All tests pass without errors',
        evidenceType: 'test_pass',
        required: true,
        command: undefined,
        completed: false
    },
    LINT: {
        id: 'lint',
        name: 'Lint Clean',
        description: 'No linting errors',
        evidenceType: 'lint_clean',
        required: true,
        command: undefined,
        completed: false
    },
    FUNCTIONALITY: {
        id: 'functionality',
        name: 'Functionality Verified',
        description: 'All requested features work as described',
        evidenceType: 'functionality_verified',
        required: true,
        completed: false
    },
    ARCHITECT: {
        id: 'architect',
        name: 'Architect Approval',
        description: 'Architect has reviewed and approved the implementation',
        evidenceType: 'architect_approval',
        required: true,
        completed: false
    },
    TODO: {
        id: 'todo',
        name: 'TODO Complete',
        description: 'Zero pending or in_progress tasks',
        evidenceType: 'todo_complete',
        required: true,
        completed: false
    },
    ERROR_FREE: {
        id: 'error_free',
        name: 'Error Free',
        description: 'Zero unaddressed errors',
        evidenceType: 'error_free',
        required: true,
        completed: false
    }
};
/**
 * Create a verification protocol
 */
export function createProtocol(name, description, checks, strictMode = true) {
    return {
        name,
        description,
        checks,
        strictMode
    };
}
/**
 * Create a verification checklist from a protocol
 */
export function createChecklist(protocol) {
    return {
        protocol,
        startedAt: new Date(),
        checks: protocol.checks.map(check => ({ ...check })),
        status: 'pending'
    };
}
/**
 * Run a single verification check
 */
async function runSingleCheck(check, options = {}) {
    const { cwd, timeout = 60000 } = options;
    // If check has a command, run it
    if (check.command) {
        try {
            const { stdout, stderr } = await execAsync(check.command, {
                cwd,
                timeout
            });
            return {
                type: check.evidenceType,
                passed: true,
                command: check.command,
                output: stdout || stderr,
                timestamp: new Date()
            };
        }
        catch (error) {
            const err = error;
            return {
                type: check.evidenceType,
                passed: false,
                command: check.command,
                output: err.stdout || err.stderr,
                error: err.message,
                timestamp: new Date()
            };
        }
    }
    // Manual verification checks (no command)
    return {
        type: check.evidenceType,
        passed: false,
        timestamp: new Date(),
        metadata: { requiresManualVerification: true }
    };
}
/**
 * Execute all verification checks
 */
export async function runVerification(checklist, options = {}) {
    const { parallel = true, failFast = false, skipOptional = false } = options;
    checklist.status = 'in_progress';
    // Filter checks based on options
    const checksToRun = skipOptional
        ? checklist.checks.filter(c => c.required)
        : checklist.checks;
    if (parallel && !failFast) {
        // Run all checks in parallel
        const results = await Promise.allSettled(checksToRun.map(check => runSingleCheck(check, options)));
        // Update checklist with results
        checksToRun.forEach((check, idx) => {
            const result = results[idx];
            if (result.status === 'fulfilled') {
                check.evidence = result.value;
                check.completed = true;
            }
            else {
                check.evidence = {
                    type: check.evidenceType,
                    passed: false,
                    error: result.reason?.message || 'Check failed',
                    timestamp: new Date()
                };
                check.completed = true;
            }
        });
    }
    else {
        // Run checks sequentially
        for (const check of checksToRun) {
            try {
                const evidence = await runSingleCheck(check, options);
                check.evidence = evidence;
                check.completed = true;
                // Stop on first failure if failFast is enabled
                if (failFast && !evidence.passed) {
                    break;
                }
            }
            catch (error) {
                check.evidence = {
                    type: check.evidenceType,
                    passed: false,
                    error: error.message,
                    timestamp: new Date()
                };
                check.completed = true;
                if (failFast) {
                    break;
                }
            }
        }
    }
    // Generate summary
    checklist.summary = generateSummary(checklist);
    checklist.completedAt = new Date();
    checklist.status = checklist.summary.allRequiredPassed ? 'complete' : 'failed';
    return checklist;
}
/**
 * Validate evidence for a specific check
 */
export function checkEvidence(check, evidence) {
    const issues = [];
    const recommendations = [];
    // Basic validation
    if (!evidence) {
        issues.push(`No evidence provided for check: ${check.name}`);
        recommendations.push('Run the verification check to collect evidence');
        return {
            valid: false,
            message: `Missing evidence for ${check.name}`,
            issues,
            recommendations
        };
    }
    // Check evidence type matches
    if (evidence.type !== check.evidenceType) {
        issues.push(`Evidence type mismatch: expected ${check.evidenceType}, got ${evidence.type}`);
    }
    // Check if passed
    if (!evidence.passed) {
        issues.push(`Check failed: ${check.name}`);
        if (evidence.error) {
            issues.push(`Error: ${evidence.error}`);
        }
        if (check.command) {
            recommendations.push(`Review command output: ${check.command}`);
        }
        recommendations.push('Fix the issue and re-run verification');
    }
    // Check for stale evidence (older than 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (evidence.timestamp < fiveMinutesAgo) {
        issues.push('Evidence is stale (older than 5 minutes)');
        recommendations.push('Re-run verification to get fresh evidence');
    }
    return {
        valid: issues.length === 0,
        message: issues.length === 0 ? `${check.name} verified successfully` : `${check.name} verification failed`,
        issues,
        recommendations
    };
}
/**
 * Generate summary of verification results
 */
function generateSummary(checklist) {
    const total = checklist.checks.length;
    const passed = checklist.checks.filter(c => c.evidence?.passed).length;
    const failed = checklist.checks.filter(c => c.completed && !c.evidence?.passed).length;
    const skipped = checklist.checks.filter(c => !c.completed).length;
    const requiredChecks = checklist.checks.filter(c => c.required);
    const allRequiredPassed = requiredChecks.every(c => c.evidence?.passed);
    const failedChecks = checklist.checks
        .filter(c => c.completed && !c.evidence?.passed)
        .map(c => c.id);
    let verdict;
    if (skipped > 0) {
        verdict = 'incomplete';
    }
    else if (checklist.protocol.strictMode && failed > 0) {
        verdict = 'rejected';
    }
    else if (allRequiredPassed) {
        verdict = 'approved';
    }
    else {
        verdict = 'rejected';
    }
    return {
        total,
        passed,
        failed,
        skipped,
        allRequiredPassed,
        failedChecks,
        verdict
    };
}
/**
 * Format verification report
 */
export function formatReport(checklist, options = {}) {
    const { includeEvidence = true, includeOutput = false, format = 'markdown' } = options;
    if (format === 'json') {
        return JSON.stringify(checklist, null, 2);
    }
    const lines = [];
    // Header
    if (format === 'markdown') {
        lines.push(`# Verification Report: ${checklist.protocol.name}`);
        lines.push('');
        lines.push(`**Status:** ${checklist.status}`);
        lines.push(`**Started:** ${checklist.startedAt.toISOString()}`);
        if (checklist.completedAt) {
            lines.push(`**Completed:** ${checklist.completedAt.toISOString()}`);
        }
        lines.push('');
    }
    else {
        lines.push(`Verification Report: ${checklist.protocol.name}`);
        lines.push(`Status: ${checklist.status}`);
        lines.push(`Started: ${checklist.startedAt.toISOString()}`);
        if (checklist.completedAt) {
            lines.push(`Completed: ${checklist.completedAt.toISOString()}`);
        }
        lines.push('');
    }
    // Summary
    if (checklist.summary) {
        const { summary } = checklist;
        if (format === 'markdown') {
            lines.push('## Summary');
            lines.push('');
            lines.push(`- **Total Checks:** ${summary.total}`);
            lines.push(`- **Passed:** ${summary.passed}`);
            lines.push(`- **Failed:** ${summary.failed}`);
            lines.push(`- **Skipped:** ${summary.skipped}`);
            lines.push(`- **Verdict:** ${summary.verdict.toUpperCase()}`);
            lines.push('');
        }
        else {
            lines.push('Summary:');
            lines.push(`  Total Checks: ${summary.total}`);
            lines.push(`  Passed: ${summary.passed}`);
            lines.push(`  Failed: ${summary.failed}`);
            lines.push(`  Skipped: ${summary.skipped}`);
            lines.push(`  Verdict: ${summary.verdict.toUpperCase()}`);
            lines.push('');
        }
    }
    // Checks
    if (format === 'markdown') {
        lines.push('## Checks');
        lines.push('');
    }
    else {
        lines.push('Checks:');
    }
    for (const check of checklist.checks) {
        const status = check.evidence?.passed ? '✓' : check.completed ? '✗' : '○';
        const required = check.required ? '(required)' : '(optional)';
        if (format === 'markdown') {
            lines.push(`### ${status} ${check.name} ${required}`);
            lines.push('');
            lines.push(check.description);
            lines.push('');
        }
        else {
            lines.push(`  ${status} ${check.name} ${required}`);
            lines.push(`     ${check.description}`);
        }
        if (includeEvidence && check.evidence) {
            if (format === 'markdown') {
                lines.push('**Evidence:**');
                lines.push(`- Passed: ${check.evidence.passed}`);
                lines.push(`- Timestamp: ${check.evidence.timestamp.toISOString()}`);
                if (check.evidence.command) {
                    lines.push(`- Command: \`${check.evidence.command}\``);
                }
                if (check.evidence.error) {
                    lines.push(`- Error: ${check.evidence.error}`);
                }
            }
            else {
                lines.push(`     Evidence: ${check.evidence.passed ? 'PASSED' : 'FAILED'}`);
                if (check.evidence.error) {
                    lines.push(`     Error: ${check.evidence.error}`);
                }
            }
            if (includeOutput && check.evidence.output) {
                if (format === 'markdown') {
                    lines.push('');
                    lines.push('**Output:**');
                    lines.push('```');
                    lines.push(check.evidence.output.trim());
                    lines.push('```');
                }
                else {
                    lines.push(`     Output: ${check.evidence.output.substring(0, 100)}...`);
                }
            }
            lines.push('');
        }
    }
    return lines.join('\n');
}
/**
 * Validate entire checklist
 */
export async function validateChecklist(checklist) {
    const issues = [];
    const recommendations = [];
    // Check if verification is complete
    if (checklist.status !== 'complete' && checklist.status !== 'failed') {
        issues.push('Verification is not complete');
        recommendations.push('Run verification to completion before validating');
        return {
            valid: false,
            message: 'Incomplete verification',
            issues,
            recommendations
        };
    }
    // Validate each check
    for (const check of checklist.checks) {
        if (!check.evidence) {
            if (check.required) {
                issues.push(`Missing evidence for required check: ${check.name}`);
                recommendations.push(`Run verification check: ${check.name}`);
            }
            continue;
        }
        const validation = checkEvidence(check, check.evidence);
        if (!validation.valid && check.required) {
            issues.push(...validation.issues);
            if (validation.recommendations) {
                recommendations.push(...validation.recommendations);
            }
        }
    }
    // Run custom validator if provided
    if (checklist.protocol.customValidator) {
        const customResult = await checklist.protocol.customValidator(checklist);
        if (!customResult.valid) {
            issues.push(...customResult.issues);
            if (customResult.recommendations) {
                recommendations.push(...customResult.recommendations);
            }
        }
    }
    return {
        valid: issues.length === 0,
        message: issues.length === 0 ? 'All verifications passed' : 'Some verifications failed',
        issues,
        recommendations
    };
}
//# sourceMappingURL=index.js.map