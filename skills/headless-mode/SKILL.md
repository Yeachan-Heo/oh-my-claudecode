---
name: headless-mode
description: Scripted automation with claude -p, batch processing, pipe mode, SDK integration, and non-interactive operation patterns
level: 2
aliases: [headless, batch, scripted, sdk-mode, pipe-mode]
argument-hint: [guide|oneshot|pipe|batch|sdk] - default is guide
---

# Headless Mode Skill

Run Claude Code without an interactive session — one-shot commands, pipe mode, batch processing, and SDK integration for automation.

## Usage

```
/oh-my-claudecode:headless-mode
/oh-my-claudecode:headless-mode guide
/oh-my-claudecode:headless-mode oneshot
/oh-my-claudecode:headless-mode pipe
/oh-my-claudecode:headless-mode batch
/oh-my-claudecode:headless-mode sdk
```

Or say: "headless mode", "one-shot command", "batch processing", "claude SDK", "pipe mode", "scripted automation"

## Modes Overview

| Mode | Interface | Use Case |
|------|-----------|----------|
| Interactive | `claude` | Normal development session |
| **One-shot** | `claude -p "prompt"` | Single task, exit immediately |
| **Pipe** | `echo "..." \| claude -p` | Chain with other CLI tools |
| **Batch** | Script with multiple `claude -p` | Process multiple files/tasks |
| **SDK** | TypeScript/Python import | Programmatic integration |

## Workflow

### Mode: Guide

Display all modes with examples and decision matrix:

```
Which mode should I use?
─────────────────────────────────────────
Interactive session needed?
  YES → `claude` (standard mode)
  NO  → Single task?
          YES → `claude -p "task"` (one-shot)
          NO  → Processing a pipeline?
                  YES → Pipe mode
                  NO  → Multiple files/tasks?
                          YES → Batch script
                          NO  → Building an app?
                                  YES → SDK
                                  NO  → One-shot mode
```

### Mode: One-Shot

Run a single task and exit:

```bash
# Basic one-shot
claude -p "Explain what this function does" --file src/auth.ts

# With specific output format
claude -p "List all TODO comments in this project" --output-format json

# With model selection
claude -p "Review this file for security issues" --model opus --file src/api/routes.ts

# With context from CLAUDE.md (automatic — reads project CLAUDE.md)
cd /my/project && claude -p "Add input validation to the create user endpoint"
```

**One-shot flags:**
| Flag | Purpose | Example |
|------|---------|---------|
| `-p "prompt"` | The task to perform | `-p "fix the failing test"` |
| `--model` | Model selection | `--model sonnet` |
| `--output-format` | Output format | `--output-format json` |
| `--file` | Add file to context | `--file src/main.ts` |
| `--max-tokens` | Limit response length | `--max-tokens 4000` |
| `--no-input` | Disable stdin reading | Used in scripts |

**Output formats:**
- `text` (default) — plain text response
- `json` — structured JSON with `result`, `cost`, `duration`
- `stream` — streaming text output

### Mode: Pipe

Chain Claude Code with other CLI tools:

```bash
# Pipe file content to Claude
cat error.log | claude -p "Analyze these errors and identify the root cause"

# Pipe git diff for review
git diff main | claude -p "Review this diff for issues"

# Pipe test output for diagnosis
npm test 2>&1 | claude -p "These tests are failing. Explain why and suggest fixes."

# Chain multiple tools
find . -name "*.ts" -newer last-review | \
  xargs cat | \
  claude -p "Review these recently changed TypeScript files for quality issues"

# Pipe to another tool
claude -p "Generate a SQL migration for adding a users table" | \
  psql -d mydb

# Use in shell scripting
REVIEW=$(git diff --cached | claude -p "Write a commit message for these changes" --output-format text)
git commit -m "$REVIEW"
```

### Mode: Batch

Process multiple items with a script:

```bash
#!/bin/bash
# batch-review.sh — Review all changed files

for file in $(git diff --name-only main); do
  echo "Reviewing: $file"
  claude -p "Review this file for bugs and code quality issues. Be concise." \
    --file "$file" \
    --output-format json \
    > "reviews/$(basename $file).json"
done

echo "Reviews complete. Check reviews/ directory."
```

```bash
#!/bin/bash
# batch-document.sh — Generate docs for all public APIs

for file in $(find src/api -name "*.ts"); do
  echo "Documenting: $file"
  claude -p "Generate JSDoc documentation for all exported functions in this file. Output only the documented code." \
    --file "$file" \
    > "documented/$(basename $file)"
done
```

```bash
#!/bin/bash
# batch-migrate.sh — Migrate files from one pattern to another

for file in $(grep -rl "oldPattern" src/); do
  echo "Migrating: $file"
  claude -p "In this file, migrate all uses of oldPattern to newPattern. Preserve behavior exactly." \
    --file "$file" \
    --output-format text
done
```

**Batch best practices:**
- Add `--no-input` flag to prevent stdin reading
- Use `--output-format json` for machine-parseable results
- Add error handling (`set -e` or check exit codes)
- Rate limit with `sleep 1` between calls to avoid API limits
- Use `parallel` or `xargs -P` for concurrent processing

### Mode: SDK

Integrate Claude Code programmatically:

#### TypeScript SDK

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Simple message
const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  messages: [
    {
      role: 'user',
      content: 'Review this code for security issues:\n\n' + codeContent,
    },
  ],
});

console.log(message.content[0].text);
```

#### Python SDK

```python
import anthropic

client = anthropic.Anthropic()

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    messages=[
        {"role": "user", "content": f"Review this code:\n\n{code_content}"}
    ]
)

print(message.content[0].text)
```

#### Claude Code as Subprocess

```typescript
import { execSync } from 'child_process';

function claudeCode(prompt: string, options?: { file?: string; model?: string }) {
  const args = [`-p "${prompt}"`, '--output-format json'];
  if (options?.file) args.push(`--file ${options.file}`);
  if (options?.model) args.push(`--model ${options.model}`);

  const result = execSync(`claude ${args.join(' ')}`, {
    encoding: 'utf-8',
    timeout: 120000,
    cwd: process.cwd(),
  });

  return JSON.parse(result);
}

// Usage
const review = claudeCode('Review for security issues', {
  file: 'src/auth.ts',
  model: 'opus',
});
```

#### Agent SDK (Multi-turn)

```typescript
import { Agent } from '@anthropic-ai/claude-agent-sdk';

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  tools: ['bash', 'read', 'write', 'edit'],
});

const result = await agent.run(
  'Fix the failing tests in src/auth.test.ts, then verify all tests pass.'
);

console.log(result.output);
console.log(`Cost: $${result.cost}`);
```

## Automation Patterns

### Pattern 1: Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit
# Review staged changes before committing

DIFF=$(git diff --cached --diff-filter=ACMR)
if [ -z "$DIFF" ]; then exit 0; fi

REVIEW=$(echo "$DIFF" | claude -p "Quick review: any bugs, security issues, or obvious problems? Reply 'LGTM' if clean, or list issues." --output-format text 2>/dev/null)

if echo "$REVIEW" | grep -qi "LGTM"; then
  exit 0
else
  echo "AI Review found issues:"
  echo "$REVIEW"
  echo ""
  read -p "Commit anyway? (y/N) " -n 1 -r
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi
```

### Pattern 2: Watch Mode

```bash
#!/bin/bash
# watch-and-fix.sh — Watch for test failures and auto-fix

while true; do
  RESULT=$(npm test 2>&1)
  if [ $? -ne 0 ]; then
    echo "Tests failed. Attempting auto-fix..."
    echo "$RESULT" | claude -p "Fix the failing tests. Make minimal changes." \
      --output-format text
    sleep 2
  else
    echo "All tests passing."
    sleep 10
  fi
done
```

### Pattern 3: Documentation Generation

```bash
#!/bin/bash
# gen-docs.sh — Generate API documentation from source

claude -p "Generate comprehensive API documentation for this project in Markdown format. Include endpoints, request/response examples, and authentication details." \
  --output-format text \
  > docs/API.md

echo "Documentation generated at docs/API.md"
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Guide displayed** | Show mode overview and decision matrix |
| **One-shot explained** | Show flags, examples, and best practices |
| **Pipe examples shown** | Show pipeline patterns |
| **Batch script generated** | Generate script for user's use case |
| **SDK example provided** | Show code for user's language/framework |

## Notes

- **CLAUDE.md still works**: One-shot and pipe modes read the project's CLAUDE.md automatically.
- **Cost**: Each `claude -p` call starts fresh context — batch jobs can be expensive. Consider batching prompts.
- **Rate limits**: API rate limits apply. Add delays in batch scripts. Use `--max-tokens` to control costs.
- **Security**: Never pass secrets as prompt arguments (visible in process list). Use environment variables.
- **Timeout**: Default timeout varies. Set explicit timeouts in scripts with `timeout` command.
- **Complement to /ci-pipeline**: Use headless mode patterns inside CI workflows generated by `/ci-pipeline`.
- **Complement to /workflow-automation**: Headless mode is the execution layer for automated workflows.

---

Begin headless mode guidance now. Parse the mode and provide the appropriate examples and patterns.
