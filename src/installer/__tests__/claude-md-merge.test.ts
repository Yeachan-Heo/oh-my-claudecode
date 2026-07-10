/**
 * Tests for CLAUDE.md Merge (Task T5)
 * Tests merge-based CLAUDE.md updates with markers and backups
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { mergeClaudeMd, hasLegacyUnmarkedOmcContent, hasLegacyTemplateMatch } from '../index.js';

const START_MARKER = '<!-- OMC:START -->';
const END_MARKER = '<!-- OMC:END -->';
const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
const USER_CUSTOMIZATIONS_RECOVERED = '<!-- User customizations (recovered from corrupted markers) -->';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readLegacyGuide = (name: string): string =>
  readFileSync(join(FIXTURES_DIR, name), 'utf-8').replace(/\n+$/, '');
const LEGACY_HEADING = '# oh-my-claudecode - Intelligent Multi-Agent Orchestration';
const CONDUCTOR = 'You are a CONDUCTOR, not a performer';

describe('mergeClaudeMd', () => {
  const omcContent = '# OMC Configuration\n\nThis is the OMC content.';

  describe('Fresh install (no existing content)', () => {
    it('wraps omcContent in markers', () => {
      const result = mergeClaudeMd(null, omcContent);

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result.indexOf(START_MARKER)).toBeLessThan(result.indexOf(omcContent));
      expect(result.indexOf(omcContent)).toBeLessThan(result.indexOf(END_MARKER));
    });

    it('has correct structure for fresh install', () => {
      const result = mergeClaudeMd(null, omcContent);
      const expected = `${START_MARKER}\n${omcContent}\n${END_MARKER}\n`;
      expect(result).toBe(expected);
    });
  });

  describe('Update existing content with markers', () => {
    it('removes all marker blocks and preserves only user content outside them', () => {
      const existingContent = `Some header content\n\n${START_MARKER}\n# Old OMC Content\nOld stuff here.\n${END_MARKER}\n\nUser's custom content\nMore custom stuff`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(omcContent);
      expect(result).toContain(USER_CUSTOMIZATIONS);
      expect(result).toContain('Some header content');
      expect(result).toContain('User\'s custom content');
      expect(result).not.toContain('Old OMC Content');
      expect(result).not.toContain('Old stuff here');
      expect((result.match(/<!-- OMC:START -->/g) || []).length).toBe(1);
      expect((result.match(/<!-- OMC:END -->/g) || []).length).toBe(1);
    });

    it('normalizes preserved content under the user customizations section', () => {
      const beforeContent = 'This is before the marker\n\n';
      const afterContent = '\n\nThis is after the marker';
      const existingContent = `${beforeContent}${START_MARKER}\nOld content\n${END_MARKER}${afterContent}`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result.startsWith(`${START_MARKER}\n${omcContent}\n${END_MARKER}`)).toBe(true);
      expect(result).toContain(USER_CUSTOMIZATIONS);
      expect(result).toContain('This is before the marker');
      expect(result).toContain('This is after the marker');
      expect(result).toContain(omcContent);
    });

    it('keeps remaining user content after stripping marker blocks', () => {
      const existingContent = `Header\n${START_MARKER}\nOld\n${END_MARKER}\nFooter`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toBe(`${START_MARKER}\n${omcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\nHeader\nFooter`);
    });
  });

  describe('No markers in existing content', () => {
    it('wraps omcContent in markers and preserves existing content after user customizations header', () => {
      const existingContent = '# My Custom Config\n\nCustom settings here.';
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result).toContain(USER_CUSTOMIZATIONS);
      expect(result).toContain('# My Custom Config');
      expect(result).toContain('Custom settings here.');

      // Check order: OMC section first, then user customizations header, then existing content
      const omcIndex = result.indexOf(START_MARKER);
      const customizationsIndex = result.indexOf(USER_CUSTOMIZATIONS);
      const existingIndex = result.indexOf('# My Custom Config');

      expect(omcIndex).toBeLessThan(customizationsIndex);
      expect(customizationsIndex).toBeLessThan(existingIndex);
    });

    it('has correct structure when adding markers to existing content', () => {
      const existingContent = 'Existing content';
      const result = mergeClaudeMd(existingContent, omcContent);
      const expected = `${START_MARKER}\n${omcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${existingContent}`;
      expect(result).toBe(expected);
    });
  });

  describe('Corrupted markers', () => {
    it('handles START marker without END marker', () => {
      const existingContent = `${START_MARKER}\nSome content\nMore content`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result).toContain(USER_CUSTOMIZATIONS_RECOVERED);
      // Original corrupted content should be preserved after user customizations
      expect(result).toContain('Some content');
    });

    it('handles END marker without START marker', () => {
      const existingContent = `Some content\n${END_MARKER}\nMore content`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result).toContain(USER_CUSTOMIZATIONS_RECOVERED);
      // Original corrupted content should be preserved
      expect(result).toContain('Some content');
      expect(result).toContain('More content');
    });

    it('handles END marker before START marker (invalid order)', () => {
      const existingContent = `${END_MARKER}\nContent\n${START_MARKER}`;
      const result = mergeClaudeMd(existingContent, omcContent);

      // Should treat as corrupted and wrap new content, preserving old
      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result).toContain(USER_CUSTOMIZATIONS_RECOVERED);
    });

    it('does not grow unboundedly when called repeatedly with corrupted markers', () => {
      // Regression: corrupted markers caused existingContent (including corrupted markers)
      // to be appended as-is. Next call re-detected corruption, appended again → unbounded growth.
      const corruptedContent = `${START_MARKER}\nUser stuff\nMore user stuff`;
      const firstResult = mergeClaudeMd(corruptedContent, omcContent);

      // Call again with the output of the first call
      const secondResult = mergeClaudeMd(firstResult, omcContent);

      // The file should NOT grow unboundedly — second call should produce
      // similar or equal length output as the first call
      expect(secondResult.length).toBeLessThanOrEqual(firstResult.length * 1.1);

      // The corrupted markers should be stripped from recovered content
      // so re-processing doesn't re-detect corruption and re-append
      const thirdResult = mergeClaudeMd(secondResult, omcContent);
      expect(thirdResult.length).toBeLessThanOrEqual(secondResult.length * 1.1);
    });

    it('strips unmatched OMC markers from recovered content', () => {
      const corruptedContent = `${START_MARKER}\nUser custom config`;
      const result = mergeClaudeMd(corruptedContent, omcContent);

      // The recovered section should not contain bare OMC markers
      // Count occurrences of START_MARKER: should only appear once (in the OMC block)
      const startMarkerCount = (result.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      expect(startMarkerCount).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('handles empty omcContent', () => {
      const existingContent = `${START_MARKER}\nOld content\n${END_MARKER}`;
      const result = mergeClaudeMd(existingContent, '');

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).not.toContain('Old content');
    });

    it('handles whitespace-only existing content', () => {
      const existingContent = '   \n\n   ';
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
      expect(result).toContain(omcContent);
      expect(result).not.toContain(USER_CUSTOMIZATIONS);
    });

    it('handles multi-line omcContent', () => {
      const multiLineOmc = 'Line 1\nLine 2\nLine 3\n\nLine 5';
      const result = mergeClaudeMd(null, multiLineOmc);

      expect(result).toContain(multiLineOmc);
      expect(result.split('\n').length).toBeGreaterThan(5);
    });

    it('preserves multiple occurrences of marker-like text in user content', () => {
      const existingContent = `${START_MARKER}\nOMC Content\n${END_MARKER}\n\nUser content mentions ${START_MARKER} in text`;
      const result = mergeClaudeMd(existingContent, omcContent);

      // Only first pair of markers should be used
      expect(result).toContain(omcContent);
      expect(result).toContain('User content mentions');
      expect(result.split(START_MARKER).length).toBe(3); // Two START_MARKERs total (one pair + one in text)
    });

    it('handles very large existing content', () => {
      const largeContent = 'x'.repeat(100000);
      const existingContent = `${START_MARKER}\nOld\n${END_MARKER}\n${largeContent}`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain(omcContent);
      expect(result).toContain(largeContent);
      expect(result.length).toBeGreaterThan(100000);
    });
  });

  describe('Real-world scenarios', () => {
    it('handles typical fresh install scenario', () => {
      const result = mergeClaudeMd(null, omcContent);
      expect(result).toMatch(/^<!-- OMC:START -->\n.*\n<!-- OMC:END -->\n$/s);
    });

    it('handles typical update scenario with user customizations', () => {
      const existingContent = `${START_MARKER}
# Old OMC Config v1.0
Old instructions here.
${END_MARKER}

${USER_CUSTOMIZATIONS}
# My Project-Specific Instructions
- Use TypeScript strict mode
- Follow company coding standards`;

      const newOmcContent = '# OMC Config v2.0\nNew instructions with updates.';
      const result = mergeClaudeMd(existingContent, newOmcContent);

      expect(result).toContain('# OMC Config v2.0');
      expect(result).not.toContain('Old instructions here');
      expect(result).toContain('# My Project-Specific Instructions');
      expect(result).toContain('Follow company coding standards');
      expect((result.match(/<!-- OMC:START -->/g) || []).length).toBe(1);
      expect((result.match(/<!-- OMC:END -->/g) || []).length).toBe(1);
    });

    it('handles migration from old version without markers', () => {
      const oldContent = `# Legacy CLAUDE.md
Some old configuration
User added custom stuff here`;

      const result = mergeClaudeMd(oldContent, omcContent);

      // New OMC content should be at the top with markers
      expect(result.indexOf(START_MARKER)).toBeLessThan(result.indexOf('# Legacy CLAUDE.md'));
      expect(result).toContain(omcContent);
      expect(result).toContain(oldContent);
      expect(result).toContain(USER_CUSTOMIZATIONS);
    });
  });

  describe('idempotency guard', () => {
    it('strips markers from omcContent that already has markers', () => {
      // Simulate docs/CLAUDE.md shipping with markers already
      const omcWithMarkers = `<!-- OMC:START -->
# oh-my-claudecode
Agent instructions here
<!-- OMC:END -->`;

      const result = mergeClaudeMd(null, omcWithMarkers);

      // Should NOT have nested markers
      const startCount = (result.match(/<!-- OMC:START -->/g) || []).length;
      const endCount = (result.match(/<!-- OMC:END -->/g) || []).length;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
      expect(result).toContain('Agent instructions here');
    });

    it('handles omcContent with markers when merging into existing content', () => {
      const existingContent = `<!-- OMC:START -->
Old OMC content
<!-- OMC:END -->

<!-- User customizations -->
My custom stuff`;

      const omcWithMarkers = `<!-- OMC:START -->
New OMC content v2
<!-- OMC:END -->`;

      const result = mergeClaudeMd(existingContent, omcWithMarkers);

      // Should have exactly one pair of markers
      const startCount = (result.match(/<!-- OMC:START -->/g) || []).length;
      const endCount = (result.match(/<!-- OMC:END -->/g) || []).length;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
      expect(result).toContain('New OMC content v2');
      expect(result).not.toContain('Old OMC content');
      expect(result).toContain('My custom stuff');
    });
  });

  describe('version marker sync', () => {
    it('injects the provided version marker on fresh install', () => {
      const result = mergeClaudeMd(null, omcContent, '4.6.7');

      expect(result).toContain('<!-- OMC:VERSION:4.6.7 -->');
      expect(result).toContain(START_MARKER);
      expect(result).toContain(END_MARKER);
    });

    it('replaces stale version marker when updating existing marker block', () => {
      const existingContent = `${START_MARKER}
<!-- OMC:VERSION:4.5.0 -->
Old content
${END_MARKER}

${USER_CUSTOMIZATIONS}
my notes`;

      const result = mergeClaudeMd(existingContent, omcContent, '4.6.7');

      expect(result).toContain('<!-- OMC:VERSION:4.6.7 -->');
      expect(result).not.toContain('<!-- OMC:VERSION:4.5.0 -->');
      expect((result.match(/<!-- OMC:VERSION:/g) || []).length).toBe(1);
      expect(result).toContain('my notes');
    });

    it('strips embedded version marker from omc content before inserting current version', () => {
      const omcWithVersion = `<!-- OMC:VERSION:4.0.0 -->\n${omcContent}`;

      const result = mergeClaudeMd(null, omcWithVersion, '4.6.7');

      expect(result).toContain('<!-- OMC:VERSION:4.6.7 -->');
      expect(result).not.toContain('<!-- OMC:VERSION:4.0.0 -->');
      expect((result.match(/<!-- OMC:VERSION:/g) || []).length).toBe(1);
    });
  });

  describe('issue #1467 regression', () => {
    it('removes duplicate legacy OMC blocks from preserved user content', () => {
      const existingContent = `${START_MARKER}
Old OMC content v1
${END_MARKER}

${USER_CUSTOMIZATIONS}
My note before duplicate block

${START_MARKER}
Older duplicate block
${END_MARKER}

My note after duplicate block`;

      const result = mergeClaudeMd(existingContent, omcContent);

      expect((result.match(/<!-- OMC:START -->/g) || []).length).toBe(1);
      expect((result.match(/<!-- OMC:END -->/g) || []).length).toBe(1);
      expect(result).toContain(USER_CUSTOMIZATIONS);
      expect(result).toContain('My note before duplicate block');
      expect(result).toContain('My note after duplicate block');
      expect(result).not.toContain('Old OMC content v1');
      expect(result).not.toContain('Older duplicate block');
    });

    it('removes autogenerated user customization headers while preserving real user text', () => {
      const existingContent = `${START_MARKER}
Old OMC content
${END_MARKER}

<!-- User customizations (migrated from previous CLAUDE.md) -->
First user note

<!-- User customizations -->
Second user note`;

      const result = mergeClaudeMd(existingContent, omcContent);

      expect((result.match(/<!-- User customizations/g) || []).length).toBe(1);
      expect(result).toContain(`${USER_CUSTOMIZATIONS}\nFirst user note\n\nSecond user note`);
    });
  });

  describe('legacy unmarked OMC guide removal (exact historical templates)', () => {
    const guide292 = readLegacyGuide('legacy-guide-292.md');
    const guide583 = readLegacyGuide('legacy-guide-583.md');

    // Simulate an upgraded CLAUDE.md: current marker block on top, then one or
    // more legacy guides plus real user content preserved under customizations.
    const buildUpgraded = (body: string): string =>
      `${START_MARKER}\n${omcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${body}`;

    it('(a) fully removes the 583-line historical guide, keeping user content', () => {
      const existing = buildUpgraded(`${guide583}\n\n@RTK.md`);
      const result = mergeClaudeMd(existing, omcContent, '4.15.0');

      expect(result).not.toContain(CONDUCTOR);
      expect(result).not.toContain(LEGACY_HEADING);
      expect(result).not.toContain('## PART 3: COMPLETE REFERENCE');
      // The guide's final line must be gone (end-boundary proof, not fingerprint).
      expect(result).not.toContain(guide583.split('\n').at(-1)!);
      expect(result).toContain('@RTK.md');
      expect(result).toContain(omcContent);
      expect(result).toContain('<!-- OMC:VERSION:4.15.0 -->');
      expect(result.length).toBeLessThan(existing.length / 2);
    });

    it('(b) preserves user notes that merely quote two fingerprints (no false-positive span)', () => {
      const body = [
        'My orchestration playbook:',
        `- I love the line "${CONDUCTOR}".`,
        'KEEP-MIDDLE-USER-NOTE',
        '- and remember "PART 1: CORE PROTOCOL" from the old guide.'
      ].join('\n');
      const result = mergeClaudeMd(buildUpgraded(body), omcContent);

      expect(result).toContain('KEEP-MIDDLE-USER-NOTE');
      expect(result).toContain(CONDUCTOR);
      expect(result).toContain('PART 1: CORE PROTOCOL');
    });

    it('(b) preserves user notes with reversed fingerprint order and the shared heading above', () => {
      const body = [
        LEGACY_HEADING,
        '- quoting "PART 1: CORE PROTOCOL" first,',
        'KEEP-MIDDLE-USER-NOTE',
        `- then "${CONDUCTOR}".`
      ].join('\n');
      const result = mergeClaudeMd(buildUpgraded(body), omcContent);

      expect(result).toContain('KEEP-MIDDLE-USER-NOTE');
      expect(result).toContain(LEGACY_HEADING);
      expect(result).toContain(CONDUCTOR);
      expect(result).toContain('PART 1: CORE PROTOCOL');
    });

    it('(c) removes two complete legacy blocks without spanning the user note between them', () => {
      const body = `${guide292}\n\nMIDDLE-USER-NOTE\n\n${guide583}\n\n@RTK.md`;
      const result = mergeClaudeMd(buildUpgraded(body), omcContent);

      expect(result).not.toContain(CONDUCTOR); // both blocks gone
      expect(result).not.toContain(LEGACY_HEADING);
      expect(result).toContain('MIDDLE-USER-NOTE'); // content between blocks preserved
      expect(result).toContain('@RTK.md');
    });

    it('(f) removes the 292-line historical guide (v1 scenario) and its CRLF variant', () => {
      const existing = buildUpgraded(`${guide292}\n\n@RTK.md`);

      const lf = mergeClaudeMd(existing, omcContent);
      expect(lf).not.toContain(CONDUCTOR);
      expect(lf).toContain('@RTK.md');

      const crlf = mergeClaudeMd(existing.replace(/\n/g, '\r\n'), omcContent);
      expect(crlf).not.toContain(CONDUCTOR);
      expect(crlf).toContain('@RTK.md');
    });

    it('(g) shrinks a bloated file and is idempotent (never grows)', () => {
      const existing = buildUpgraded(`${guide583}\n\n@RTK.md`);
      const first = mergeClaudeMd(existing, omcContent, '4.15.0');
      expect(first.length).toBeLessThan(existing.length);

      // Re-running the merge on its own output must not regrow the file.
      const second = mergeClaudeMd(first, omcContent, '4.15.0');
      expect(second.length).toBeLessThanOrEqual(first.length);
      expect(second).toContain('@RTK.md');
      expect(second).not.toContain(CONDUCTOR);
    });

    it('fails closed on a near-miss variant (fingerprints present but no exact template match)', () => {
      // A guide with an extra line inserted no longer matches any historical
      // template and must be preserved verbatim rather than partially deleted.
      const mutated = guide292.replace(CONDUCTOR, `${CONDUCTOR}\nMY-EXTRA-USER-LINE`);
      const result = mergeClaudeMd(buildUpgraded(`${mutated}\n\n@RTK.md`), omcContent);

      expect(result).toContain(CONDUCTOR); // preserved, not stripped
      expect(result).toContain('@RTK.md');
      // But the doctor heuristic still flags it for manual review.
      expect(hasLegacyUnmarkedOmcContent(mutated)).toBe(true);
      expect(hasLegacyTemplateMatch(mutated)).toBe(false);
    });

    it('exposes detection helpers scoped to content outside markers', () => {
      expect(hasLegacyTemplateMatch(guide583)).toBe(true);
      expect(hasLegacyUnmarkedOmcContent(guide292)).toBe(true);
      expect(hasLegacyUnmarkedOmcContent('just my own notes')).toBe(false);

      // Fingerprints living only inside a valid marker block are not flagged.
      const insideMarkersOnly = `${START_MARKER}\n${guide292}\n${END_MARKER}\n`;
      expect(hasLegacyUnmarkedOmcContent(insideMarkersOnly)).toBe(false);
    });
  });
});
