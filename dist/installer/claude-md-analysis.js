import { createHash } from 'crypto';
import { LEGACY_CLAUDE_MD_VARIANTS } from './legacy-claude-md-corpus.js';
/** Decodes valid UTF-8 without silently stripping a leading byte-order mark. */
export function decodeClaudeMdUtf8(bytes, path) {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        throw new Error(`Invalid UTF-8: ${path}`);
    }
}
export const OMC_START_MARKER = '<!-- OMC:START -->';
export const OMC_END_MARKER = '<!-- OMC:END -->';
function emptyCounters() {
    return { lineVisits: 0, parserSteps: 0, candidateWindows: 0, bytesHashed: 0 };
}
function hasBareCarriageReturn(content) {
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '\r' && content[index + 1] !== '\n')
            return true;
    }
    return false;
}
/** Parse source coordinates without altering any input byte or EOL spelling. */
export function parseClaudeMdLines(content) {
    const lines = [];
    let start = 0;
    for (let index = 0; index < content.length;) {
        if (content[index] !== '\n') {
            index += 1;
            continue;
        }
        const contentEnd = index > start && content[index - 1] === '\r' ? index - 1 : index;
        lines.push({ start, contentEnd, eolEnd: index + 1, text: content.slice(start, contentEnd), eol: contentEnd === index ? '\n' : '\r\n' });
        start = index + 1;
        index += 1;
    }
    if (start < content.length)
        lines.push({ start, contentEnd: content.length, eolEnd: content.length, text: content.slice(start), eol: '' });
    return lines;
}
function outsideRanges(length, managedRanges) {
    const result = [];
    let cursor = 0;
    for (const range of managedRanges) {
        if (cursor < range.start)
            result.push({ start: cursor, end: range.start });
        cursor = range.end;
    }
    if (cursor < length)
        result.push({ start: cursor, end: length });
    return result;
}
/**
 * Parse exact, standalone marker lines. Any ordering, nesting, duplicate, or
 * unmatched marker makes the complete structure corrupt and exposes no ranges.
 */
export function parseClaudeMdMarkers(content) {
    const counters = emptyCounters();
    const lines = parseClaudeMdLines(content);
    counters.lineVisits = lines.length;
    counters.parserSteps = lines.length;
    const diagnostics = [];
    if (hasBareCarriageReturn(content))
        diagnostics.push('bare-carriage-return');
    const pairs = [];
    let open;
    let sawMarker = false;
    for (const line of lines) {
        if (line.text !== OMC_START_MARKER && line.text !== OMC_END_MARKER)
            continue;
        sawMarker = true;
        counters.parserSteps += 2;
        if (line.text === OMC_START_MARKER) {
            if (open)
                diagnostics.push('nested-or-duplicate-start');
            else
                open = line;
        }
        else if (!open) {
            diagnostics.push('unmatched-end');
        }
        else {
            pairs.push({ start: open.start, contentStart: open.eolEnd, contentEnd: line.start, end: line.eolEnd });
            open = undefined;
        }
    }
    if (open)
        diagnostics.push('unmatched-start');
    if (diagnostics.length > 0)
        return { state: 'corrupt', lines, managedRanges: [], outsideRanges: [{ start: 0, end: content.length }], diagnostics, counters };
    if (!sawMarker)
        return { state: 'none', lines, managedRanges: [], outsideRanges: content.length ? [{ start: 0, end: content.length }] : [], diagnostics, counters };
    return { state: 'complete', lines, managedRanges: pairs, outsideRanges: outsideRanges(content.length, pairs), diagnostics, counters };
}
function normalizedWindow(lines, start, count) {
    let value = '';
    for (let index = start; index < start + count; index += 1) {
        const line = lines[index];
        value += line.text;
        if (line.eol)
            value += '\n';
    }
    return value;
}
/** Exact identity matcher. Only LF/CRLF spelling is normalized; all line content is literal. */
export function analyzeLegacyClaudeMd(content) {
    const markers = parseClaudeMdMarkers(content);
    const counters = { ...markers.counters };
    if (markers.state === 'corrupt')
        return { markers, exactMatches: [], manualFindings: [], counters };
    const variantsByOpening = new Map();
    for (const variant of LEGACY_CLAUDE_MD_VARIANTS) {
        const variants = variantsByOpening.get(variant.openingLine) ?? [];
        variants.push(variant);
        variantsByOpening.set(variant.openingLine, variants);
    }
    const rawMatches = [];
    const manuals = [];
    let lineCursor = 0;
    for (const segment of markers.outsideRanges) {
        while (lineCursor < markers.lines.length && markers.lines[lineCursor].eolEnd <= segment.start)
            lineCursor += 1;
        const segmentStart = lineCursor;
        while (lineCursor < markers.lines.length && markers.lines[lineCursor].eolEnd <= segment.end)
            lineCursor += 1;
        const segmentLines = markers.lines.slice(segmentStart, lineCursor);
        counters.lineVisits += segmentLines.length;
        for (let start = 0; start < segmentLines.length; start += 1) {
            const candidates = variantsByOpening.get(segmentLines[start].text);
            if (!candidates)
                continue;
            let exactAtStart = false;
            for (const variant of candidates) {
                const last = segmentLines[start + variant.lineCount - 1];
                if (!last || last.text !== variant.finalLine)
                    continue;
                if (variant.terminalEolPolicy === 'required' && !last.eol)
                    continue;
                if (variant.terminalEolPolicy === 'forbidden' && last.eol)
                    continue;
                const normalized = normalizedWindow(segmentLines, start, variant.lineCount);
                counters.candidateWindows += 1;
                const bytes = Buffer.byteLength(normalized, 'utf8');
                counters.bytesHashed += bytes;
                const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
                if (digest === variant.normalizedSha256) {
                    rawMatches.push({ start: segmentLines[start].start, end: last.eolEnd, variantId: variant.id });
                    exactAtStart = true;
                }
            }
            // A bounded warning is deliberately weaker than exact matching.
            if (!exactAtStart && candidates.length > 0) {
                const longest = Math.max(...candidates.map(variant => variant.lineCount));
                const endLine = segmentLines[Math.min(segmentLines.length - 1, start + longest - 1)];
                manuals.push({ start: segmentLines[start].start, end: endLine.eolEnd, reason: 'legacy-opening-line-without-exact-identity' });
            }
        }
    }
    // Same-start longest match wins. Connected matches from different starts are ambiguous.
    const sameStart = new Map();
    for (const match of rawMatches) {
        const current = sameStart.get(match.start);
        if (!current || match.end > current.end)
            sameStart.set(match.start, match);
    }
    const sorted = [...sameStart.values()].sort((left, right) => left.start - right.start || right.end - left.end);
    const accepted = [];
    for (let index = 0; index < sorted.length;) {
        let end = sorted[index].end;
        let cursor = index + 1;
        while (cursor < sorted.length && sorted[cursor].start < end) {
            end = Math.max(end, sorted[cursor].end);
            cursor += 1;
        }
        if (cursor === index + 1)
            accepted.push(sorted[index]);
        else
            manuals.push({ start: sorted[index].start, end, reason: 'overlapping-exact-candidates' });
        index = cursor;
    }
    const exactRanges = accepted.map(match => ({ start: match.start, end: match.end }));
    const manualFindings = manuals.filter(manual => !exactRanges.some(exact => manual.start >= exact.start && manual.end <= exact.end));
    return { markers, exactMatches: accepted, manualFindings, counters };
}
/** Remove source-coordinate ranges descending so every retained slice is byte-for-byte unchanged. */
export function removeClaudeMdRanges(content, ranges) {
    const ordered = [...ranges].sort((left, right) => right.start - left.start || right.end - left.end);
    let result = content;
    let previousStart = content.length + 1;
    for (const range of ordered) {
        if (range.start < 0 || range.end < range.start || range.end > content.length || range.end > previousStart) {
            throw new Error('Claude MD ranges must be disjoint source ranges');
        }
        result = result.slice(0, range.start) + result.slice(range.end);
        previousStart = range.start;
    }
    return result;
}
export function getLegacyGuideManifestForVerification() {
    return LEGACY_CLAUDE_MD_VARIANTS;
}
//# sourceMappingURL=claude-md-analysis.js.map