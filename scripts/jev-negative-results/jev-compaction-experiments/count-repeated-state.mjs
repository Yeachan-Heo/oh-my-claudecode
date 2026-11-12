#!/usr/bin/env node
// Counter 3: how much of the traffic to the decision service is the same state sent again? Read-only, no network, no API key.
//
//   node count-repeated-state.mjs --synthetic [--json]
//   node count-repeated-state.mjs --bodies <dir> [--json]        request bodies, one JSON file each: { "state": {...}, "questions": [...] }
//   node count-repeated-state.mjs --request-log <file> [--json]  one JSON per line: { "bytes": N, "state_fields": { "<name>": bytes } }
//
// A state field is "repeated" when the same field is present in several requests. With --bodies the value must also be byte-identical
// (canonical JSON); with --request-log only the sizes are known, so the fields named in --fixed (default: the fields present in every
// request) are taken as repeated. Two shares are printed:
//   all occurrences     every occurrence of a repeated field counts (what the traffic carried)
//   avoidable           the same, minus the first occurrence of each distinct value (what sending it once would have saved)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

// requests: [{ bytes, fields: [{ name, bytes, id }] }]; id identifies the value (equal id = identical value)
function analyse(requests, fixedNames) {
  const total = requests.reduce((s, r) => s + r.bytes, 0);
  const byId = new Map();
  for (const r of requests) for (const f of r.fields) byId.set(`${f.name}\n${f.id}`, (byId.get(`${f.name}\n${f.id}`) || 0) + 1);
  let repeatedAll = 0;
  let repeatedAvoidable = 0;
  const seenFirst = new Set();
  const perField = {};
  for (const r of requests) {
    for (const f of r.fields) {
      const k = `${f.name}\n${f.id}`;
      const repeated = fixedNames ? fixedNames.has(f.name) : byId.get(k) > 1;
      if (!repeated) continue;
      repeatedAll += f.bytes;
      perField[f.name] = (perField[f.name] || 0) + f.bytes;
      if (seenFirst.has(k)) repeatedAvoidable += f.bytes; else seenFirst.add(k);
    }
  }
  return {
    requests: requests.length, totalBytes: total, repeatedBytesAllOccurrences: repeatedAll, shareAllOccurrences: total ? repeatedAll / total : 0,
    repeatedBytesAvoidable: repeatedAvoidable, shareAvoidable: total ? repeatedAvoidable / total : 0,
    repeatedBytesByField: perField,
  };
}

function fromBodies(dir) {
  const requests = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const fields = Object.entries(body.state || {}).map(([k, v]) => ({ name: k, bytes: bytesOf(JSON.stringify(v)), id: canon(v) }));
    requests.push({ bytes: bytesOf(JSON.stringify(body)), fields });
  }
  return requests;
}

function fromLog(file) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const requests = rows.map((r) => ({ bytes: r.bytes, fields: Object.entries(r.state_fields || {}).map(([name, bytes]) => ({ name, bytes, id: 'size-only' })) }));
  const fixed = val('--fixed') ? new Set(val('--fixed').split(',')) : new Set(Object.keys(rows[0]?.state_fields || {}).filter((k) => rows.every((r) => k in (r.state_fields || {}))));
  return { requests, fixed };
}

// Synthetic: a state of two big fixed fields (sizes of the measured case: a task list of about 32 KB and a conversation axis of about
// 12 KB) plus a small budget field, and per request a different slice of content that fills the body up to the 56,000-byte cap
// minus a margin. 213 requests. Deterministic. This checks the arithmetic of the counter; it is not a measurement.
function synthetic() {
  let seed = 5610059;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const filler = (n, tag) => { let s = ''; while (s.length < n) s += `${tag}${Math.floor(rnd() * 1e9).toString(36)} `; return s.slice(0, n); };
  const todo = filler(32000, 't');
  const axis = filler(12300, 'a');
  const dir = [];
  for (let i = 0; i < 213; i++) {
    const content = filler(9500 + Math.floor(rnd() * 2500), `b${i}-`);
    dir.push({ state: { tasks: todo, axis, budget: { tokens: 120000 }, blocks: content }, questions: [`question ${i}`] });
  }
  const requests = dir.map((body) => ({
    bytes: bytesOf(JSON.stringify(body)),
    fields: Object.entries(body.state).map(([k, v]) => ({ name: k, bytes: bytesOf(JSON.stringify(v)), id: canon(v) })),
  }));
  return requests;
}

let result;
if (flag('--synthetic')) result = { source: 'synthetic', ...analyse(synthetic()) };
else if (val('--bodies')) result = { source: 'bodies', ...analyse(fromBodies(val('--bodies'))) };
else if (val('--request-log')) { const { requests, fixed } = fromLog(val('--request-log')); result = { source: 'request-log', fixedFields: [...fixed], ...analyse(requests, fixed) }; }
else { console.error('usage: --synthetic | --bodies <dir> | --request-log <file> [--fixed a,b]   [--json]'); process.exit(2); }

if (flag('--json')) console.log(JSON.stringify(result, null, 2));
else {
  const pct = (x) => (100 * x).toFixed(1) + ' %';
  console.log(`source: ${result.source}; requests: ${result.requests}; total body bytes: ${result.totalBytes}`);
  console.log(`repeated state, all occurrences: ${result.repeatedBytesAllOccurrences} bytes = ${pct(result.shareAllOccurrences)}`);
  console.log(`repeated state, avoidable (first occurrence of each value not counted): ${result.repeatedBytesAvoidable} bytes = ${pct(result.shareAvoidable)}`);
  for (const [k, v] of Object.entries(result.repeatedBytesByField)) console.log(`  ${k}: ${v} bytes`);
}
