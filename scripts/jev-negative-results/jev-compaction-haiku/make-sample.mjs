#!/usr/bin/env node
// Builds the synthetic sample used by replay.mjs: a long coding-agent conversation with no real content.
// Every name, number and path in it is invented. Output: sample/session.json (rows in the shape the hooks host gives a
// module: { role, text, toolUses, toolResults }) and, with --recorded, a skeleton of sample/recorded.json.
//
//   node make-sample.mjs            # writes sample/session.json
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EPISODES = 8

export function buildSession(n = EPISODES) {
  const rows = [{ role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.\nEarlier summary written by the host: the module "parser" was refactored, 412 tests pass.', toolUses: [], toolResults: [] }]
  for (let k = 1; k <= n; k++) {
    rows.push({ role: 'user', text: `Task ${k}: please fix the flaky test in package-${k} and report the result.`, toolUses: [], toolResults: [] })
    rows.push({ role: 'assistant', text: `Starting task ${k}. I will run the suite for package-${k} first.`, toolUses: [{ tool_use_id: `t${k}a`, tool: 'Bash', input: { command: `npm test --prefix packages/package-${k}` } }], toolResults: [] })
    rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}a`, text: `> package-${k}@1.0.${k} test\n${'  PASS  src/case.test.js (0.4 s)\n'.repeat(60)}Tests: ${100 + k} passed, 1 failed\n` }] })
    rows.push({ role: 'assistant', text: `One test fails in packages/package-${k}/src/case.test.js. I will read the file.`, toolUses: [{ tool_use_id: `t${k}b`, tool: 'Read', input: { file_path: `packages/package-${k}/src/case.test.js` } }], toolResults: [] })
    rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}b`, text: `// case.test.js\n${'it("handles input", () => { expect(run(input)).toBe(output) })\n'.repeat(80)}` }] })
    rows.push({ role: 'assistant', text: `Fixed in commit ab${k}c${k}de${k}f. All ${101 + k} tests of package-${k} pass now; the change touches packages/package-${k}/src/case.test.js only.`, toolUses: [], toolResults: [] })
    rows.push({ role: 'user', text: `Another Claude session sent a message:\n<teammate-message teammate_id="reviewer-${k}" summary="review">Reviewed commit ab${k}c${k}de${k}f: ${3 + k} comments, none blocking. Open item: add a regression test for case ${k}.</teammate-message>`, toolUses: [], toolResults: [] })
  }
  rows.push({ role: 'user', text: 'Last task: summarise what is still open.', toolUses: [], toolResults: [] })
  rows.push({ role: 'assistant', text: 'Working on the final summary.', toolUses: [], toolResults: [] })
  return rows
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(HERE, 'sample'), { recursive: true })
  writeFileSync(join(HERE, 'sample', 'session.json'), `${JSON.stringify(buildSession(), null, 1)}\n`)
  console.log(`wrote ${join('sample', 'session.json')} (${buildSession().length} rows, ${EPISODES} closed episodes plus the open one)`)
}
