/**
 * The restore text of a PreCompact checkpoint (scripts/lib/precompact-restore.mjs) with and without the writers of the text
 * cleaning module (OMC_CONTEXT_TEXT_SANITIZE=1 in SessionStart): with them the mode names and the paths the text tells the
 * model to consult are written exactly, and the text is fitted to its limit by whole lines.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { preparePreCompactCheckpointRestore } from '../../scripts/lib/precompact-restore.mjs';
import * as writers from '../../scripts/lib/context-text-sanitize.mjs';

const FE0F = String.fromCodePoint(0xFE0F);
const SESSION = 'session-restore-writers';

// Writes one checkpoint of SESSION under <root>/<projectName>/.omc and returns the .omc directory and the checkpoint path.
function withCheckpoint(projectName, fields, fn) {
  const root = mkdtempSync(join(tmpdir(), 'precompact-restore-writers-'));
  try {
    const omcRoot = join(root, projectName, '.omc');
    const dir = join(omcRoot, 'state', 'checkpoints');
    mkdirSync(dir, { recursive: true });
    const created = new Date().toISOString();
    const file = join(dir, `checkpoint-${created.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({
      created_at: created, session_id: SESSION, trigger: 'auto', active_modes: {}, todo_summary: { pending: 1, in_progress: 0, completed: 0 },
      wisdom_exported: false, ...fields,
    }));
    return fn(omcRoot, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const lineOf = (text, prefix) => text.split('\n').find((line) => line.startsWith(prefix));
const decode = (written) => (written.startsWith('"') ? JSON.parse(written) : written);

describe('PreCompact restore text with the cleaning writers', () => {
  const fields = {
    active_modes: { ralph: { iteration: 2 }, [`auto${FE0F}pilot`]: { phase: 'plan' } },
    plan_refs: {
      prd: { title: 'Ship it', status: 'active', stories_completed: 1, stories_total: 3, path: `/repo/.omc/prd${FE0F}/prd.json` },
      boulder: { plan_name: 'epic', progress: { total: 3, completed: 2 }, active_plan: '"quoted"/epic.md' },
    },
  };

  it('writes the mode names, the PRD file, the plan file and the raw checkpoint path exactly', () => {
    withCheckpoint(`proj${FE0F}ect`, fields, (omcRoot, file) => {
      const text = preparePreCompactCheckpointRestore(omcRoot, SESSION, writers).text;
      expect(decode(lineOf(text, 'PRD file: ').slice('PRD file: '.length))).toBe(`/repo/.omc/prd${FE0F}/prd.json`);
      expect(decode(lineOf(text, 'Plan file: ').slice('Plan file: '.length))).toBe('"quoted"/epic.md');
      expect(decode(lineOf(text, 'Raw checkpoint: ').slice('Raw checkpoint: '.length))).toBe(file);
      expect(file.includes(FE0F)).toBe(true);
      const modeLine = lineOf(text, '- "auto');
      expect(decode(modeLine.slice(2, modeLine.indexOf(' (')))).toBe(`auto${FE0F}pilot`);
      expect(text.includes(FE0F)).toBe(false);
      expect(writers.cleanTextBlock(text)).toBe(text);
      expect(text.length).toBeLessThanOrEqual(1200);
    });
  });

  it('writes the text as it always was without the writers', () => {
    withCheckpoint(`proj${FE0F}ect`, fields, (omcRoot, file) => {
      const text = preparePreCompactCheckpointRestore(omcRoot, SESSION).text;
      expect(preparePreCompactCheckpointRestore(omcRoot, SESSION, undefined).text).toBe(text);
      expect(text).toContain(`PRD file: /repo/.omc/prd${FE0F}/prd.json\n`);
      expect(text).toContain('Plan file: "quoted"/epic.md\n');
      expect(text).toContain(`Raw checkpoint: ${file}`);
      expect(text).toContain(`- auto${FE0F}pilot (phase plan)`);
    });
  });

  it('cuts a long text by whole lines, never inside a path, and replaces a path over 250 characters by a notice', () => {
    const longPath = `/repo/${FE0F.repeat(60)}/a/${FE0F.repeat(60)}/b/${FE0F.repeat(60)}/c/${FE0F.repeat(60)}/d.md`;
    const long = {
      plan_refs: {
        prd: { title: 'T'.repeat(900), status: 'active', path: '/repo/prd.json' },
        boulder: { plan_name: 'epic', progress: { total: 3, completed: 2 }, active_plan: longPath },
      },
    };
    withCheckpoint('plain', long, (omcRoot) => {
      const text = preparePreCompactCheckpointRestore(omcRoot, SESSION, writers).text;
      const written = writers.escapeIdentifier(longPath);
      expect(written.length).toBeGreaterThan(250);
      expect(text.length).toBeLessThanOrEqual(1200);
      expect(text.endsWith('\n…')).toBe(true);
      // Whole lines only: no line is a part of a line of the full text.
      const full = preparePreCompactCheckpointRestore(omcRoot, SESSION, { ...writers, fitLines: (value) => String(value) }).text.split('\n');
      for (const line of text.split('\n').slice(0, -1)) expect(full).toContain(line);
      expect(full).toContain(`Plan file: [identifier of ${written.length} characters not shown]`);
    });
  });

  // An identifier whose written form (escaped, quoted) has exactly `length` characters: `count` removed characters of `junk`
  // (6 written characters each, 12 for an astral one) and plain characters for the rest.
  const writtenLength = (length, junk, count) => `${'x'.repeat(length - 2 - count * (junk.length === 2 ? 12 : 6))}${junk.repeat(count)}`;
  const junkCases = [
    ['variation selector', FE0F, 1],
    ['variation selector', FE0F, 15],
    ['astral tag character', String.fromCodePoint(0xE0041), 1],
    ['astral tag character', String.fromCodePoint(0xE0041), 8],
  ];

  for (const [label, junk, count] of junkCases) {
    it(`path limit of 250 and mode name limit of 80 written characters, one on each side: ${count} x ${label}`, () => {
      for (const [limit, build] of [[250, (name) => ({ plan_refs: { boulder: { plan_name: 'epic', progress: { total: 3, completed: 2 }, active_plan: name } } })],
        [80, (name) => ({ active_modes: { [name]: { phase: 'plan' } } })]]) {
        for (const length of [limit - 1, limit, limit + 1]) {
          const name = writtenLength(length, junk, Math.min(count, Math.floor((length - 2) / (junk.length === 2 ? 12 : 6))));
          expect(writers.escapeIdentifier(name).length).toBe(length);
          withCheckpoint('plain', build(name), (omcRoot) => {
            const text = preparePreCompactCheckpointRestore(omcRoot, SESSION, writers).text;
            const line = limit === 250 ? lineOf(text, 'Plan file: ').slice('Plan file: '.length) : lineOf(text, '- ').replace(/ \(phase plan\)$/, '').slice(2);
            if (length <= limit) expect(decode(line), `${limit}/${length}`).toBe(name);
            else expect(line, `${limit}/${length}`).toBe(`[identifier of ${limit + 1} characters not shown]`);
          });
        }
      }
    });
  }

  it('text limit of 1200 characters, one on each side: the whole text or whole lines', () => {
    const unfitted = { ...writers, fitLines: (value) => String(value) };
    const checkpoint = (title) => ({
      plan_refs: {
        prd: { title, status: 'active', path: `/repo/prd${FE0F}/prd.json` },
        boulder: { plan_name: 'epic', progress: { total: 3, completed: 2 }, active_plan: '/repo/plan.md' },
      },
    });
    const lengthWith = (title) => withCheckpoint('plain', checkpoint(title), (omcRoot) => preparePreCompactCheckpointRestore(omcRoot, SESSION, unfitted).text.length);
    const base = lengthWith('T');
    for (const length of [1199, 1200, 1201]) {
      const title = 'T'.repeat(length - base + 1);
      expect(lengthWith(title)).toBe(length);
      withCheckpoint('plain', checkpoint(title), (omcRoot) => {
        const full = preparePreCompactCheckpointRestore(omcRoot, SESSION, unfitted).text;
        const text = preparePreCompactCheckpointRestore(omcRoot, SESSION, writers).text;
        if (length <= 1200) {
          expect(text, `${length}`).toBe(full);
        } else {
          expect(text.length, `${length}`).toBeLessThanOrEqual(1200);
          expect(text.endsWith('\n…'), `${length}`).toBe(true);
          const fullLines = full.split('\n');
          for (const line of text.split('\n').slice(0, -1)) expect(fullLines, `${length}`).toContain(line);
        }
      });
    }
  });
});
