#!/usr/bin/env node
// Offline replay of step B ("Haiku summarises old episodes, Jev decides what replaces them") on a synthetic conversation.
// No network, no API key, no Claude Code host: `$` is an in-memory fake, Haiku answers and Jev answers come from
// sample/recorded.json. It loads jev-krok-b.mjs unchanged, behind a small prelude that stands in for the names the block takes
// from the compaction module it was written for (see the "uses:" lines at the top of jev-krok-b.mjs).
//
//   node replay.mjs                        # replay, print the table
//   node replay.mjs --print-questions      # also print the first question set sent to Jev, verbatim
//   node replay.mjs --out <dir>            # also write requests.json (state + questions) and result.json there
//   node replay.mjs --jev live             # ask the real Jev endpoint instead of recorded answers (needs TYPESAFE_API_KEY)
//
// `--jev live` is NOT exercised in this branch. It posts { model, state, questions } to OMC_JEV_ENDPOINT
// (default https://api.typesafe.ai/v1/systemone) as the measurement harness of the original experiment did, and costs real
// Jev tokens (see README.md). Haiku is always replayed: `$.model.complete` exists only inside the hooks host.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }

const SESSION = 'replay-session'
const LOG = '/replay/log'
const jevMode = opt('--jev', 'replay')
if (jevMode !== 'replay' && jevMode !== 'live') { console.error(`--jev must be replay or live, got ${jevMode}`); process.exit(2) }
const live = jevMode === 'live'
if (live && !process.env.TYPESAFE_API_KEY) { console.error('--jev live needs TYPESAFE_API_KEY in the environment'); process.exit(2) }

// ---- stand-ins for what the compaction module provides ------------------------------------------------------------------------------------------

const PRELUDE = `
const OWNER_NOT = ['This session is being continued', 'Another Claude session sent a message', '<task-notification>', '<teammate-message']
const AGENT_LEAD = 'lead'
const AGENT_BLOCK = /<teammate-message teammate_id="([^"]*)"([^>]*)>([\\s\\S]*?)<\\/teammate-message>/g
const isAgentRow = () => false
const agentSenders = () => []
const isOwnerWords = (m) => m?.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trim() !== '' && !OWNER_NOT.some((p) => m.text.trimStart().startsWith(p))
const RESIDUAL_SECRET = /(?!)/
const withDeadline = async (_$, promise, ms) => { let t; const timer = new Promise((r) => { t = setTimeout(() => r({ timeout: true }), ms) }); try { return await Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), timer]) } finally { clearTimeout(t) } }
const askJev = async () => { throw new Error('not used: replay supplies deps.ask') }
const readBreaker = async () => false
const reserveRequests = async () => ({ granted: 1 })
const classifyFailure = () => ({ kind: 'error' })
const openBreaker = async () => {}
const ownerTask = () => ({ zadanie: [] })
const maskSecretProse = (s) => s
const cleanForJev = (s) => String(s).replace(/sk-[A-Za-z0-9_-]{16,}/g, '***')
const LINKED_PROSE = /(?!)/g
const blockWords = () => []
const LOW_PRIORITY_FRACTION = 0.5
const readConfig = async () => ({})
const CONFIG_TTL_MS = 1000
let compacting = 0
let hostCannot = false
let cachedConfig
let cachedAt = 0
const JEV_WINDOW_CHARS = 56000
const windowCharsOf = () => JEV_WINDOW_CHARS
const MAX_PARALLEL = 3
const chooseByRank = (cands, left) => { const out = []; let rest = left; for (const c of [...cands].sort((a, b) => a.ocena - b.ocena)) { if (rest <= 0) break; out.push(c); rest -= c.zysk } return out }
const ARCHIVE_BUDGET_MS = 1000
const RATE_SIG = 0.4
const RATE_TEXT = 0.5
const messageChars = (m) => String(m.text ?? '').length + JSON.stringify(m.toolUses ?? []).length + (m.toolResults ?? []).reduce((s, r) => s + String(r.text ?? '').length, 0)
const nonTextRows = () => new Set()
const safeSegment = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_')
const HOST_MS = 2000
const groupsOf = (messages) => messages.map((_, i) => [i])
const openLoopStart = (messages) => messages.length
const apiShapeOk = () => false
`

async function loadBlock() {
  const src = readFileSync(join(HERE, 'jev-krok-b.mjs'), 'utf8')
  const dir = join(tmpdir(), `jev-krok-b-replay-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.mjs')
  writeFileSync(file, `${PRELUDE}\n${src}\n`)
  const mod = await import(pathToFileURL(file).href)
  return mod._testKrokB
}

// ---- fake host -------------------------------------------------------------------------------------------------------------------------------

function fakeHost(recorded, messages) {
  const files = new Map()
  const haikuCalls = []
  const $ = {
    fs: {
      read: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
      write: async (p, t) => { files.set(p, t) },
      exists: async (p) => files.has(p),
      list: async (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => ({ name: p.slice(d.length + 1), kind: 'file', size: files.get(p).length })),
    },
    model: {
      complete: async (req) => {
        haikuCalls.push(req)
        const n = /<odcinek numer="(\d+)">/.exec(req.prompt)?.[1]
        const text = recorded.haiku[n] ?? `Summary of episode ${n}.`
        return { isAnswered: true, text, usage: { input_tokens: Math.round(req.prompt.length / 3.5), output_tokens: Math.round(text.length / 3.5) } }
      },
    },
    clock: { after: (ms, cb) => { const t = setTimeout(cb, ms); return { cancel: () => clearTimeout(t) } }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    session: { id: async () => SESSION, messages: async () => messages },
  }
  return { $, files, haikuCalls }
}

// Recorded Jev: for each question key (o1, o1_sprzeczne, ...) the answer stored for that episode number in sample/recorded.json.
function recordedAsk(recorded, log) {
  return async (state, questions) => {
    log.push({ state, questions })
    const answers = {}
    for (const [q, def] of Object.entries(questions)) {
      const base = q.replace(/_sprzeczne$/, '')
      const n = state.odcinki?.[base]?.numer
      const rec = recorded.jev[n]
      if (!rec) continue
      if (def.type === 'noul') answers[q] = { noul: rec.sprzeczne }
      else answers[q] = { choice: rec.choice, probabilities: rec.probabilities }
    }
    return answers
  }
}

function liveAsk(log) {
  return async (state, questions) => {
    log.push({ state, questions })
    const r = await fetch(process.env.OMC_JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()).answers
  }
}

// ---- run -------------------------------------------------------------------------------------------------------------------------------------

const K = await loadBlock()
const messages = JSON.parse(readFileSync(join(HERE, 'sample', 'session.json'), 'utf8'))
const recorded = JSON.parse(readFileSync(join(HERE, 'sample', 'recorded.json'), 'utf8'))
const { $, files, haikuCalls } = fakeHost(recorded, messages)
const log = []
const isOwner = (m) => m?.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trim() !== '' && !/^(This session is being continued|Another Claude session sent a message)/.test(m.text.trimStart())
const deps = {
  mask: K.maskText, isOwnerWords: isOwner, ownerTask: () => ['(synthetic task)'],
  ask: live ? liveAsk(log) : recordedAsk(recorded, log), jedenPrzebieg: true, partChars: 6000,
}
const ctx = (extra = {}) => ({ cfg: { hybrid: 'active', logDir: LOG, sessionId: SESSION }, messages, deps, stats: {}, includeLast: false, keepFrom: messages.length, ...extra })

K.reset()
const prep = ctx()
await K.prepare($, prep) // background pass: Haiku writes the summaries, Jev answers one question per part
const planCtx = ctx()
const plan = await K.plan($, planCtx)
const applied = K.apply(messages, plan, true)

const chars = (rows) => rows.reduce((s, m) => s + (m.trimDrop === true ? 0 : String(m.text ?? '').length + JSON.stringify(m.toolUses ?? []).length + (m.toolResults ?? []).reduce((t, r) => t + String(r.text ?? '').length, 0)), 0)
const before = chars(messages)
const kept = applied.messages.filter((m) => m.trimDrop !== true)
const extra = [...applied.extraAfter.values()].flat()
const after = chars(kept) + chars(extra) + (plan.header ? String(plan.header.text).length : 0)

console.log(`rows ${messages.length} -> ${kept.length + extra.length + (plan.header ? 1 : 0)}   chars ${before} -> ${after}   (about ${Math.round(before * 0.5)} -> ${Math.round(after * 0.5)} tokens at 0.5 token per char)`)
console.log(`Haiku calls ${haikuCalls.length}   Jev requests ${log.length}   files written ${files.size}`)
console.log('episode  action        reason                kto   tokens before -> after')
for (const e of plan.episodes) console.log(`${String(e.n).padStart(7)}  ${String(e.action).padEnd(12)}  ${String(e.reason ?? '').padEnd(20)}  ${String(e.kto).padEnd(4)}  ${e.tokens_before} -> ${e.tokens_after}`)
const summaries = plan.episodes.filter((e) => e.action === 'streszczenie').length
const traces = plan.episodes.filter((e) => e.action === 'slad').length
const verbatim = plan.episodes.filter((e) => e.action === 'zostaje').length
console.log(`summary ${summaries}   trace ${traces}   kept verbatim ${verbatim}`)

if (flag('--print-questions') && log[0]) {
  console.log('\n--- first request to Jev: questions, verbatim ---')
  console.log(JSON.stringify(log[0].questions, null, 2))
}
const out = opt('--out')
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'requests.json'), `${JSON.stringify(log, null, 1)}\n`)
  writeFileSync(join(out, 'result.json'), `${JSON.stringify({ rows_before: messages.length, rows_after: kept.length + extra.length + (plan.header ? 1 : 0), chars_before: before, chars_after: after, haiku_calls: haikuCalls.length, jev_requests: log.length, episodes: plan.episodes.map(({ n, action, reason, kto, tokens_before, tokens_after }) => ({ n, action, reason, kto, tokens_before, tokens_after })) }, null, 1)}\n`)
}
