# Tool gate: reproduce the measurement

Negative result, not for merge. Background, questions, numbers and the reason for the rejection:
[`docs/jev/negative-results/jev-tool-gate.md`](../../../docs/jev/negative-results/jev-tool-gate.md).

The gate itself is `scripts/lib/jev-tool-gate.mjs` (reduced port, off by default; the hook in
`scripts/pre-tool-enforcer.mjs` imports it only when `OMC_JEV` names `tool-gate`). The six questions
sent to Jev are in `scripts/lib/jev-tool-gate-questions.json`.

Node 20 or newer; no dependencies.

## 1. Count a gate log (no API, no key, no cost)

```
node gate-log-stats.mjs <gate.jsonl>            # a real log written by the gate
node gate-log-stats.mjs --synthetic             # a synthetic log, nothing to download
node gate-log-stats.mjs sample/gate-sample.jsonl --json
```

It counts rows with `point: "tool-gate"` only (the file may share other points) and prints counts and
times, never commands:

- decisions (allow / deny) and the source of each: `static` (fixed rule), `safe` (safe list), `scope`
  (tool not judged), `jev`, and the pass-through sources `jev-degraded`, `jev-none`, `jev-budget`,
  `error`;
- denials, how many were enforced (active mode) and by which rule or axis, and the range of the risk
  of the Jev denials;
- **fail-open**: calls let through because Jev did not answer, and their share of the calls that
  needed an answer;
- **wait for Jev**: median, p95, max and total of `jev_ms`.

`sample/gate-sample.jsonl` is the output of `--synthetic --seed 1 --rows 2000`. Its proportions were
made up to exercise the counting. It says nothing about Jev.

To produce a real log: run a session with `OMC_JEV=tool-gate` (shadow: Jev is asked, nothing is
blocked) and `TYPESAFE_API_KEY` set; the rows go to `gate.jsonl` in the Jev log directory
(`OMC_JEV_LOG_DIR`, else `<state root>/state/jev`). Every judged call is one Jev request and the hook
waits up to 4.5 s for it in active mode; in shadow mode the request is sent in the background.

## 2. Replay labelled calls through the verdict

```
node replay-cases.mjs --sweep                   # offline: recorded answers, no API
node replay-cases.mjs my-cases.jsonl --live     # real Jev, needs TYPESAFE_API_KEY
```

A case is one JSON line: `{ id, tool_name, tool_input, task: { owner_messages: [...] }, label:
"allow" | "deny", recorded_answers?: { niszczace, wyprowadzenie, uprawnienia, sekret, trwala, zlecone } }`.
For each case the script applies the same order as the hook (fixed rules, scope, safe list, then Jev),
and prints the source of the decision and a table: correct allows, correct denials, **false denials**
(label allow, gate deny) and **missed denials**. `--sweep` repeats the verdict for thresholds 0.70 to
0.95.

`sample/cases.jsonl` is **synthetic**: 28 generic commands with invented answers, to exercise the
arithmetic. Two of them show limits of the reduced port on purpose: `c07` (`cat` of a credentials file
passes the safe list) and `c21` (`docker rm -f` is stopped by the fixed rule even though the user
ordered it; the original had an exception for services named in the user's message).

### Cost of `--live`

One Jev request per case that is not decided by a fixed rule or the safe list, with a state of roughly
1,000 to 8,000 characters (the six questions add about 10,000 characters of instructions). At the
numbers measured for the original gate that is about 1.5 to 2.3 s per request. Check your Jev pricing
before running a large set; the original replay used 946 requests for 1,532 calls. With a rate limit,
space the cases out; the original ran 20-24 requests a minute. Nothing in this directory calls the API
unless you pass `--live`.

## 3. Tests

```
npx vitest run src/__tests__/jev-tool-gate.test.mjs
```

Run them with `OMC_JEV*` and `TYPESAFE_API_KEY` unset. They inject the Jev answers and need no network.
