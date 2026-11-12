#!/usr/bin/env node
/* global console, process */
// Sums the archive and pasted-text counters of the Jev compaction log (compact.jsonl, or compaction.jsonl next to shadow.jsonl).
//
//   node summarize-compact-log.mjs <log file> [--json]
//   node summarize-compact-log.mjs --synthetic
//
// Reads only numeric counters of the compaction records (event "compact"); no text, no ids, no paths are printed. Field names are
// those of the code in this branch (`archive_*`, `pastes`); the local patch this was measured on wrote the pasted-text counters
// under `wklejki` and used other names for the skip reasons, so both spellings of the record key are read and the reasons are
// listed as they are.
//
// Tokens saved by moved pastes are estimated as (moved characters - trace characters) / 4, the module's own CHARS_PER_TOKEN; the
// real token count of the text was not measured.

import { readFileSync } from 'node:fs';

const CHARS_PER_TOKEN = 4;

function summarize(text) {
  const out = {
    records: 0, compactions: 0, sessions: new Set(), first_ts: undefined, last_ts: undefined,
    archive: { compactions: 0, compactions_that_wrote: 0, written: 0, reused: 0, rewritten: 0, bytes: 0, errors: 0, timed_out: 0, skipped_events: {} },
    pastes: { compactions: 0, compactions_that_moved: 0, blocks_asked: 0, yes: 0, no: 0, moved: 0, moved_chars: 0, trace_chars: 0, write_failed: 0 },
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    out.records++;
    if (r?.event !== 'compact') continue;
    out.compactions++;
    if (r.session_id) out.sessions.add(r.session_id);
    if (typeof r.ts === 'string') { out.first_ts = out.first_ts && out.first_ts < r.ts ? out.first_ts : r.ts; out.last_ts = out.last_ts && out.last_ts > r.ts ? out.last_ts : r.ts; }
    if (r.archive_mode === 'active' || r.archive_mode === 'shadow') {
      const a = out.archive;
      a.compactions++;
      if (r.archive_written > 0) a.compactions_that_wrote++;
      for (const k of ['written', 'reused', 'rewritten', 'bytes', 'errors', 'timed_out']) a[k] += Number(r[`archive_${k}`]) || 0;
      for (const [why, n] of Object.entries(r.archive_skipped ?? {})) a.skipped_events[why] = (a.skipped_events[why] ?? 0) + (Number(n) || 0);
    }
    const p = r.pastes ?? r.wklejki;
    if (p && typeof p === 'object') {
      const s = out.pastes;
      s.compactions++;
      if (p.moved > 0) s.compactions_that_moved++;
      s.blocks_asked += Number(p.blocks_asked ?? p.asked) || 0;
      for (const k of ['yes', 'no', 'moved', 'moved_chars', 'trace_chars', 'write_failed']) s[k] += Number(p[k]) || 0;
    }
  }
  out.pastes.net_chars_removed = out.pastes.moved_chars - out.pastes.trace_chars;
  out.pastes.net_tokens_estimate = Math.round(out.pastes.net_chars_removed / CHARS_PER_TOKEN);
  out.sessions = out.sessions.size;
  return out;
}

function synthetic() {
  const rows = [
    { event: 'compact', ts: '2026-01-01T00:00:00Z', session_id: 's1', archive_mode: 'active', archive_written: 10, archive_reused: 1, archive_bytes: 5000, archive_errors: 0, archive_timed_out: 0, archive_rewritten: 0, archive_skipped: { secret: 2, after_compaction: 1 }, pastes: { moved: 1, moved_chars: 5000, trace_chars: 900, yes: 1, no: 1, asked: 2 } },
    { event: 'compact', ts: '2026-01-01T01:00:00Z', session_id: 's1', archive_mode: 'active', archive_written: 0, archive_reused: 0, archive_bytes: 0, archive_skipped: { secret: 1 }, pastes: { moved: 0, moved_chars: 0, trace_chars: 0, yes: 0, no: 0, asked: 0 } },
    { event: 'compact', ts: '2026-01-02T00:00:00Z', session_id: 's2', wklejki: { moved: 2, moved_chars: 3000, trace_chars: 1000, yes: 2, no: 0, blocks_asked: 2 } },
    { event: 'own_threshold', ts: '2026-01-02T00:00:01Z', session_id: 's2' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n';
  const got = summarize(rows);
  const checks = [
    ['compactions', got.compactions, 3], ['sessions', got.sessions, 2],
    ['archive.compactions', got.archive.compactions, 2], ['archive.compactions_that_wrote', got.archive.compactions_that_wrote, 1],
    ['archive.written', got.archive.written, 10], ['archive.reused', got.archive.reused, 1], ['archive.bytes', got.archive.bytes, 5000],
    ['archive.skipped secret', got.archive.skipped_events.secret, 3], ['archive.skipped after_compaction', got.archive.skipped_events.after_compaction, 1],
    ['pastes.compactions', got.pastes.compactions, 3], ['pastes.compactions_that_moved', got.pastes.compactions_that_moved, 2],
    ['pastes.moved', got.pastes.moved, 3], ['pastes.net_chars_removed', got.pastes.net_chars_removed, 6100], ['pastes.net_tokens_estimate', got.pastes.net_tokens_estimate, 1525],
    ['pastes.blocks_asked', got.pastes.blocks_asked, 4],
  ];
  let bad = 0;
  for (const [name, value, want] of checks) {
    if (value !== want) bad++;
    console.log(`${value === want ? 'ok  ' : 'FAIL'} ${name}: ${value} (expected ${want})`);
  }
  if (bad) { console.error(`${bad} mismatch(es)`); process.exitCode = 1; } else console.log('synthetic check passed');
}

const args = process.argv.slice(2);
if (args.includes('--synthetic')) synthetic();
else {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: summarize-compact-log.mjs <log file> [--json] | --synthetic'); process.exitCode = 2; }
  else {
    const result = summarize(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(result, null, args.includes('--json') ? 2 : 1));
  }
}
