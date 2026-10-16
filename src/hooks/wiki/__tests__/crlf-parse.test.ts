import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../storage.js';

describe('parseFrontmatter CRLF handling', () => {
  it('should parse LF frontmatter (baseline)', () => {
    const raw = '---\ntitle: Test\ntags: []\n---\n\n# Content\n';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe('Test');
  });

  it('should parse CRLF frontmatter', () => {
    const raw = '---\r\ntitle: Test\r\ntags: []\r\n---\r\n\r\n# Content\r\n';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe('Test');
  });

  it('should parse mixed line endings', () => {
    const raw = '---\r\ntitle: Mixed\ntags: []\r\n---\n\n# Content\n';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe('Mixed');
  });
});

describe('parseFrontmatter UTF-8 BOM handling', () => {
  it('should parse frontmatter after a leading BOM', () => {
    const raw = '\uFEFF---\ntitle: Bom\ntags: []\n---\n\n# Content\uFEFF tail\n';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe('Bom');
    expect(result!.content).toBe('\n# Content\uFEFF tail\n');
  });

  it('should parse CRLF frontmatter after a leading BOM', () => {
    const raw = '﻿---\r\ntitle: Bom\r\ntags: []\r\n---\r\n\r\n# Content\r\n';
    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe('Bom');
  });
});
