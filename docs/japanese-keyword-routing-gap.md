# Japanese Keyword Routing Gap

This document records the current state of Japanese-language support across the OMC keyword routing pipeline. **Detection is fully Japanese-aware; alias-based activation is not.** The gap is recorded here so future maintainers can find the asymmetry without re-running the audit.

A machine-readable sentinel of the same gap lives in `src/hooks/keyword-detector/__tests__/index.test.ts` as a `describe.todo('Japanese keyword activation parity', …)` block — one `it.todo` per English/Korean keyword that lacks its Japanese counterpart.

## Coverage (working)

The following layers handle Japanese input correctly today:

- **Script detection** — `NON_LATIN_SCRIPT_PATTERN` at `src/hooks/keyword-detector/index.ts:299-301` covers Hiragana (U+3040–309F), Katakana (U+30A0–30FF), and Kanji (U+4E00–9FFF) via the `　-鿿` range.
- **CJK width** — `isCJKCharacter` at `src/utils/string-width.ts:24-63` enumerates Hiragana, Katakana, Katakana Phonetic Extensions, and CJK Unified Ideographs explicitly.
- **Sanitizer** — `sanitizeForKeywordDetection` at `src/hooks/keyword-detector/index.ts:307-326` strips only structural noise (XML, URLs, file paths, code blocks). Japanese text is preserved.
- **Informational intent guards** — `INFORMATIONAL_INTENT_PATTERNS` at `src/hooks/keyword-detector/index.ts:328-333` includes Japanese intent markers (`とは`, `って何`, `使い方`, `説明`). Tested at `src/hooks/keyword-detector/__tests__/index.test.ts:321-323`.
- **Think mode** — `MULTILINGUAL_KEYWORDS` at `src/hooks/think-mode/detector.ts:19-20` includes `考え` and `熟考`.
- **Learner detector** — `src/hooks/learner/detector.ts:22` documents Japanese support and the patterns at lines 44–48, 73–76 (and similar blocks for technique, workaround, optimization, best-practice) include Japanese tokens.

## Gap (not working)

Two production-code gaps prevent Japanese users from activating mode-routing keywords by writing the keyword in Japanese:

### 1. KEYWORD_PATTERNS has zero Japanese aliases

`KEYWORD_PATTERNS` at `src/hooks/keyword-detector/index.ts:44-63` ships 12 Korean transliteration aliases and zero Japanese ones. Per-keyword breakdown:

| Keyword          | English                                                     | Korean                       | Japanese     |
| ---------------- | ----------------------------------------------------------- | ---------------------------- | ------------ |
| ralph            | `\bralph\b`                                                 | `랄프`                       | **missing**  |
| autopilot        | `\bautopilot\|auto[\s-]?pilot`                              | `오토파일럿`                 | **missing**  |
| ultrawork        | `\bultrawork\|ulw\b`                                        | `울트라워크`                 | **missing**  |
| ralplan          | `\bralplan\b`                                               | `랄플랜`                     | **missing**  |
| tdd              | `\btdd\|test\s+first`                                       | `테스트\s?퍼스트`            | **missing**  |
| code-review      | `code\s+review`                                             | `코드\s?리뷰`                | **missing**  |
| security-review  | `security\s+review`                                         | `보안\s?리뷰`                | **missing**  |
| ultrathink       | `\bultrathink\b`                                            | `울트라씽크`                 | **missing**  |
| deepsearch       | `deepsearch\|search\s+the\s+codebase`                       | `딥\s?서치`                  | **missing**  |
| analyze          | `deep[\s-]?analyze`                                         | `딥\s?분석`                  | **missing**  |
| deep-interview   | `deep[\s-]interview`                                        | `딥인터뷰`                   | **missing**  |
| ccg              | `ccg\|claude-codex-gemini`                                  | `씨씨지`                     | **missing**  |
| cancel           | `\b(cancelomc\|stopomc)\b`                                  | (none)                       | (none)       |
| team             | (disabled)                                                  | (none)                       | (none)       |
| codex            | `\bcodex\b`                                                 | (none)                       | (none)       |
| gemini           | `\bgemini\b`                                                | (none)                       | (none)       |

Twelve keywords have Korean parity. None has Japanese parity.

### 2. transliteration-map is Korean-only

`src/hooks/learner/transliteration-map.ts` is the documented extension point for non-English skill triggers. The file header at line 14 explicitly invites a sibling map (`japanese-map.ts`) but no such file exists. As a result, Japanese loanword variants of custom skill triggers (e.g., `ディープダイブ` for `deep-dive`) are not auto-expanded.

## Impact

Concrete user-facing scenarios that fail today:

- `「ラルフで修正して」` — Ralph, fix this. **No keyword detected.** The Korean equivalent `「랄프로 고쳐줘」` does activate ralph.
- `「ウルトラワークで並列に進めて」` — Ultrawork, run in parallel. **No keyword detected.**
- `「ディープインタビューを始めて」` — Start deep-interview. **No keyword detected.**

Detection still fires `KEYWORD_ROUTING_HINT_MESSAGE` for these prompts, which advises the user to write keywords in English. That advisory is the only mitigation today; there is no automatic transliteration. Users are expected to type the canonical English keyword (`ralph`, `ultrawork`, …) verbatim, even mid-sentence in a Japanese prompt.

## Path forward

Closing the gap is a self-contained, ~2–3 hour task and is intentionally **out of scope for this gap record**. When prioritized:

1. Add Japanese alternation branches to the 12 keyword regexes in `KEYWORD_PATTERNS` (`src/hooks/keyword-detector/index.ts:44-63`), mirroring the existing Korean alternations. Source the canonical katakana spelling per keyword; allow ASCII / katakana mixing where natural (e.g., `ディープ\s?分析`).
2. Create `src/hooks/learner/japanese-map.ts` alongside `transliteration-map.ts`, register it in the same loader, and seed the obvious loanwords (`ディープダイブ`, `トレース`, etc.).
3. Convert the `it.todo` entries in `describe.todo('Japanese keyword activation parity', …)` (`src/hooks/keyword-detector/__tests__/index.test.ts`) into real `it(...)` tests with assertions, mirroring the Korean activation tests at `src/hooks/keyword-detector/__tests__/index.test.ts:1743-2055`.
4. Optionally update the `transliteration-map.ts` JSDoc to link back to this gap document so the durability concern is closed at the source level.

### Out of scope for this audit

- **CLAUDE.md prose triggers.** The keyword-trigger lists in `CLAUDE.md` and `~/.claude/CLAUDE.md` are documentation, not code-level routing. Whether to add Japanese examples there is a separate documentation question.
- **`scripts/`-level routing.** Hook scripts in `scripts/` and `templates/hooks/` were not audited beyond confirming they consume the same `KEYWORD_PATTERNS` exports. Any string-level Japanese handling inside those scripts would be a follow-up audit.
- **Latin-script non-English** (Spanish, French, German, …). Those write English keywords as-is, so routing is unaffected and the script-detection regex intentionally excludes them.
