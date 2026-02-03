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
  it('should strip basic color codes', () => {
    const input = '\x1b[31mRed text\x1b[0m';
    expect(stripAnsi(input)).toBe('Red text');
  });

  it('should strip bold and dim codes', () => {
    const input = '\x1b[1mBold\x1b[0m and \x1b[2mDim\x1b[0m';
    expect(stripAnsi(input)).toBe('Bold and Dim');
  });

  it('should strip multiple color codes', () => {
    const input = '\x1b[32mGreen\x1b[0m \x1b[33mYellow\x1b[0m \x1b[34mBlue\x1b[0m';
    expect(stripAnsi(input)).toBe('Green Yellow Blue');
  });

  it('should strip complex CSI sequences', () => {
    const input = '\x1b[38;5;196mExtended color\x1b[0m';
    expect(stripAnsi(input)).toBe('Extended color');
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
  it('should strip ANSI and replace blocks in single line', () => {
    const input = '\x1b[32m████░░░░░░\x1b[0m 40%';
    expect(sanitizeOutput(input)).toBe('####------ 40%');
  });

  it('should collapse multi-line output to single line', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    expect(sanitizeOutput(input)).toBe('Line 1 | Line 2 | Line 3');
  });

  it('should handle complex HUD output', () => {
    const input = '\x1b[1m[OMC]\x1b[0m | \x1b[32m████░░░░░░\x1b[0m 40% | agents:3';
    expect(sanitizeOutput(input)).toBe('[OMC] | ####------ 40% | agents:3');
  });

  it('should filter empty lines', () => {
    const input = 'Line 1\n\n\nLine 2\n\n';
    expect(sanitizeOutput(input)).toBe('Line 1 | Line 2');
  });

  it('should collapse excessive whitespace', () => {
    const input = 'Text    with   extra    spaces';
    expect(sanitizeOutput(input)).toBe('Text with extra spaces');
  });

  it('should handle real HUD multi-line output', () => {
    const input = `\x1b[1m[OMC]\x1b[0m | \x1b[2m5h:\x1b[0m\x1b[32m12%\x1b[0m | Ctx: \x1b[32m████░░░░░░\x1b[0m 40%
\x1b[2m└─\x1b[0m \x1b[35mO\x1b[0m:architect (2m) analyzing code
\x1b[2m└─\x1b[0m \x1b[33ms\x1b[0m:executor (1m) writing tests`;

    const result = sanitizeOutput(input);

    // Should be single line, no ANSI, ASCII blocks
    expect(result).not.toContain('\x1b');
    expect(result).not.toContain('█');
    expect(result).not.toContain('░');
    expect(result).not.toContain('\n');
    expect(result).toContain('[OMC]');
    expect(result).toContain('architect');
  });

  it('should return empty string for whitespace-only input', () => {
    expect(sanitizeOutput('   \n   \n   ')).toBe('');
  });

  it('should handle single line output without modification', () => {
    const input = '[OMC] | 40% | agents:3';
    expect(sanitizeOutput(input)).toBe('[OMC] | 40% | agents:3');
  });
});
