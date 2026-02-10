/**
 * Delegation Prompt Validator
 *
 * Validates delegation prompts to ensure they are comprehensive and well-structured.
 */
/**
 * Validate a delegation prompt for completeness and structure
 *
 * @param prompt The delegation prompt to validate
 * @returns Validation result with warnings if any
 */
export function validateDelegationPrompt(prompt) {
    const warnings = [];
    // Count non-empty lines
    const lines = prompt.split('\n').filter((l) => l.trim()).length;
    // Check minimum line count
    if (lines < 30) {
        warnings.push(`Delegation prompt is only ${lines} lines. Consider adding more detail (recommended: 30+ lines).`);
    }
    // Check for required sections
    const requiredSections = ['TASK', 'EXPECTED OUTCOME', 'MUST DO', 'MUST NOT DO'];
    for (const section of requiredSections) {
        if (!prompt.includes(`## ${section}`) && !prompt.includes(`### ${section}`)) {
            warnings.push(`Missing recommended section: ${section}`);
        }
    }
    // Check for common issues
    if (prompt.length < 200) {
        warnings.push('Delegation prompt is very short. Consider adding more context and details.');
    }
    if (!prompt.includes('Task') && !prompt.includes('task')) {
        warnings.push('Delegation prompt should clearly describe the task.');
    }
    return {
        valid: warnings.length === 0,
        warnings,
    };
}
/**
 * Validate that a delegation prompt has all 7 recommended sections
 *
 * @param prompt The delegation prompt to validate
 * @returns True if all sections are present
 */
export function hasAllSections(prompt) {
    const sections = [
        'TASK',
        'EXPECTED OUTCOME',
        'CONTEXT',
        'MUST DO',
        'MUST NOT DO',
        'REQUIRED SKILLS',
        'REQUIRED TOOLS',
    ];
    return sections.every((section) => prompt.includes(`## ${section}`) || prompt.includes(`### ${section}`));
}
/**
 * Get missing sections from a delegation prompt
 *
 * @param prompt The delegation prompt to check
 * @returns Array of missing section names
 */
export function getMissingSections(prompt) {
    const sections = [
        'TASK',
        'EXPECTED OUTCOME',
        'CONTEXT',
        'MUST DO',
        'MUST NOT DO',
        'REQUIRED SKILLS',
        'REQUIRED TOOLS',
    ];
    return sections.filter((section) => !prompt.includes(`## ${section}`) && !prompt.includes(`### ${section}`));
}
//# sourceMappingURL=delegation-validator.js.map