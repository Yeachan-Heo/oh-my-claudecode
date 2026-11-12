#!/usr/bin/env node
// Writes small synthetic Claude Code transcripts (JSONL), one scenario each, for measure-superseded.mjs.
// No real conversation is used: files, commands and results are invented. Each scenario ends with eight unrelated calls, so the pair under
// test lies outside the last six rows that the compaction keeps (a pair inside them is never superseded).
// Usage: node make-synthetic.mjs <output-dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) { console.error('usage: make-synthetic.mjs <output-dir>'); process.exit(2) }
mkdirSync(out, { recursive: true })

const body = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${i + 1}\t${tag} ${i + 1}: some text of the file`).join('\n')
const read = (file, text, input = {}) => ({ tool: 'Read', input: { file_path: file, ...input }, text })
const edit = (file, from, to) => ({ tool: 'Edit', input: { file_path: file, old_string: from, new_string: to }, text: `The file ${file} has been updated.` })
const write = (file, content) => ({ tool: 'Write', input: { file_path: file, content }, text: `The file ${file} has been updated successfully.` })
const bash = (command, text) => ({ tool: 'Bash', input: { command }, text })
const grep = (pattern, path, text) => ({ tool: 'Grep', input: { pattern, path }, text })

const SCENARIOS = {
  '01-read-same-lines-unchanged': [read('/w/a.txt', body(40)), read('/w/a.txt', body(40))],
  '02-read-same-lines-after-edit': [read('/w/a.txt', body(40)), edit('/w/a.txt', 'line 7:', 'line seven (edited):'), read('/w/a.txt', body(40).replace('line 7:', 'line seven (edited):'))],
  '03-read-other-lines': [read('/w/a.txt', body(50), { offset: 1, limit: 50 }), read('/w/a.txt', body(100), { offset: 1, limit: 100 })],
  '04-read-then-write-whole-file': [read('/w/notes.md', `${body(30, 'decision A')}\nOption B was rejected because the vendor API has no batch mode.`), write('/w/notes.md', body(12, 'decision A'))],
  '05-read-then-edit': [read('/w/a.txt', body(40)), edit('/w/a.txt', 'line 7:', 'row 7:')],
  '06-read-then-host-stub': [read('/w/a.txt', body(40)), read('/w/a.txt', 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current.')],
  '07-readonly-command-repeated': [bash('git status', `On branch main\nnothing to commit\n${body(10, 'untracked')}`), bash('git status', `On branch main\nChanges not staged for commit:\n  modified: a.txt\n  modified: b.txt\n${body(14, 'untracked')}`)],
  '08-readonly-command-shorter-result': [bash('git status', `On branch main\nChanges not staged for commit:\n  modified: a.txt\n  modified: b.txt\n${body(14, 'untracked')}`), bash('git status', `On branch main\nnothing to commit\n${body(10, 'untracked')}`)],
  '09-command-that-writes': [bash('npm test', body(60, 'test')), bash('npm test', body(60, 'test'))],
  '10-directory-changes-in-between': [bash('git log --oneline', body(30, 'commit')), bash('cd /w/sub && ls', 'x'), bash('git log --oneline', body(30, 'commit'))],
  '11-grep-repeated': [grep('needle', '/w/src', body(25, 'match')), grep('needle', '/w/src', body(25, 'match'))],
}

const FILLER = 8
let id = 0
const rowsOf = (steps) => {
  const rows = []
  const push = (type, message) => rows.push(JSON.stringify({ type, uuid: `u${rows.length}`, message }))
  push('user', { role: 'user', content: 'Please go through the project notes and tidy them up.' })
  const all = [...steps, ...Array.from({ length: FILLER }, (_, i) => bash(`ls /w/filler-${i}`, `file-${i}.txt`))]
  for (const s of all) {
    const toolId = `toolu_${++id}`
    push('assistant', { id: `msg_${id}`, role: 'assistant', content: [{ type: 'text', text: `Step ${id}.` }, { type: 'tool_use', id: toolId, name: s.tool, input: s.input }] })
    push('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: s.text }] })
  }
  return rows
}

for (const [name, steps] of Object.entries(SCENARIOS)) {
  const rows = rowsOf(steps)
  writeFileSync(join(out, `${name}.jsonl`), `${rows.join('\n')}\n`)
}
console.log(`wrote ${Object.keys(SCENARIOS).length} synthetic transcripts to ${out}`)
