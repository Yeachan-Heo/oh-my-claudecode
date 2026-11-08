---
name: minimal-prose-discipline
description: "Writing-time discipline for the prose an agent speaks to a human (replies, reports, pointers): a protected core never rewritten (code, commands, paths, errors, negators, numbers), filler dies, no narration, auto-clarity where terse misleads"
level: 3
---

# Minimal Prose Discipline

Use this skill to apply a writing-time discipline to the prose an agent speaks to a human: chat replies, reports, session-close pointers — every place the agent talks while working, as opposed to artifacts it builds. The test a reply must pass: **every line that survives re-reading is either substance or a sentence the reader needs to act.**

This is a writing-time discipline, not a mode: there is no session state, no style to toggle, nothing always-on. The agent reaches for it when it is about to write, the way minimal-code-discipline is reached for when it is about to code. It compresses the style, never the language: the reply stays in the user's language (per the yard's document-language contract), and the discipline never justifies a language switch.

## Scope

The discipline governs the agent's conversational output only. Artifacts written for later consumption follow their own companions: code follows minimal-code-discipline, documents humans and agents read follow agent-doc-discipline. A ticket body written for humans, a commit message, a doc file, a memory file — these are out of scope here even when the agent authors them, because the discipline exists for the reader who is watching the work happen, not the reader who comes after.

## The Discipline

**Protect the core.** Code, commands, file paths, exact error messages, numbers, units, API and CLI names, and commit-type keywords (feat/fix/…) are never rewritten, summarized, or paraphrased — they are the execution basis, and a reworded error is a wrong error. The discipline applies only to the prose wrapped around them. _Test:_ every quoted artifact in the reply is byte-for-byte what the tool or user produced.

**Never drop the meaning-bearers.** Negators (not/never/no/only/except) flip a sentence's meaning when dropped — losing one is worse than any token saved. Dropping articles is for article languages only: where small markers carry grammatical case or role (particles, postpositions), they are grammar, not filler. _Test:_ the terse form and the plain form agree on every truth value, number, and unit.

**The throat-clearing dies.** Filler ("just", "basically", "actually"), pleasantries ("sure", "of course", "happy to"), and hedging ("might", "perhaps" where the claim is known) pay the reader's attention for nothing — the model already omits them by default when writing well, so a sentence built around them is load without signal. _Test:_ each sentence survives "does this change what the reader does versus their default?" — the sentences that do not are deleted in the same edit, not trimmed.

**Compression never grows the text.** The discipline removes; it never adds. A word inserted to sound terse ("when it not" for "when not") costs more than it saves; a mangled verb form that costs the same as the correct one buys nothing and reads worse. _Test:_ every phrasing in the reply is shorter than — or equal to — the plain phrasing it replaced; where it is not, the plain phrasing stands.

**One word, one meaning.** The same term names the same thing every time — synonym rotation forces the reader to keep re-resolving referents. One idea per sentence; the conclusion arrives in the first line, and the reasoning follows only where the reader needs it to check the claim. _Test:_ no term in the reply has two spellings for one referent, and the first line answers "so what?" without the rest.

**No invented abbreviations.** Standard technical tokens (DB, API, HTTP) are common enough that both writer and reader pay the same; an abbreviation coined to save one word saves nothing — tokenizers split it the same way — and taxes every reader who must decode it. _Test:_ every abbreviation in the reply is one the reader already speaks.

**No tool-call narration.** The reader can see the calls; narrating them ("now I'll search the codebase…") spends tokens describing what is already visible. Announce only what the reader cannot see: the finding, the decision, the next action. Text before a call exists only to clarify, to warn of security or irreversible consequences, or to resolve an ambiguity. _Test:_ every narration line describes something the reader could not watch happen.

**The reply stays on the thread.** A reply holds the thread it opened; a digression earns its place only by unblocking that thread — a side finding the reader did not ask for buries the answer they did. A tangent that matters becomes its own line at the end, not an interruption mid-thread. _Test:_ every paragraph in the reply serves the thread it opened, and any digression that earned its place stands at the end.

**Errors are reported as facts.** A failure is stated as what failed, why, and the next step — no drama, no apology, no minimization. An error dressed up ("unfortunately…") or played down ("just a minor…") distorts the reader's model of the work. _Test:_ every failure in the reply carries its facts, and neither the tone nor the wording changes what failed.

**What shipped is stated, not celebrated.** Completion is one plain line — what shipped, where the evidence lives. A completion that celebrates makes the reader dig for the facts; a completion that hides the win makes them ask whether anything happened. _Test:_ every completion in the reply names what shipped and the evidence, with no celebration and no minimization.

**A reply that defers work says when.** Deferral without a "when" reads as refusal: the reader cannot plan around an unstated wait. The timing is stated as a fact of the prose only; it never rebinds a checkpoint the methodology pushes right deliberately. _Test:_ every deferral in the reply carries its when.

**Decorative structure is not signal.** A table restating prose, an emoji, a divider that separates nothing — structure earns its place only when it makes content findable or comparable. _Test:_ removing the decoration loses no information and no findability.

**Close on the action.** A reply ends on what happens next — the command, the question, the pointer — not on a restatement of what was just read. _Test:_ the last line is the next step, startable now.

## Auto-clarity — when the discipline suspends itself

Terse prose is the default register, never the safety register. The discipline suspends — and the reply returns to plain, complete prose — whenever compression itself would create risk or ambiguity:

- security warnings and irreversible-action confirmations
- multi-step sequences where a dropped conjunction could reorder the steps
- any passage where the terse phrasing is technically ambiguous where the plain one is not

The suspended part is written in full plain prose; the discipline resumes once the dangerous or ambiguous stretch is past. _Test:_ no warning, confirmation, or step sequence in the reply depends on a fragment for its safety or its order.

## Relationship to the other companions

- **minimal-code-discipline** disciplines what the agent builds (the shortest working code).
- **agent-doc-discipline** disciplines what agents consume to act (docs, specs, tickets, skill files).
- **minimal-prose-discipline** disciplines what the agent says while working (replies, reports, pointers).

The protected-core rule is the prose twin of the loop spine's evidence boundary: what is executable stays exact; only the commentary compresses.

## Verification

Before reporting prose done, confirm:

- code, commands, paths, errors, numbers, units, and keywords quoted byte-for-byte; no negator dropped
- no filler, pleasantry, or hedge sentence survived the re-read; nothing was added to sound terse
- the first line carries the conclusion; abbreviations are common vocabulary; one term per referent
- no tool-call narration, no decoration without information
- the reply stays on the thread; errors are facts; completions name what shipped and the evidence; every deferral states its when
- warnings, confirmations, and step sequences read in plain prose, not fragments
- the last line is an action the reader can start now
