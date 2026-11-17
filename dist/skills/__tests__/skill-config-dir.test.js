/**
 * Regression test: skill markdown files must use CLAUDE_CONFIG_DIR
 *
 * Ensures that bash code blocks in skill files never hardcode $HOME/.claude
 * without a ${CLAUDE_CONFIG_DIR:-...} fallback. This prevents skills from
 * ignoring the user's custom config directory.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
/**
 * Extract content from fenced bash code blocks in a markdown file.
 * Returns an array of { startLine, content } for each ```bash ... ``` block.
 */
function extractBashBlocks(filePath) {
    const text = readFileSync(filePath, 'utf-8');
    const lines = text.split('\n');
    const blocks = [];
    let inBlock = false;
    let blockStart = 0;
    let blockLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!inBlock && /^```bash\b/.test(line.trim())) {
            inBlock = true;
            blockStart = i + 2; // 1-indexed, next line
            blockLines = [];
        }
        else if (inBlock && line.trim() === '```') {
            inBlock = false;
            blocks.push({ startLine: blockStart, content: blockLines.join('\n') });
        }
        else if (inBlock) {
            blockLines.push(line);
        }
    }
    return blocks;
}
/**
 * Find lines in bash blocks that use $HOME/.claude without the
 * ${CLAUDE_CONFIG_DIR:-$HOME/.claude} pattern.
 */
function findHardcodedHomeClaude(filePath) {
    const blocks = extractBashBlocks(filePath);
    const violations = [];
    for (const block of blocks) {
        const lines = block.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match $HOME/.claude that is NOT inside ${CLAUDE_CONFIG_DIR:-$HOME/.claude}
            if (/\$HOME\/\.claude/.test(line) && !/\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/.test(line)) {
                violations.push({
                    line: block.startLine + i,
                    text: line.trim(),
                });
            }
        }
    }
    return violations;
}
const SKILLS_ROOT = join(__dirname, '..', '..', '..', 'skills');
function findMarkdownFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...findMarkdownFiles(full));
        }
        else if (entry.endsWith('.md')) {
            results.push(full);
        }
    }
    return results;
}
/**
 * Find lines in full skill content (not just bash blocks) that use ~/.claude
 * without portable notation like [$CLAUDE_CONFIG_DIR|~/.claude].
 * Issue #2155 §16 — LLMs read prose and use literal paths in tool calls.
 */
function findHardcodedTildeClaude(filePath) {
    const text = readFileSync(filePath, 'utf-8');
    const lines = text.split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match ~/.claude (tilde form) used in prose/tool directives
        if (!/~\/\.claude/.test(line))
            continue;
        // Allow: portable notation [$CLAUDE_CONFIG_DIR|~/.claude]
        if (/\[\$CLAUDE_CONFIG_DIR\|~\/\.claude\]/.test(line))
            continue;
        // Allow: env-var fallback ${CLAUDE_CONFIG_DIR:-...}
        if (/\$\{CLAUDE_CONFIG_DIR:-/.test(line))
            continue;
        // Allow: lines inside bash code blocks (covered by the other test)
        // Allow: comment lines and frontmatter
        const trimmed = line.trim();
        if (trimmed.startsWith('#') && !trimmed.startsWith('##'))
            continue; // frontmatter/comments
        if (trimmed.startsWith('<!--') && trimmed.endsWith('-->'))
            continue;
        // Allow: lines that mention CLAUDE_CONFIG_DIR (explaining the config dir system)
        if (/CLAUDE_CONFIG_DIR/i.test(line))
            continue;
        // Allow: glob patterns like ~/.claude/** (permission patterns, not path resolution)
        if (/~\/\.claude\/\*/.test(line))
            continue;
        violations.push({ line: i + 1, text: trimmed });
    }
    return violations;
}
const ALL_FILES = findMarkdownFiles(SKILLS_ROOT);
describe('skill markdown bash blocks must respect CLAUDE_CONFIG_DIR', () => {
    it.each(ALL_FILES.map((f) => [f.replace(/.*skills\//, 'skills/'), f]))('%s has no hardcoded $HOME/.claude in bash blocks', (_label, filePath) => {
        const violations = findHardcodedHomeClaude(filePath);
        if (violations.length > 0) {
            const details = violations
                .map((v) => `  line ${v.line}: ${v.text}`)
                .join('\n');
            expect.fail(`Found $HOME/.claude without CLAUDE_CONFIG_DIR fallback:\n${details}\n` +
                `Replace with: \${CLAUDE_CONFIG_DIR:-$HOME/.claude}`);
        }
    });
});
describe('skill markdown prose must not use raw ~/.claude (Contract 6, issue #2155 §16)', () => {
    // Known existing violations per skill directory (baseline snapshot).
    // These are real issues documented in #2155 §16 but predate this regression test.
    // This test prevents NEW violations from being introduced.
    // To reduce the baseline: fix the skill prose to use [$CLAUDE_CONFIG_DIR|~/.claude] notation,
    // then lower the count here.
    const KNOWN_VIOLATION_BASELINE = {
        'skills/cancel/SKILL.md': 4,
        'skills/configure-notifications/SKILL.md': 5,
        'skills/hud/SKILL.md': 8,
        'skills/omc-doctor/SKILL.md': 7,
        'skills/omc-setup/SKILL.md': 5,
        'skills/omc-setup/phases/01-install-claude-md.md': 4,
        'skills/omc-setup/phases/02-configure.md': 3,
        'skills/omc-setup/phases/03-integrations.md': 3,
        'skills/skill/SKILL.md': 8,
        'skills/team/SKILL.md': 6,
    };
    it.each(ALL_FILES.map((f) => [f.replace(/.*skills\//, 'skills/'), f]))('%s has no new unguarded ~/.claude in prose', (label, filePath) => {
        const violations = findHardcodedTildeClaude(filePath);
        const baseline = KNOWN_VIOLATION_BASELINE[label] ?? 0;
        if (violations.length > baseline) {
            const details = violations
                .map((v) => `  line ${v.line}: ${v.text}`)
                .join('\n');
            expect.fail(`Found ${violations.length} ~/.claude violations (baseline: ${baseline}, new: ${violations.length - baseline}):\n${details}\n` +
                `Replace with: [$CLAUDE_CONFIG_DIR|~/.claude] or use \${CLAUDE_CONFIG_DIR:-$HOME/.claude} in code`);
        }
    });
    it('total baseline should not increase (tracks overall progress)', () => {
        let totalViolations = 0;
        for (const filePath of ALL_FILES) {
            totalViolations += findHardcodedTildeClaude(filePath).length;
        }
        const totalBaseline = Object.values(KNOWN_VIOLATION_BASELINE).reduce((a, b) => a + b, 0);
        // This assertion catches violations in files not yet in the baseline
        expect(totalViolations).toBeLessThanOrEqual(totalBaseline);
    });
});
//# sourceMappingURL=skill-config-dir.test.js.map