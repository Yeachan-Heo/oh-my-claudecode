# Claude-to-Codex Agent Prompt Conversion Guide

## Style Comparison

| Aspect | Claude (Current) | Codex (Target) |
|--------|-----------------|----------------|
| Structure | XML tags (`<Agent_Prompt>`, `<Role>`, etc.) | Flat markdown with **bold Title Case** headers (1-3 words) |
| Tone | Prescriptive, rule-heavy | Autonomous senior engineer, concise teammate |
| Verbosity | Detailed step-by-step protocols | Concise directives, trust autonomy |
| Lists | XML-wrapped sections with numbered lists | Dash bullets, flat (no nesting), parallel wording |
| Examples | `<Good>` / `<Bad>` XML tags | Fenced code blocks or plain text with backtick paths |
| File refs | `file.ts:42` in prose | `` `file.ts:42` `` backtick-wrapped, standalone |
| Code | Inline in XML | Fenced blocks with info strings (```ts) |
| Planning | Explicit step-by-step protocols | Skip upfront plans for simple tasks; update_plan for complex |
| Status | Explicit output format sections | No intermediate status instructions (causes premature stopping) |
| Tools | Claude tool names (Read, Write, Edit, Bash, Glob, Grep) | Codex tool names (apply_patch, shell, read_file, ripgrep) |
| Frontmatter | YAML (name, description, model, disallowedTools) | Keep YAML frontmatter (our loading system uses it) |

## Conversion Rules

### 1. Remove All XML Tags
Replace `<Agent_Prompt>`, `<Role>`, `<Why_This_Matters>`, etc. with flat markdown headers:
- `<Role>` -> **Role** paragraph (2-3 sentences max)
- `<Why_This_Matters>` -> fold into Role or drop (Codex is autonomy-first)
- `<Success_Criteria>` -> **Success Criteria** (dash bullets)
- `<Constraints>` -> **Constraints** (dash bullets)
- `<Investigation_Protocol>` -> **Workflow** (numbered, concise)
- `<Tool_Usage>` -> **Tools** (dash bullets with Codex tool names)
- `<Execution_Policy>` -> fold into Constraints or Workflow
- `<Output_Format>` -> **Output** (concise format spec)
- `<Failure_Modes_To_Avoid>` -> **Avoid** (dash bullets, terse)
- `<Examples>` -> **Examples** with fenced blocks or backtick paths
- `<Final_Checklist>` -> drop (Codex handles autonomously) or compress to 2-3 items max

### 2. Tool Name Mapping
- `Read` -> `read_file` / batch with `multi_tool_use.parallel`
- `Write` -> `apply_patch` (for edits) or `write_file` (new files)
- `Edit` -> `apply_patch`
- `Bash` -> `shell` (use string format, specify `workdir`)
- `Glob` -> `ripgrep` with `--files` or `shell` with `find`
- `Grep` -> `ripgrep`
- `lsp_diagnostics` -> keep (MCP tool, same interface)
- `ast_grep_search` -> keep (MCP tool, same interface)
- `ask_gemini` -> keep (MCP tool reference)

### 3. Flatten and Compress
- Max 60% of original line count
- No nested bullet hierarchies
- Active voice throughout
- Group related bullets
- Order: general -> specific -> supporting
- Parallel wording across similar items

### 4. Autonomy-First Framing
- Remove "you must" / "you are required to" -> state what to do directly
- Remove explicit "do not stop" / "keep working" instructions
- Remove explicit output templates (let model use natural structure)
- Keep output format as a brief suggestion, not a rigid template
- Remove `<Final_Checklist>` sections (Codex self-verifies)

### 5. Preserve Semantic Content
- Keep the role identity and boundaries (responsible for / not responsible for)
- Keep the core domain expertise and investigation patterns
- Keep Good/Bad examples (reformat as plain text)
- Keep tool-specific guidance (just rename tools)
- Keep disallowedTools in frontmatter

### 6. Codex-Specific Additions
- Add "bias toward action" framing where appropriate
- Add "batch reads with multi_tool_use.parallel" for exploration agents
- Add "use apply_patch for single-file edits" for implementation agents
- Reference AGENTS.md discovery pattern where relevant

## File Naming
Same as source: `agents.codex/{agent-name}.md`

## Template

```markdown
---
name: {agent-name}
description: {description}
model: {model}
disallowedTools: {if any}
---

**Role**
{2-3 sentences: identity, responsibility, boundaries}

**Success Criteria**
- {criterion 1}
- {criterion 2}

**Constraints**
- {constraint 1}
- {constraint 2}

**Workflow**
1. {step 1}
2. {step 2}

**Tools**
- `ripgrep` for pattern search
- `apply_patch` for file edits
- `shell` for commands (always specify `workdir`)

**Output**
{Brief format suggestion - not rigid template}

**Avoid**
- {anti-pattern 1}: {why and what instead}
- {anti-pattern 2}: {why and what instead}

**Examples**
- Good: {concise example with backtick file refs}
- Bad: {concise counter-example}
```
