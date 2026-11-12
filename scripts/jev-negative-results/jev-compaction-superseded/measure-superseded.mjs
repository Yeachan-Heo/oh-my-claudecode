#!/usr/bin/env node
// Measures the "superseded calls" rule of the Jev compaction (OMC_JEV_COMPACT_TASKS, hooks/jev-compaction.mjs) on Claude Code
// transcripts, without any API call. The rule is deterministic: supersededCalls() decides which older tool result a newer call replaces.
//
// Usage: node measure-superseded.mjs [--module hooks/jev-compaction.mjs] [--window-chars 1400000] [--json out.json] [--quiet] <transcript.jsonl>...
//   A transcript in a subagents/ folder, or named agent-*.jsonl, counts as a subagent (no directory kept between Bash calls).
//
// For each simulated compaction point (every time the conversation grows by --window-chars, plus the end of the transcript) the script takes
// the window of rows before the point, runs the rule, and reports:
//   - how many results would be superseded (the module's own filter: the one-line trace must be shorter than the call; the last 6 rows stay),
//   - characters saved (call input + result - the trace), as chars/4 tokens and as a share of the window,
//   - for each pair: whether the old result equals the newer one, how many characters of the old result are lines the newer result does not
//     contain ("unique to old", information that is gone after the compaction), whether a write stood between the two calls, and whether
//     distinctive words of the unique part show up in the assistant's text and tool inputs in the next 40 rows after the point (a proxy for "still needed").
// The module is loaded from a temporary copy next to it with one extra export line; the module itself is not touched.
import { createReadStream, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
let modulePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'jev-compaction.mjs')
let windowChars = 1_400_000
let jsonOut = ''
let quiet = false
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--module') modulePath = args[++i]
  else if (args[i] === '--window-chars') windowChars = Number(args[++i])
  else if (args[i] === '--json') jsonOut = args[++i]
  else if (args[i] === '--quiet') quiet = true
  else files.push(args[i])
}
if (!files.length) { console.error('usage: measure-superseded.mjs [--module <jev-compaction.mjs>] [--window-chars N] [--json out] [--quiet] <transcript.jsonl>...'); process.exit(2) }
const probePath = join(dirname(resolve(modulePath)), `.probe-${process.pid}-${basename(modulePath)}`)
writeFileSync(probePath, `${readFileSync(modulePath, 'utf8')}\nexport const __probe = { supersededCalls, supersededLine, readOnlyCommand }\n`)
let probe
try { probe = (await import(pathToFileURL(probePath).href)).__probe } finally { unlinkSync(probePath) }
const { supersededCalls, supersededLine, readOnlyCommand } = probe
const KEEP_LAST = 6
const LOOKAHEAD = 40
const UNCHANGED_READ = /^\s*File unchanged since last read/i
const WIN_PATH = /(?:^|[\s"'=(])(?:[A-Za-z]:[\\/]|\\\\[^\s\\])/

const textOf = (c) => {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('\n')
  return ''
}
const nonText = (c) => Array.isArray(c) && c.some((b) => b && /^(?:image|document|file)$/.test(b.type))

async function load(file) {
  const rows = [] // { role, chars, uses: [{id, tool, input}], results: [{id, text, isError, textOnly}], said: string }
  const byMsg = new Map()
  const seenUse = new Set() // Claude Code writes one record per content block, and a block can reappear: count a tool_use id once
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"message"')) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if ((r.type !== 'user' && r.type !== 'assistant') || !r.message) continue
    const content = r.message.content
    if (r.type === 'assistant') {
      const mid = r.message.id || r.uuid
      let row = byMsg.get(mid)
      if (!row) { row = { role: 'assistant', chars: 0, uses: [], results: [], said: '' }; byMsg.set(mid, row); rows.push(row) }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text') { row.chars += (b.text || '').length; row.said += `${b.text || ''}\n` }
        else if (b.type === 'tool_use') { if (seenUse.has(b.id)) continue; seenUse.add(b.id); const s = JSON.stringify(b.input || {}); row.chars += s.length; row.said += `${s}\n`; row.uses.push({ id: b.id, tool: b.name, input: b.input || {} }) }
      }
    } else {
      const row = { role: 'user', chars: 0, uses: [], results: [], said: '' }
      if (typeof content === 'string') row.chars += content.length
      else for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result') { const t = textOf(b.content); row.chars += t.length; row.results.push({ id: b.tool_use_id, text: t, isError: Boolean(b.is_error), textOnly: !nonText(b.content) }) }
        else if (b.type === 'text') row.chars += (b.text || '').length
      }
      rows.push(row)
    }
  }
  return rows
}

const words = (s) => new Set((s.match(/[A-Za-z0-9_./\\-]{10,}/g) || []))
const lineSet = (t) => new Set(t.split('\n').map((x) => x.trim()).filter(Boolean))
const WRITERS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const keyOf = (c) => (c.tool === 'Read' || c.tool === 'Write' ? c.input.file_path : c.tool === 'Bash' || c.tool === 'PowerShell' ? c.input.command : JSON.stringify(c.input))

function window(rows, from, to, main) {
  const part = rows.slice(from, to)
  const results = new Map()
  for (const m of part) for (const r of m.results) if (!results.has(r.id)) results.set(r.id, r)
  const calls = []
  const seen = new Set()
  part.forEach((m, i) => {
    for (const u of m.uses) {
      if (seen.has(u.id)) continue
      seen.add(u.id)
      const r = results.get(u.id)
      calls.push({ id: u.id, tool: u.tool, input: u.input, text: r ? r.text : undefined, hasResult: r !== undefined, isError: Boolean(r && r.isError), textOnly: r ? r.textOnly : true, order: calls.length + 1, main, message: `m${i}`, row: i })
    }
  })
  return { part, calls }
}

const out = { files: [], total: {} }
const distinct = new Map() // one event = one (file, old call): windows of a long transcript overlap, so an event can be counted twice
const add = (o, k, v = 1) => { o[k] = (o[k] || 0) + v }

for (const file of files) {
  const rows = await load(file)
  const sub = /(^|\/)subagents\//.test(file) || /^agent-/.test(basename(file))
  const main = !sub
  const total = rows.reduce((s, r) => s + r.chars, 0)
  // compaction points: every time the cumulative size passes k * windowChars, and the end
  const points = []
  let cum = 0
  let next = windowChars
  rows.forEach((r, i) => { cum += r.chars; if (cum >= next) { points.push(i + 1); next += windowChars } })
  if (!points.length || points[points.length - 1] < rows.length) points.push(rows.length)
  const fileRes = { file: basename(file), rows: rows.length, chars: total, calls: 0, reads: 0, reads_same_range_repeat: 0, reads_stub_unchanged: 0, points: [] }
  for (const r of rows) for (const u of r.uses) { fileRes.calls++; if (u.tool === 'Read') fileRes.reads++ }
  // repeated Read of the same file and range, and how many of the repeats came back as the host's "unchanged" stub
  {
    const res = new Map()
    for (const m of rows) for (const x of m.results) if (!res.has(x.id)) res.set(x.id, x)
    const seenKey = new Set()
    for (const m of rows) for (const u of m.uses) {
      if (u.tool !== 'Read') continue
      const k = `${u.input.file_path}|${u.input.offset ?? ''}|${u.input.limit ?? ''}|${u.input.pages ?? ''}`
      const x = res.get(u.id)
      if (seenKey.has(k)) { fileRes.reads_same_range_repeat++; if (x && UNCHANGED_READ.test(x.text)) fileRes.reads_stub_unchanged++ }
      seenKey.add(k)
    }
  }
  for (const p of points) {
    // window: the last windowChars of conversation before p (a post-compaction context is about that size)
    let from = p
    let w = 0
    while (from > 0 && w + rows[from - 1].chars <= windowChars) { from--; w += rows[from].chars }
    const { part, calls } = window(rows, from, p, main)
    const ctxChars = part.reduce((s, r) => s + r.chars, 0)
    const tailRow = Math.max(0, part.length - KEEP_LAST)
    const win = calls.some((c) => ['file_path', 'notebook_path', 'path', 'command'].some((f) => typeof c.input[f] === 'string' && WIN_PATH.test(c.input[f])))
    const sup = supersededCalls(calls, () => true, win)
    const byId = new Map(calls.map((c) => [c.id, c]))
    const futureWords = new Set()
    for (const r of rows.slice(p, p + LOOKAHEAD)) for (const wd of words(r.said)) futureWords.add(wd)
    const pt = { rows: part.length, ctx_chars: ctxChars, pairs: 0, applied: 0, saved_chars: 0, by_kind: {}, identical: 0, differs: 0, differs_unique_chars: 0, between_write: 0, between_nonreading: 0, needed_proxy: 0, needed_proxy_chars: 0, empty_trace_skip: 0, tail_skip: 0 }
    for (const [oldId, newId] of sup) {
      pt.pairs++
      const o = byId.get(oldId)
      const n = byId.get(newId)
      if (o.row >= tailRow) { pt.tail_skip++; continue }
      const inputChars = JSON.stringify(o.input).length
      const resultChars = (o.text || '').length
      const c = { use: { tool: o.tool, input: o.input }, summary: String(keyOf(o) ?? ''), inputChars, resultChars, res: { isError: o.isError } }
      const saved = inputChars + resultChars - supersededLine(c, n.tool).length
      if (saved <= 0) { pt.empty_trace_skip++; continue }
      pt.applied++
      pt.saved_chars += saved
      if (!distinct.has(`${basename(file)}|${oldId}`)) distinct.set(`${basename(file)}|${oldId}`, { saved, tool: o.tool, newer: n.tool })
      const kind = o.tool === 'Read' ? (n.tool === 'Write' ? 'Read<-Write' : 'Read<-Read') : `${o.tool}<-same`
      add(pt.by_kind, `${kind}:n`)
      add(pt.by_kind, `${kind}:chars`, saved)
      // loss analysis
      const oldText = o.text || ''
      const newText = n.tool === 'Write' ? String(n.input.content || '') : n.text || ''
      let uniqueChars = 0
      let uniqueWords = new Set()
      if (oldText === newText) pt.identical++
      else {
        pt.differs++
        const ns = lineSet(newText)
        const uniq = oldText.split('\n').filter((x) => x.trim() && !ns.has(x.trim()))
        uniqueChars = uniq.reduce((s, x) => s + x.length + 1, 0)
        pt.differs_unique_chars += uniqueChars
        uniqueWords = words(uniq.join('\n'))
        for (const wd of words(newText)) uniqueWords.delete(wd)
      }
      // what stood between the two calls
      const k = o.tool === 'Read' ? o.input.file_path : null
      let wroteBetween = false
      let nonReadingBetween = false
      for (const x of calls) {
        if (x.order <= o.order || x.order >= n.order) continue
        if (WRITERS.has(x.tool) && (!k || x.input.file_path === k || x.input.notebook_path === k)) wroteBetween = true
        if (!k && (x.tool === 'Bash' || x.tool === 'PowerShell') && !readOnlyCommand(x.input.command)) nonReadingBetween = true
        if (!k && WRITERS.has(x.tool)) nonReadingBetween = true
      }
      if (wroteBetween) pt.between_write++
      if (nonReadingBetween) pt.between_nonreading++
      if (uniqueChars > 0) {
        let hit = false
        for (const wd of uniqueWords) if (futureWords.has(wd)) { hit = true; break }
        if (hit) { pt.needed_proxy++; pt.needed_proxy_chars += uniqueChars; distinct.get(`${basename(file)}|${oldId}`).needed = true }
      }
    }
    pt.saved_tokens = Math.round(pt.saved_chars / 4)
    pt.ctx_tokens = Math.round(ctxChars / 4)
    pt.share = ctxChars ? pt.saved_chars / ctxChars : 0
    fileRes.points.push(pt)
  }
  out.files.push(fileRes)
  const f = fileRes
  const sum = (k) => f.points.reduce((s, x) => s + x[k], 0)
  if (!quiet) console.log(`${f.file}: rows ${f.rows}, ${(f.chars / 1e6).toFixed(2)}M chars, calls ${f.calls}, Read ${f.reads} (repeat same range ${f.reads_same_range_repeat}, of which host stub "unchanged" ${f.reads_stub_unchanged}); points ${f.points.length}: pairs ${sum('pairs')}, applied ${sum('applied')}, saved ${sum('saved_chars')} chars of ${sum('ctx_chars')} (${(100 * sum('saved_chars') / Math.max(1, sum('ctx_chars'))).toFixed(2)} %), identical ${sum('identical')}, differs ${sum('differs')}, unique-to-old ${sum('differs_unique_chars')} chars, needed-proxy ${sum('needed_proxy')}`)
}
const all = out.files.flatMap((f) => f.points)
const S = (k) => all.reduce((s, x) => s + x[k], 0)
out.total = { files: out.files.length, points: all.length, ctx_chars: S('ctx_chars'), saved_chars: S('saved_chars'), applied: S('applied'), pairs: S('pairs'), identical: S('identical'), differs: S('differs'), differs_unique_chars: S('differs_unique_chars'), between_write: S('between_write'), between_nonreading: S('between_nonreading'), needed_proxy: S('needed_proxy'), needed_proxy_chars: S('needed_proxy_chars'), share: S('saved_chars') / Math.max(1, S('ctx_chars')), share_each_point_max: Math.max(...all.map((x) => x.share)), share_each_point_median: all.map((x) => x.share).sort((a, b) => a - b)[Math.floor(all.length / 2)] }
console.log('TOTAL', JSON.stringify(out.total))
const kinds = {}
for (const x of all) for (const [k, v] of Object.entries(x.by_kind)) add(kinds, k, v)
console.log('BY KIND', JSON.stringify(kinds))
out.kinds = kinds
out.distinct = { events: distinct.size, saved_chars: [...distinct.values()].reduce((a, v) => a + v.saved, 0), needed_proxy: [...distinct.values()].filter((v) => v.needed).length, by_kind: [...distinct.values()].reduce((a, v) => { const k = `${v.tool}<-${v.newer}`; a[k] = (a[k] || 0) + 1; return a }, {}) }
console.log('DISTINCT', JSON.stringify(out.distinct))
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1))
