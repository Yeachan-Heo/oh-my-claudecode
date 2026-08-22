/**
 * Markdown extraction helpers for python_repl / scientist documentation parity.
 *
 * Documentation parity checks must only judge the guidance that actually
 * describes python_repl or the scientist agent. Blacklisting terms across a
 * whole document is wrong: unrelated sections legitimately mention pandas,
 * numpy, or file-IO APIs (other tools, other agents, historical notes), so a
 * whole-file assertion either fails on innocent prose or forces unrelated docs
 * to stay artificially term-free.
 */
const RELEVANT = /python[ _]repl|scientist/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s/;
/** Split markdown into headings, plain lines, and atomic fenced code blocks. */
function toUnits(markdown) {
    const lines = markdown.split('\n');
    const units = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1];
            const block = [line];
            i++;
            while (i < lines.length) {
                block.push(lines[i]);
                if (lines[i].trimStart().startsWith(marker))
                    break;
                i++;
            }
            units.push({ lines: block });
            continue;
        }
        const heading = HEADING.exec(line);
        units.push(heading ? { lines: [line], headingLevel: heading[1].length } : { lines: [line] });
    }
    return units;
}
/**
 * Extract every part of `markdown` that describes python_repl or the scientist
 * agent:
 * - a heading whose own text is relevant contributes its whole section,
 *   including nested subsections (until the next heading of equal or lower
 *   level);
 * - any other line or fenced code block contributes only when its own text is
 *   relevant, so a table's unrelated rows are never pulled in.
 */
export function extractPythonGuidance(markdown) {
    const units = toUnits(markdown);
    const kept = [];
    // Levels of the headings whose sections are currently open and relevant.
    let openLevel = null;
    for (const unit of units) {
        const text = unit.lines.join('\n');
        if (unit.headingLevel !== undefined) {
            if (openLevel !== null && unit.headingLevel <= openLevel)
                openLevel = null;
            if (RELEVANT.test(text)) {
                openLevel = openLevel === null ? unit.headingLevel : Math.min(openLevel, unit.headingLevel);
                kept.push(text);
                continue;
            }
            if (openLevel !== null)
                kept.push(text);
            continue;
        }
        if (openLevel !== null || RELEVANT.test(text))
            kept.push(text);
    }
    return kept.join('\n');
}
//# sourceMappingURL=guidance-sections.js.map