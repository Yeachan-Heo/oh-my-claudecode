/**
 * Verification Module Usage Examples
 *
 * This file demonstrates how to use the verification module
 * in different OMC workflows.
 */
import { createProtocol, createChecklist, runVerification, checkEvidence, formatReport, validateChecklist, STANDARD_CHECKS } from './index.js';
/**
 * Example 1: Ralph Loop Verification
 *
 * Ralph requires comprehensive verification before completion.
 */
export async function exampleRalphVerification() {
    // Create protocol with all standard checks
    const ralphProtocol = createProtocol('ralph', 'Ralph loop completion verification', [
        STANDARD_CHECKS.TODO,
        STANDARD_CHECKS.BUILD,
        STANDARD_CHECKS.TEST,
        STANDARD_CHECKS.LINT,
        STANDARD_CHECKS.FUNCTIONALITY,
        STANDARD_CHECKS.ARCHITECT,
        STANDARD_CHECKS.ERROR_FREE
    ], true // strict mode
    );
    // Create checklist
    const checklist = createChecklist(ralphProtocol);
    // Run verification in parallel
    await runVerification(checklist, {
        parallel: true,
        failFast: false,
        timeout: 120000 // 2 minutes per check
    });
    // Validate results
    const validation = await validateChecklist(checklist);
    if (validation.valid) {
        // All checks passed - use cancel to cleanly exit the ralph loop
        console.log('[RALPH VERIFIED] All checks passed. Run /oh-my-claudecode:cancel to exit.');
    }
    else {
        console.log('Verification failed:');
        console.log(validation.issues.join('\n'));
        console.log('\nRecommendations:');
        console.log(validation.recommendations?.join('\n'));
    }
}
/**
 * Example 2: Ultrawork Quick Verification
 *
 * Ultrawork focuses on essential checks.
 */
export async function exampleUltraworkVerification() {
    const ultraworkProtocol = createProtocol('ultrawork', 'Ultrawork completion verification', [
        STANDARD_CHECKS.TODO,
        STANDARD_CHECKS.FUNCTIONALITY,
        STANDARD_CHECKS.ERROR_FREE
    ], true);
    const checklist = createChecklist(ultraworkProtocol);
    await runVerification(checklist, {
        parallel: true,
        skipOptional: true
    });
    // Generate markdown report
    const report = formatReport(checklist, {
        includeEvidence: true,
        format: 'markdown'
    });
    console.log(report);
}
/**
 * Example 3: Autopilot QA Phase
 *
 * Autopilot runs verification in QA phase.
 */
export async function exampleAutopilotQA() {
    const qaProtocol = createProtocol('autopilot-qa', 'Autopilot QA phase verification', [
        STANDARD_CHECKS.BUILD,
        STANDARD_CHECKS.LINT,
        STANDARD_CHECKS.TEST
    ], true);
    const checklist = createChecklist(qaProtocol);
    // Run checks sequentially with fail-fast
    await runVerification(checklist, {
        parallel: false,
        failFast: true // Stop on first failure
    });
    if (checklist.summary?.verdict === 'approved') {
        console.log('[QA_COMPLETE]');
    }
    else {
        console.log('[QA_FAILED] Fixing issues...');
        // Fix issues and re-run
    }
}
/**
 * Example 4: Autopilot Validation Phase
 *
 * Autopilot runs final validation with architect approval.
 */
export async function exampleAutopilotValidation() {
    const validationProtocol = createProtocol('autopilot-validation', 'Autopilot final validation', [
        STANDARD_CHECKS.BUILD,
        STANDARD_CHECKS.TEST,
        STANDARD_CHECKS.FUNCTIONALITY,
        STANDARD_CHECKS.ARCHITECT
    ], true);
    const checklist = createChecklist(validationProtocol);
    // Note: Architect check requires manual evidence
    // Set architect approval manually after review
    const architectCheck = checklist.checks.find(c => c.id === 'architect');
    if (architectCheck) {
        // This would be set by the architect agent
        architectCheck.evidence = {
            type: 'architect_approval',
            passed: true,
            timestamp: new Date(),
            metadata: {
                architect: 'architect-opus',
                review: 'Implementation meets all requirements'
            }
        };
        architectCheck.completed = true;
    }
    // Run automated checks
    await runVerification(checklist, { parallel: true });
    // Generate detailed report
    const report = formatReport(checklist, {
        includeEvidence: true,
        includeOutput: true,
        format: 'markdown'
    });
    console.log(report);
    if (checklist.summary?.verdict === 'approved') {
        // All checks passed - use cancel to cleanly exit autopilot
        console.log('[AUTOPILOT VERIFIED] All checks passed. Run /oh-my-claudecode:cancel to exit.');
    }
}
/**
 * Example 5: Custom Verification Protocol
 *
 * Create a custom protocol for specific needs.
 */
export async function exampleCustomProtocol() {
    const customProtocol = createProtocol('custom-frontend', 'Frontend-specific verification', [
        {
            id: 'build',
            name: 'Build Success',
            description: 'Vite build completes',
            evidenceType: 'build_success',
            required: true,
            command: 'npm run build',
            completed: false
        },
        {
            id: 'types',
            name: 'Type Check',
            description: 'TypeScript type checking passes',
            evidenceType: 'build_success',
            required: true,
            command: 'npm run type-check',
            completed: false
        },
        {
            id: 'accessibility',
            name: 'A11y Check',
            description: 'Accessibility tests pass',
            evidenceType: 'test_pass',
            required: false,
            command: 'npm run test:a11y',
            completed: false
        }
    ], false // non-strict: optional checks can fail
    );
    const checklist = createChecklist(customProtocol);
    await runVerification(checklist, {
        parallel: true,
        skipOptional: false
    });
    // Check individual evidence
    for (const check of checklist.checks) {
        if (check.evidence) {
            const validation = checkEvidence(check, check.evidence);
            if (!validation.valid) {
                console.log(`${check.name} failed:`, validation.issues);
            }
        }
    }
}
/**
 * Example 6: Evidence Validation
 *
 * Validate evidence freshness and completeness.
 */
export async function exampleEvidenceValidation() {
    const protocol = createProtocol('evidence-check', 'Evidence validation example', [STANDARD_CHECKS.BUILD], true);
    const checklist = createChecklist(protocol);
    await runVerification(checklist);
    // Check evidence for build
    const buildCheck = checklist.checks.find(c => c.id === 'build');
    if (buildCheck?.evidence) {
        const validation = checkEvidence(buildCheck, buildCheck.evidence);
        console.log('Evidence validation result:');
        console.log('Valid:', validation.valid);
        console.log('Message:', validation.message);
        if (!validation.valid) {
            console.log('Issues:', validation.issues);
            console.log('Recommendations:', validation.recommendations);
        }
        // Check evidence freshness
        const age = Date.now() - buildCheck.evidence.timestamp.getTime();
        const ageMinutes = Math.floor(age / 60000);
        console.log(`Evidence age: ${ageMinutes} minutes`);
        if (ageMinutes > 5) {
            console.log('WARNING: Evidence is stale, re-run verification');
        }
    }
}
/**
 * Example 7: JSON Report Generation
 *
 * Generate machine-readable report.
 */
export async function exampleJsonReport() {
    const protocol = createProtocol('json-example', 'JSON report example', [STANDARD_CHECKS.BUILD, STANDARD_CHECKS.TEST], true);
    const checklist = createChecklist(protocol);
    await runVerification(checklist);
    // Generate JSON report
    const jsonReport = formatReport(checklist, {
        format: 'json',
        includeEvidence: true,
        includeOutput: true
    });
    // Parse and use
    const parsed = JSON.parse(jsonReport);
    console.log('Summary:', parsed.summary);
    console.log('Status:', parsed.status);
}
//# sourceMappingURL=example.js.map