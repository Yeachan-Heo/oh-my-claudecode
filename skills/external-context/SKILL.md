---
name: external-context
description: Invoke Gemini MCP (preferred) or parallel document-specialist agents for external web searches and documentation lookup
argument-hint: <search query or topic>
---

# External Context Skill

Fetch external documentation, references, and context for a query. Uses Gemini MCP as the preferred path (single call, 1M context window); falls back to parallel document-specialist Claude agents when MCP is unavailable.

## Overview

1. **Preferred: Gemini MCP** - Single `ask_gemini` call with `agent_role="document-specialist"` handles multi-facet synthesis in one shot
2. **Fallback: Parallel agents** - Decompose into 2-5 facets, spawn parallel document-specialist Claude agents

## Usage

```
/oh-my-claudecode:external-context <topic or question>
```

### Examples

```
/oh-my-claudecode:external-context What are the best practices for JWT token rotation in Node.js?
/oh-my-claudecode:external-context Compare Prisma vs Drizzle ORM for PostgreSQL
/oh-my-claudecode:external-context Latest React Server Components patterns and conventions
```

## Protocol

### Step 0: Discover MCP Tools

Before first MCP use, call `ToolSearch("mcp")` to discover deferred MCP tools. If results include `ask_gemini`, use the Preferred path. If no MCP tools are found, use the Fallback path.

---

### Preferred Path: Gemini MCP

**When:** `ToolSearch("mcp")` returns `ask_gemini`.

1. Write the query to a prompt file:

```
.omc/prompts/ext-context-{timestamp}.md
```

Prompt file contents:

```markdown
Search the web for external documentation, examples, and references on the following query:

**Query:** <original query>

Cover all relevant facets (up to 5). For each facet:
- Cite all sources with URLs
- Summarize key findings
- Note any version/date caveats

Output format:
## External Context: <query>

### Key Findings
1. **<finding>** - Source: [title](url)

### Detailed Results

#### Facet 1: <name>
<aggregated findings with citations>

### Sources
- [Source 1](url)
```

2. Call `ask_gemini` with background execution:

```python
ask_gemini(
    agent_role="document-specialist",
    prompt_file=".omc/prompts/ext-context-{timestamp}.md",
    output_file=".omc/prompts/ext-context-{timestamp}-output.md",
    background=True
)
```

3. Wait for completion:

```python
wait_for_job(job_id=<returned job id>)
```

4. Read the output file and present synthesized results to the user.

---

### Fallback Path: Parallel Document-Specialist Agents

**When:** `ToolSearch("mcp")` returns no MCP tools (Gemini unavailable).

#### Facet Decomposition

Given a query, decompose into 2-5 independent search facets:

```markdown
## Search Decomposition

**Query:** <original query>

### Facet 1: <facet-name>
- **Search focus:** What to search for
- **Sources:** Official docs, GitHub, blogs, etc.

### Facet 2: <facet-name>
...
```

#### Parallel Agent Invocation

Fire independent facets in parallel via Task tool:

```
Task(subagent_type="oh-my-claudecode:document-specialist", model="sonnet", prompt="Search for: <facet 1 description>. Use WebSearch and WebFetch to find official documentation and examples. Cite all sources with URLs.")

Task(subagent_type="oh-my-claudecode:document-specialist", model="sonnet", prompt="Search for: <facet 2 description>. Use WebSearch and WebFetch to find official documentation and examples. Cite all sources with URLs.")
```

Maximum 5 parallel document-specialist agents.

---

### Synthesis Output Format

Regardless of path used, present results in this format:

```markdown
## External Context: <query>

### Key Findings
1. **<finding>** - Source: [title](url)
2. **<finding>** - Source: [title](url)

### Detailed Results

#### Facet 1: <name>
<aggregated findings with citations>

#### Facet 2: <name>
<aggregated findings with citations>

### Sources
- [Source 1](url)
- [Source 2](url)
```

## Configuration

- Maximum 5 parallel document-specialist agents (fallback path)
- Gemini handles multi-facet synthesis in one shot (preferred path)
- No magic keyword trigger - explicit invocation only
