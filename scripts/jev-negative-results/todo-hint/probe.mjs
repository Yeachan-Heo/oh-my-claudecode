#!/usr/bin/env node
/* global process, console */
// Live A/B probe of the reminder question. Needs a Jev key (TYPESAFE_API_KEY) and costs real (small) API calls: it sends the requests that
// replay.mjs prints (2 scenarios x 2 wordings = 4 requests, about 1.2-2 KB of state each, roughly 0.5-1k input tokens per request) and prints
// the probability Jev gives to each answer. One try per cell, no repeats: the spread of repeated asks is not known.
//
//   node probe.mjs --dry-run     prints what would be sent; no API call, no key needed
//   TYPESAFE_API_KEY=... node probe.mjs
//
// The original probe (docs/jev/negative-results/todo-hint.md) sent the whole panel query of the patch (22-24 KB, five questions), not this
// reduced state, so the numbers will not match fixtures/recorded-answers.json.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordJevShadow } from '../../lib/jev-shadow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes('--dry-run');
if (!dry && !process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set; use --dry-run to see the requests without sending them.');
  process.exit(2);
}

const replay = spawnSync(process.execPath, [join(HERE, 'replay.mjs'), '--json'], { encoding: 'utf8' });
if (replay.status !== 0) { console.error(replay.stderr); process.exit(1); }
const { requests } = JSON.parse(replay.stdout);

process.env.OMC_JEV = 'todo-hint:active';
for (const r of requests) {
  if (dry) { console.log(`${r.scenario} / ${r.wording}: ${r.chars} chars (not sent)`); continue; }
  const result = recordJevShadow({ point: 'todo-hint', state: r.body.state, questions: r.body.questions, heuristic: 'zadne' });
  const answer = result?.mode === 'active' ? result.answers?.przypomnienie : null;
  console.log(`${r.scenario} / ${r.wording}: ${answer ? `${answer.choice} ${JSON.stringify(answer.probabilities ?? {})}` : `no answer (${result?.mode ?? 'none'})`}`);
}
