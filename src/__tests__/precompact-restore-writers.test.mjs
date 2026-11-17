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
});
