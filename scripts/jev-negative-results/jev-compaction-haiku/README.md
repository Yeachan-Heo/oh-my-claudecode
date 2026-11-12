# jev-compaction-haiku: step B of the Jev compaction (negative result, not for merge)

Companion of `docs/jev/negative-results/jev-compaction-haiku.md`. Read that first: it states the result and, importantly, that the rejected part is only the Haiku add-on ("step B"), not the `compaction` judgment point, which stays.

## Files

| File | What it is |
|---|---|
| `jev-krok-b.mjs` | The step B block, unchanged (1,885 lines, Polish identifiers `krokB*`). It is not runnable on its own in OMC upstream: it uses 38 names of the local compaction module (25 of them not defined in upstream) it was written for (see the `uses:` lines at its top). |
| `integration-points.patch` | The 7 call points (8 marked fragments) the block needs in that local module (`hooks/jev-compaction.ts`, 99 lines). Applies to the local module with step B removed (sha256 prefix `cbe147511d30442b`), which is not in this repository. The patch makes an unset `OMC_JEV_COMPACT_HYBRID` mean off. |
| `replay.mjs` | Offline replay: loads the block behind stand-ins for the missing names, a fake in-memory host, Haiku and Jev answers from `sample/recorded.json`. No network, no key, no host. |
| `make-sample.mjs`, `sample/session.json` | Generator and output of the synthetic conversation (59 rows, 8 closed episodes). All names, numbers and paths are invented. |
| `sample/recorded.json` | Synthetic recorded answers: one Haiku summary and one Jev decision (choice, probabilities, contradiction probability) per episode. |

## Run (no API calls)

```
node replay.mjs                      # table of what each episode becomes
node replay.mjs --print-questions    # plus the first set of questions sent to Jev, verbatim
node replay.mjs --out /tmp/replay    # plus requests.json (state and questions of every request) and result.json
```

Expected result with the bundled sample (deterministic): 59 rows to 30, 62,915 to 20,188 characters; 17 Haiku calls and 4 Jev requests (all replayed); episodes 1, 2, 4, 6, 8 become summaries, 5 becomes a trace, 3 stays verbatim by Jev's choice, 7 stays verbatim because the recorded contradiction probability (0.6) is not clearly "no", and episode 0 has no recorded answer, so it stays verbatim on the "Jev did not answer" path (nothing is lost). The character counts are the rows' text, tool calls and tool results.

What it exercises: episode splitting, per-part Haiku prompts, the fact-check signals, one question per part, composition of the decision from the choice and the contradiction answer, the plan, and the rewritten rows. What it does not: the hooks host (`$.model.complete`, `$.fs` limits, handles of rows), the real masks of the compaction module (a small stand-in is used), call/result pairing against a real transcript, and anything about quality of real Haiku summaries.

## Live Jev (costs Jev tokens, not run for this branch)

`node replay.mjs --jev live` posts `{ model: 'jev-latest', state, questions }` to `OMC_JEV_ENDPOINT` (default `https://api.typesafe.ai/v1/systemone`) with `TYPESAFE_API_KEY` from the environment, in place of the recorded answers. It is the same call the original measurement harness made. Size of a request: one request carries up to a 56,000-byte body (the window of the compaction module); a full run on a real session of several hundred thousand tokens took 21 to 214 Jev requests, 0.4 to 5.6 million Jev input tokens (see the document). The synthetic sample is small: 4 requests of a few KB each. Haiku is never live here: `$.model.complete` exists only inside the hooks host.

## What the original local test suite covered (not included)

59 tests (in-memory host, fake Jev and Haiku, real masks): episode boundaries and keys, full-text files without truncation (300k characters), secret masking before Haiku and before files, one question per part and its shape, parts aligned to rows, acceptance per part, longer-summary second round, stale plans, Haiku failure keeps earlier decisions, Jev not answering keeps the text, pairing of calls and results after the rewrite, `off` reading nothing. They load the local module and a local tool that pastes the block into it, so they are not part of this branch. They passed 59 of 59 on 12 November 2026 with every `OMC_JEV*` variable and the API key unset, also with the default-off change of the patch.
