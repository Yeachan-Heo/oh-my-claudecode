/**
 * Tests for HUD output sanitizer (Issue #346)
 *
 * Verifies that the sanitizer properly handles:
 * - ANSI escape sequences
 * - Unicode block characters
 * - Multi-line output
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi, replaceUnicodeBlocks, sanitizeOutput } from '../../hud/sanitize.js';

describe('stripAnsi', () => {
  it('should PRESERVE basic color codes (SGR sequences)', () => {
    const input = '\x1b[31mRed text\x1b[0m';
    expect(stripAnsi(input)).toBe('\x1b[31mRed text\x1b[0m');
  });

  it('should PRESERVE bold and dim codes', () => {
    const input = '\x1b[1mBold\x1b[0m and \x1b[2mDim\x1b[0m';
    expect(stripAnsi(input)).toBe('\x1b[1mBold\x1b[0m and \x1b[2mDim\x1b[0m');
  });

  it('should PRESERVE multiple color codes', () => {
    const input = '\x1b[32mGreen\x1b[0m \x1b[33mYellow\x1b[0m \x1b[34mBlue\x1b[0m';
    expect(stripAnsi(input)).toBe('\x1b[32mGreen\x1b[0m \x1b[33mYellow\x1b[0m \x1b[34mBlue\x1b[0m');
  });

  it('should PRESERVE complex SGR sequences (256 color, RGB)', () => {
    const input = '\x1b[38;5;196mExtended color\x1b[0m';
    expect(stripAnsi(input)).toBe('\x1b[38;5;196mExtended color\x1b[0m');
  });

  it('should STRIP cursor movement sequences', () => {
    // Cursor up (A), down (B), forward (C), back (D)
    const input = '\x1b[5Aup\x1b[3Bdown\x1b[2Cforward\x1b[4Dback';
    expect(stripAnsi(input)).toBe('updownforwardback');
  });

  it('should STRIP cursor position sequences', () => {
    // H: cursor position, f: horizontal vertical position
    const input = '\x1b[10;20Hpositioned\x1b[5;10ftext';
    expect(stripAnsi(input)).toBe('positionedtext');
  });

  it('should STRIP erase sequences', () => {
    // J: erase display, K: erase line
    const input = '\x1b[2Jcleared\x1b[Kerased';
    expect(stripAnsi(input)).toBe('clearederased');
  });

  it('should STRIP cursor visibility sequences', () => {
    // ?25l: hide cursor, ?25h: show cursor
    const input = '\x1b[?25lhidden\x1b[?25hvisible';
    expect(stripAnsi(input)).toBe('hiddenvisible');
  });

  it('should STRIP OSC sequences (operating system commands)', () => {
    // OSC for setting terminal title
    const input = '\x1b]0;Window Title\x07Some text';
    expect(stripAnsi(input)).toBe('Some text');
  });

  it('should handle mixed SGR and control sequences', () => {
    // Color codes should be preserved, cursor movement stripped
    const input = '\x1b[2J\x1b[H\x1b[32mGreen text\x1b[0m\x1b[10;1H';
    expect(stripAnsi(input)).toBe('\x1b[32mGreen text\x1b[0m');
  });

  it('should handle text without ANSI codes', () => {
    const input = 'Plain text without codes';
    expect(stripAnsi(input)).toBe('Plain text without codes');
  });

  it('should handle empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('replaceUnicodeBlocks', () => {
  it('should replace filled block with hash', () => {
    expect(replaceUnicodeBlocks('████')).toBe('####');
  });

  it('should replace empty block with dash', () => {
    expect(replaceUnicodeBlocks('░░░░')).toBe('----');
  });

  it('should replace mixed blocks', () => {
    expect(replaceUnicodeBlocks('██░░')).toBe('##--');
  });

  it('should replace shaded blocks', () => {
    expect(replaceUnicodeBlocks('▓▒')).toBe('=-');
  });

  it('should handle progress bar pattern', () => {
    const progressBar = '████░░░░░░';
    expect(replaceUnicodeBlocks(progressBar)).toBe('####------');
  });

  it('should handle text without unicode blocks', () => {
    const input = 'Normal text';
    expect(replaceUnicodeBlocks(input)).toBe('Normal text');
  });
});

describe('sanitizeOutput', () => {
  it('should PRESERVE colors and replace blocks in single line', () => {
    const input = '\x1b[32m████░░░░░░\x1b[0m 40%';
    expect(sanitizeOutput(input)).toBe('\x1b[32m####------\x1b[0m 40%');
  });

  it('should PRESERVE multi-line output with newlines', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    expect(sanitizeOutput(input)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should handle complex HUD output preserving colors', () => {
    const input = '\x1b[1m[OMC]\x1b[0m | \x1b[32m████░░░░░░\x1b[0m 40% | agents:3';
    expect(sanitizeOutput(input)).toBe('\x1b[1m[OMC]\x1b[0m | \x1b[32m####------\x1b[0m 40% | agents:3');
  });

  it('should preserve lines and trim trailing whitespace', () => {
    const input = 'Line 1\n\n\nLine 2\n\n';
    expect(sanitizeOutput(input)).toBe('Line 1\n\n\nLine 2');
  });

  it('should preserve whitespace within lines', () => {
    const input = 'Text    with   extra    spaces';
    expect(sanitizeOutput(input)).toBe('Text    with   extra    spaces');
  });

  it('should handle real HUD multi-line output with colors and newlines preserved', () => {
    const input = `\x1b[1m[OMC]\x1b[0m | \x1b[2m5h:\x1b[0m\x1b[32m12%\x1b[0m | Ctx: \x1b[32m████░░░░░░\x1b[0m 40%
\x1b[2m└─\x1b[0m \x1b[35mO\x1b[0m:architect (2m) analyzing code
\x1b[2m└─\x1b[0m \x1b[33ms\x1b[0m:executor (1m) writing tests`;

    const result = sanitizeOutput(input);

    // Should preserve multi-line structure with ASCII blocks and colors
    expect(result).not.toContain('█');
    expect(result).not.toContain('░');
    expect(result).toContain('\n'); // PRESERVE newlines for tree structure
    expect(result).toContain('[OMC]');
    expect(result).toContain('architect');
    // Colors SHOULD be present (SGR sequences ending with 'm')
    expect(result).toContain('\x1b[32m'); // green
    expect(result).toContain('\x1b[35m'); // magenta
    expect(result).toContain('\x1b[0m'); // reset
  });

  it('should strip cursor control sequences but preserve colors', () => {
    // Input with cursor positioning mixed with colors
    const input = '\x1b[H\x1b[2J\x1b[32mColored text\x1b[0m\x1b[10;1H';
    expect(sanitizeOutput(input)).toBe('\x1b[32mColored text\x1b[0m');
  });

  it('should return empty string for whitespace-only input', () => {
    expect(sanitizeOutput('   \n   \n   ')).toBe('');
  });

  it('should handle single line output without modification', () => {
    const input = '[OMC] | 40% | agents:3';
    expect(sanitizeOutput(input)).toBe('[OMC] | 40% | agents:3');
  });
});
