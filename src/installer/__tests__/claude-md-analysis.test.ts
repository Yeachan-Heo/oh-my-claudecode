import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import corpus from './fixtures/legacy-guides.json' with { type: 'json' };
import {
  analyzeLegacyClaudeMd,
  getLegacyGuideManifestForVerification,
  parseClaudeMdMarkers,
  removeClaudeMdRanges,
} from '../claude-md-analysis.js';
import { mergeClaudeMd } from '../index.js';

type GoldenVariant = {
  id: string;
  sourceCommit: string;
  gitBlobSha: string;
  rawByteLength: number;
  rawSha256: string;
  lineCount: number;
  terminalEolPolicy: 'required' | 'forbidden' | 'either';
  normalizedSha256: string;
  openingLine: string;
  finalLine: string;
  markerless: true;
  dataBase64: string;
};

function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function physicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

describe('legacy CLAUDE.md corpus', () => {
  it('independently verifies all reviewed bytes and one-way runtime signatures', () => {
    const runtime = new Map(getLegacyGuideManifestForVerification().map(variant => [variant.id, variant]));
    const variants = corpus.variants as GoldenVariant[];
    expect(variants).toHaveLength(29);
    expect(new Set(variants.map(variant => variant.gitBlobSha)).size).toBe(29);

    for (const golden of variants) {
      const bytes = Buffer.from(golden.dataBase64, 'base64');
      const text = bytes.toString('utf8');
      const lines = physicalLines(text);
      expect(bytes.length).toBe(golden.rawByteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(golden.rawSha256);
      expect(gitBlobSha(bytes)).toBe(golden.gitBlobSha);
      expect(createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex')).toBe(golden.normalizedSha256);
      expect(lines).toHaveLength(golden.lineCount);
      expect(lines[0]).toBe(golden.openingLine);
      expect(lines.at(-1)).toBe(golden.finalLine);
      expect(text.includes('<!-- OMC:START -->')).toBe(false);
      const compiled = runtime.get(golden.id);
      expect(compiled).toMatchObject({
        sourceCommit: golden.sourceCommit,
        gitBlobSha: golden.gitBlobSha,
        rawByteLength: golden.rawByteLength,
        rawSha256: golden.rawSha256,
        lineCount: golden.lineCount,
        terminalEolPolicy: golden.terminalEolPolicy,
        normalizedSha256: golden.normalizedSha256,
        openingLine: golden.openingLine,
        finalLine: golden.finalLine,
        markerless: golden.markerless,
      });
    }
  });
});

describe('CLAUDE.md structural analysis', () => {
  it.each([
    { eol: '\n', terminalEol: '\n' },
    { eol: '\n', terminalEol: '' },
    { eol: '\r\n', terminalEol: '\r\n' },
    { eol: '\r\n', terminalEol: '' },
  ])('extracts only managed source content without closing-marker bytes (%j)', ({ eol, terminalEol }) => {
    const wrapped = `<!-- OMC:START -->${eol}canonical${eol}<!-- OMC:END -->${terminalEol}`;
    expect(mergeClaudeMd(null, wrapped)).toBe('<!-- OMC:START -->\ncanonical\n<!-- OMC:END -->\n');
  });

  it('rejects corrupt and multiple marker-wrapped canonical sources', () => {
    expect(() => mergeClaudeMd(null, '<!-- OMC:START -->\ncanonical')).toThrow('at most one complete managed block');
    expect(() => mergeClaudeMd(null, '<!-- OMC:START -->\na\n<!-- OMC:END -->\n<!-- OMC:START -->\nb\n<!-- OMC:END -->\n')).toThrow('at most one complete managed block');
  });

  it('does not join legacy-guide fragments across a managed block before analysis', () => {
    const guide = Buffer.from((corpus.variants as GoldenVariant[])[0].dataBase64, 'base64').toString('utf8');
    const split = guide.indexOf('\n', guide.length / 2) + 1;
    const existing = `${guide.slice(0, split)}<!-- OMC:START -->\nmanaged\n<!-- OMC:END -->\n${guide.slice(split)}`;
    expect(mergeClaudeMd(existing, 'new managed content')).toContain(guide);
  });

  it('pairs only standalone ordered marker lines and projects outside ranges', () => {
    const content = 'before\r\n<!-- OMC:START -->\r\nmanaged\r\n<!-- OMC:END -->\r\nafter\r\n';
    const parsed = parseClaudeMdMarkers(content);
    expect(parsed.managedRanges).toEqual([
      expect.objectContaining({
        contentStart: content.indexOf('managed'),
        contentEnd: content.indexOf('<!-- OMC:END -->'),
      }),
    ]);
    expect(parsed.state).toBe('complete');
    expect(parsed.outsideRanges.map(range => content.slice(range.start, range.end))).toEqual(['before\r\n', 'after\r\n']);
  });

  it.each([
    '<!-- OMC:START -->\n<!-- OMC:START -->\n<!-- OMC:END -->\n',
    '<!-- OMC:END -->\n<!-- OMC:START -->\n',
    '<!-- OMC:START -->\n',
    'before\rbroken',
  ])('fails closed for malformed marker input', content => {
    expect(parseClaudeMdMarkers(content).state).toBe('corrupt');
    expect(analyzeLegacyClaudeMd(content).exactMatches).toEqual([]);
  });

  it('matches only exact historical content and retains user EOL bytes', () => {
    const golden = (corpus.variants as GoldenVariant[])[0];
    const guide = Buffer.from(golden.dataBase64, 'base64').toString('utf8');
    const crlf = guide.replace(/\n/g, '\r\n');
    const content = `before\r\n${crlf}after\r\n`;
    const analysis = analyzeLegacyClaudeMd(content);
    expect(analysis.exactMatches).toHaveLength(1);
    expect(analysis.counters.candidateWindows).toBeGreaterThan(0);
    expect(analysis.counters.bytesHashed).toBeGreaterThan(0);
    expect(removeClaudeMdRanges(content, analysis.exactMatches)).toBe('before\r\nafter\r\n');
    expect(analyzeLegacyClaudeMd(`\uFEFF${guide}`).exactMatches).toEqual([]);
    expect(analyzeLegacyClaudeMd(guide.replace(/\n/, ' \n')).exactMatches).toEqual([]);
    expect(analyzeLegacyClaudeMd(guide.replace(/\n/, '\t\n')).exactMatches).toEqual([]);
  });

  it('recognizes every reviewed variant, including the 292 and 583 line forms', () => {
    const variants = corpus.variants as GoldenVariant[];
    expect(variants.some(variant => variant.lineCount === 292)).toBe(true);
    expect(variants.some(variant => variant.lineCount === 583)).toBe(true);
    for (const variant of variants) {
      const guide = Buffer.from(variant.dataBase64, 'base64').toString('utf8');
      expect(analyzeLegacyClaudeMd(guide).exactMatches).toEqual([
        expect.objectContaining({ variantId: variant.id }),
      ]);
    }
  });

  it('rejects terminal-EOL changes and removes repeated non-overlapping blocks only', () => {
    const guide = Buffer.from((corpus.variants as GoldenVariant[])[0].dataBase64, 'base64').toString('utf8');
    expect(analyzeLegacyClaudeMd(guide.slice(0, -1)).exactMatches).toEqual([]);
    expect(analyzeLegacyClaudeMd(guide.slice(0, -20)).exactMatches).toEqual([]);
    const content = `first\n${guide}USER-BETWEEN\r\n${guide}last\r\n`;
    const analysis = analyzeLegacyClaudeMd(content);
    expect(analysis.exactMatches).toHaveLength(2);
    expect(removeClaudeMdRanges(content, analysis.exactMatches)).toBe('first\nUSER-BETWEEN\r\nlast\r\n');
  });

  it('keeps marker-contained historical content and bounds heading-dense counters', () => {
    const guide = Buffer.from((corpus.variants as GoldenVariant[])[0].dataBase64, 'base64').toString('utf8');
    expect(analyzeLegacyClaudeMd(`<!-- OMC:START -->\n${guide}<!-- OMC:END -->\n`).exactMatches).toEqual([]);
    const heading = getLegacyGuideManifestForVerification()[0].openingLine;
    const dense = Array.from({ length: 10_000 }, () => heading).join('\n');
    const analysis = analyzeLegacyClaudeMd(dense);
    expect(analysis.counters.lineVisits).toBeLessThanOrEqual(30_000);
    expect(analysis.counters.candidateWindows).toBeLessThanOrEqual(290_000);
    expect(analysis.counters.bytesHashed).toBe(0);
    expect(analysis.counters.parserSteps).toBeLessThanOrEqual(60_000);
  });
});
