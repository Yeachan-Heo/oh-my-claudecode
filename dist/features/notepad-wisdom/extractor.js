/**
 * Wisdom Extractor
 *
 * Parses agent completion responses to extract wisdom entries.
 */
/**
 * Extract wisdom from agent completion response
 *
 * Looks for wisdom blocks in formats like:
 * - <wisdom category="learnings">content</wisdom>
 * - <learning>content</learning>
 * - <decision>content</decision>
 * - <issue>content</issue>
 * - <problem>content</problem>
 */
export function extractWisdomFromCompletion(response) {
    const extracted = [];
    // Pattern 1: <wisdom category="...">content</wisdom>
    const wisdomTagRegex = /<wisdom\s+category=["'](\w+)["']>([\s\S]*?)<\/wisdom>/gi;
    let match;
    while ((match = wisdomTagRegex.exec(response)) !== null) {
        const category = match[1].toLowerCase();
        const content = match[2].trim();
        if (isValidCategory(category) && content) {
            extracted.push({ category, content });
        }
    }
    // Pattern 2: <learning>, <decision>, <issue>, <problem> tags
    const categories = ['learnings', 'decisions', 'issues', 'problems'];
    const singularMap = {
        learning: 'learnings',
        decision: 'decisions',
        issue: 'issues',
        problem: 'problems',
    };
    for (const [singular, category] of Object.entries(singularMap)) {
        const tagRegex = new RegExp(`<${singular}>([\s\S]*?)<\/${singular}>`, 'gi');
        while ((match = tagRegex.exec(response)) !== null) {
            const content = match[1].trim();
            if (content) {
                extracted.push({ category, content });
            }
        }
    }
    return extracted;
}
/**
 * Validate wisdom category
 */
function isValidCategory(category) {
    return ['learnings', 'decisions', 'issues', 'problems'].includes(category);
}
/**
 * Extract wisdom by category
 */
export function extractWisdomByCategory(response, targetCategory) {
    const allWisdom = extractWisdomFromCompletion(response);
    return allWisdom
        .filter(w => w.category === targetCategory)
        .map(w => w.content);
}
/**
 * Check if response contains wisdom
 */
export function hasWisdom(response) {
    return extractWisdomFromCompletion(response).length > 0;
}
//# sourceMappingURL=extractor.js.map