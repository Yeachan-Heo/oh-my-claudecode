---
name: ccg
description: Claude-Codex-Gemini-Qwen multi-model orchestration via /ask codex + /ask gemini + optionally /ask qwen, then Claude synthesizes results
level: 5
---

# CCG - Claude-Codex-Gemini(-Qwen) Multi-Model Orchestration

CCG routes through the canonical `/ask` skill (`/ask codex` + `/ask gemini`, optionally + `/ask qwen`), then Claude synthesizes all outputs into one answer.

Use this when you want parallel external perspectives without launching tmux team workers.

## When to Use

- Backend/analysis + frontend/UI work in one request
- Code review from multiple perspectives (architecture + design/UX + code generation)
- Cross-validation where Codex, Gemini, and Qwen may disagree
- Fast advisor-style parallel input without team runtime orchestration

## Requirements

- **Codex CLI**: `npm install -g @openai/codex` (or `@openai/codex`)
- **Gemini CLI**: `npm install -g @google/gemini-cli`
- **Qwen CLI** (optional): `npm install -g @anthropic-ai/qwen-cli` (or `pip install qwen-agent`)
- `omc ask` command available
- If any CLI is unavailable, continue with whichever providers are available and note the limitation

## How It Works

```text
1. Claude decomposes the request into advisor prompts:
   - Codex prompt (analysis/architecture/backend)
   - Gemini prompt (UX/design/docs/alternatives)
   - Qwen prompt (optional: code generation/optimization/multilingual)

2. Claude runs via CLI (skill nesting not supported):
   - `omc ask codex "<codex prompt>"`
   - `omc ask gemini "<gemini prompt>"`
   - `omc ask qwen "<qwen prompt>"` (if Qwen CLI is available)

3. Artifacts are written under `.omc/artifacts/ask/`

4. Claude synthesizes all outputs into one final response
```

## Execution Protocol

When invoked, Claude MUST follow this workflow:

### 1. Decompose Request
Split the user request into:

- **Codex prompt:** architecture, correctness, backend, risks, test strategy
- **Gemini prompt:** UX/content clarity, alternatives, edge-case usability, docs polish
- **Qwen prompt (optional):** code generation quality, optimization, multilingual support, algorithm review
- **Synthesis plan:** how to reconcile conflicts

### 2. Invoke advisors via CLI

> **Note:** Skill nesting (invoking a skill from within an active skill) is not supported in Claude Code. Always use the direct CLI path via Bash tool.

Run advisors (Qwen is optional based on CLI availability):

```bash
omc ask codex "<codex prompt>"
omc ask gemini "<gemini prompt>"
omc ask qwen "<qwen prompt>"   # optional — skip if qwen CLI unavailable
```

### 3. Collect artifacts

Read latest ask artifacts from:

```text
.omc/artifacts/ask/codex-*.md
.omc/artifacts/ask/gemini-*.md
.omc/artifacts/ask/qwen-*.md   (if Qwen was invoked)
```

### 4. Synthesize

Return one unified answer with:

- Agreed recommendations
- Conflicting recommendations (explicitly called out)
- Chosen final direction + rationale
- Action checklist

## Fallbacks

If one provider is unavailable:

- Continue with available provider + Claude synthesis
- Clearly note missing perspective and risk

If both unavailable:

- Fall back to Claude-only answer and state CCG external advisors were unavailable

## Invocation

```bash
/oh-my-claudecode:ccg <task description>
```

Example:

```bash
/oh-my-claudecode:ccg Review this PR - architecture/security via Codex and UX/readability via Gemini
```
