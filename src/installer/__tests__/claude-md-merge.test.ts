/**
 * Tests for CLAUDE.md Merge (Task T5)
 * Tests merge-based CLAUDE.md updates with markers and backups
 */

import { describe, it, expect } from 'vitest';
import { mergeClaudeMd } from '../index.js';

const START_MARKER = '<!-- OMC:START -->';
const END_MARKER = '<!-- OMC:END -->';
const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
const USER_CUSTOMIZATIONS_RECOVERED = '<!-- User customizations (recovered from corrupted markers) -->';

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
    it('replaces only content between markers', () => {
      const existingContent = `Some header content\n\n${START_MARKER}\n# Old OMC Content\nOld stuff here.\n${END_MARKER}\n\nUser's custom content\nMore custom stuff`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result).toContain('Some header content');
      expect(result).toContain(omcContent);
      expect(result).toContain('User\'s custom content');
      expect(result).not.toContain('Old OMC Content');
      expect(result).not.toContain('Old stuff here');
    });

    it('preserves content before and after markers', () => {
      const beforeContent = 'This is before the marker\n\n';
      const afterContent = '\n\nThis is after the marker';
      const existingContent = `${beforeContent}${START_MARKER}\nOld content\n${END_MARKER}${afterContent}`;
      const result = mergeClaudeMd(existingContent, omcContent);

      expect(result.startsWith(beforeContent)).toBe(true);
      expect(result.endsWith(afterContent)).toBe(true);
      expect(result).toContain(omcContent);
    });

    it('maintains exact structure with proper newlines', () => {
      const existingContent = `Header\n${START_MARKER}\nOld\n${END_MARKER}\nFooter`;
      const result = mergeClaudeMd(existingContent, omcContent);
      const expected = `Header\n${START_MARKER}\n${omcContent}\n${END_MARKER}\nFooter`;
      expect(result).toBe(expected);
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
      expect(result).toContain(existingContent);
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
});
