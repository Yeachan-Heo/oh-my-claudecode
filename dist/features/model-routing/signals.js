/**
 * Complexity Signal Extraction
 *
 * Extracts complexity signals from task prompts to inform routing decisions.
 * Signals are categorized into lexical, structural, and context types.
 */
import { COMPLEXITY_KEYWORDS } from './types.js';
/**
 * Extract lexical signals from task prompt
 * These are fast, regex-based extractions that don't require model calls
 */
export function extractLexicalSignals(prompt) {
    const lowerPrompt = prompt.toLowerCase();
    const words = prompt.split(/\s+/).filter(w => w.length > 0);
    return {
        wordCount: words.length,
        filePathCount: countFilePaths(prompt),
        codeBlockCount: countCodeBlocks(prompt),
        hasArchitectureKeywords: hasKeywords(lowerPrompt, COMPLEXITY_KEYWORDS.architecture),
        hasDebuggingKeywords: hasKeywords(lowerPrompt, COMPLEXITY_KEYWORDS.debugging),
        hasSimpleKeywords: hasKeywords(lowerPrompt, COMPLEXITY_KEYWORDS.simple),
        hasRiskKeywords: hasKeywords(lowerPrompt, COMPLEXITY_KEYWORDS.risk),
        questionDepth: detectQuestionDepth(lowerPrompt),
        hasImplicitRequirements: detectImplicitRequirements(lowerPrompt),
    };
}
/**
 * Extract structural signals from task prompt
 * These require more sophisticated parsing
 */
export function extractStructuralSignals(prompt) {
    const lowerPrompt = prompt.toLowerCase();
    return {
        estimatedSubtasks: estimateSubtasks(prompt),
        crossFileDependencies: detectCrossFileDependencies(prompt),
        hasTestRequirements: detectTestRequirements(lowerPrompt),
        domainSpecificity: detectDomain(lowerPrompt),
        requiresExternalKnowledge: detectExternalKnowledge(lowerPrompt),
        reversibility: assessReversibility(lowerPrompt),
        impactScope: assessImpactScope(prompt),
    };
}
/**
 * Extract context signals from routing context
 */
export function extractContextSignals(context) {
    return {
        previousFailures: context.previousFailures ?? 0,
        conversationTurns: context.conversationTurns ?? 0,
        planComplexity: context.planTasks ?? 0,
        remainingTasks: context.remainingTasks ?? 0,
        agentChainDepth: context.agentChainDepth ?? 0,
    };
}
/**
 * Extract all complexity signals
 */
export function extractAllSignals(prompt, context) {
    return {
        lexical: extractLexicalSignals(prompt),
        structural: extractStructuralSignals(prompt),
        context: extractContextSignals(context),
    };
}
// ============ Helper Functions ============
/**
 * Count file paths in prompt
 */
function countFilePaths(prompt) {
    // Match common file path patterns
    const patterns = [
        /(?:^|\s)[.\/~]?(?:[\w-]+\/)+[\w.-]+\.\w+/gm, // Unix-style paths
        /`[^`]+\.\w+`/g, // Backtick-quoted files
        /['"][^'"]+\.\w+['"]/g, // Quoted files
    ];
    let count = 0;
    for (const pattern of patterns) {
        const matches = prompt.match(pattern);
        if (matches)
            count += matches.length;
    }
    return Math.min(count, 20); // Cap at reasonable max
}
/**
 * Count code blocks in prompt
 */
function countCodeBlocks(prompt) {
    const fencedBlocks = (prompt.match(/```[\s\S]*?```/g) || []).length;
    const indentedBlocks = (prompt.match(/(?:^|\n)(?:\s{4}|\t)[^\n]+(?:\n(?:\s{4}|\t)[^\n]+)*/g) || []).length;
    return fencedBlocks + Math.floor(indentedBlocks / 2);
}
/**
 * Check if prompt contains any of the keywords
 */
function hasKeywords(prompt, keywords) {
    return keywords.some(kw => prompt.includes(kw));
}
/**
 * Detect question depth
 * 'why' questions require deeper reasoning than 'what' or 'where'
 */
function detectQuestionDepth(prompt) {
    if (/\bwhy\b.*\?|\bwhy\s+(is|are|does|do|did|would|should|can)/i.test(prompt)) {
        return 'why';
    }
    if (/\bhow\b.*\?|\bhow\s+(do|does|can|should|would|to)/i.test(prompt)) {
        return 'how';
    }
    if (/\bwhat\b.*\?|\bwhat\s+(is|are|does|do)/i.test(prompt)) {
        return 'what';
    }
    if (/\bwhere\b.*\?|\bwhere\s+(is|are|does|do|can)/i.test(prompt)) {
        return 'where';
    }
    return 'none';
}
/**
 * Detect implicit requirements (vague statements without clear deliverables)
 */
function detectImplicitRequirements(prompt) {
    const vaguePatterns = [
        /\bmake it better\b/,
        /\bimprove\b(?!.*(?:by|to|so that))/,
        /\bfix\b(?!.*(?:the|this|that|in|at))/,
        /\boptimize\b(?!.*(?:by|for|to))/,
        /\bclean up\b/,
        /\brefactor\b(?!.*(?:to|by|into))/,
    ];
    return vaguePatterns.some(p => p.test(prompt));
}
/**
 * Estimate number of subtasks
 */
function estimateSubtasks(prompt) {
    let count = 1;
    // Count explicit list items
    const bulletPoints = (prompt.match(/^[\s]*[-*•]\s/gm) || []).length;
    const numberedItems = (prompt.match(/^[\s]*\d+[.)]\s/gm) || []).length;
    count += bulletPoints + numberedItems;
    // Count 'and' conjunctions that might indicate multiple tasks
    const andCount = (prompt.match(/\band\b/gi) || []).length;
    count += Math.floor(andCount / 2);
    // Count 'then' indicators
    const thenCount = (prompt.match(/\bthen\b/gi) || []).length;
    count += thenCount;
    return Math.min(count, 10);
}
/**
 * Detect if task involves changes across multiple files
 */
function detectCrossFileDependencies(prompt) {
    const fileCount = countFilePaths(prompt);
    if (fileCount >= 2)
        return true;
    const crossFileIndicators = [
        /multiple files/i,
        /across.*files/i,
        /several.*files/i,
        /all.*files/i,
        /throughout.*codebase/i,
        /entire.*project/i,
        /whole.*system/i,
    ];
    return crossFileIndicators.some(p => p.test(prompt));
}
/**
 * Detect test requirements
 */
function detectTestRequirements(prompt) {
    const testIndicators = [
        /\btest/i,
        /\bspec\b/i,
        /make sure.*work/i,
        /verify/i,
        /ensure.*pass/i,
        /\bTDD\b/,
        /unit test/i,
        /integration test/i,
    ];
    return testIndicators.some(p => p.test(prompt));
}
/**
 * Detect domain specificity
 */
function detectDomain(prompt) {
    const domains = {
        frontend: [
            /\b(react|vue|angular|svelte|css|html|jsx|tsx|component|ui|ux|styling|tailwind|sass|scss)\b/i,
            /\b(button|modal|form|input|layout|responsive|animation)\b/i,
        ],
        backend: [
            /\b(api|endpoint|database|query|sql|graphql|rest|server|auth|middleware)\b/i,
            /\b(node|express|fastify|nest|django|flask|rails)\b/i,
        ],
        infrastructure: [
            /\b(docker|kubernetes|k8s|terraform|aws|gcp|azure|ci|cd|deploy|container)\b/i,
            /\b(nginx|load.?balancer|scaling|monitoring|logging)\b/i,
        ],
        security: [
            /\b(security|auth|oauth|jwt|encryption|vulnerability|xss|csrf|injection)\b/i,
            /\b(password|credential|secret|token|permission)\b/i,
        ],
    };
    for (const [domain, patterns] of Object.entries(domains)) {
        if (patterns.some(p => p.test(prompt))) {
            return domain;
        }
    }
    return 'generic';
}
/**
 * Detect if external knowledge is required
 */
function detectExternalKnowledge(prompt) {
    const externalIndicators = [
        /\bdocs?\b/i,
        /\bdocumentation\b/i,
        /\bofficial\b/i,
        /\blibrary\b/i,
        /\bpackage\b/i,
        /\bframework\b/i,
        /\bhow does.*work\b/i,
        /\bbest practice/i,
    ];
    return externalIndicators.some(p => p.test(prompt));
}
/**
 * Assess reversibility of changes
 */
function assessReversibility(prompt) {
    const difficultIndicators = [
        /\bmigrat/i,
        /\bproduction\b/i,
        /\bdata.*loss/i,
        /\bdelete.*all/i,
        /\bdrop.*table/i,
        /\birreversible/i,
        /\bpermanent/i,
    ];
    const moderateIndicators = [
        /\brefactor/i,
        /\brestructure/i,
        /\brename.*across/i,
        /\bmove.*files/i,
        /\bchange.*schema/i,
    ];
    if (difficultIndicators.some(p => p.test(prompt)))
        return 'difficult';
    if (moderateIndicators.some(p => p.test(prompt)))
        return 'moderate';
    return 'easy';
}
/**
 * Assess impact scope of changes
 */
function assessImpactScope(prompt) {
    const systemWideIndicators = [
        /\bentire\b/i,
        /\ball\s+(?:files|components|modules)/i,
        /\bwhole\s+(?:project|codebase|system)/i,
        /\bsystem.?wide/i,
        /\bglobal/i,
        /\beverywhere/i,
        /\bthroughout/i,
    ];
    const moduleIndicators = [
        /\bmodule/i,
        /\bpackage/i,
        /\bservice/i,
        /\bfeature/i,
        /\bcomponent/i,
        /\blayer/i,
    ];
    if (systemWideIndicators.some(p => p.test(prompt)))
        return 'system-wide';
    // Check for multiple files (indicates module-level at least)
    if (countFilePaths(prompt) >= 3)
        return 'module';
    if (moduleIndicators.some(p => p.test(prompt)))
        return 'module';
    return 'local';
}
//# sourceMappingURL=signals.js.map