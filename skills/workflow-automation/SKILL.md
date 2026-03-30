---
name: workflow-automation
description: Create automated workflows with webhooks, n8n, scheduled tasks, and multi-system pipelines for CI/CD and operations
level: 3
aliases: [workflow, automation, n8n, webhook, pipeline-automation]
argument-hint: [create|templates|webhook|schedule] - default is templates
---

# Workflow Automation Skill

Create automated workflows that connect Claude Code with external systems. Supports webhook triggers, n8n integration, scheduled tasks, and multi-system pipelines.

## Usage

```
/oh-my-claudecode:workflow-automation
/oh-my-claudecode:workflow-automation create
/oh-my-claudecode:workflow-automation templates
/oh-my-claudecode:workflow-automation webhook
/oh-my-claudecode:workflow-automation schedule
```

Or say: "automate this workflow", "create a webhook", "n8n integration", "schedule a task", "automation pipeline"

## Workflow Patterns

### Pattern 1: PR Review Pipeline

```
GitHub PR opened
  → Webhook triggers Claude Code (headless)
  → Claude reviews code (security + quality)
  → Posts review comments on PR
  → Updates status check
```

**GitHub Actions implementation:**
```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install -g @anthropic-ai/claude-code
      - name: Review PR
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Review the changes in this PR for security, correctness, and code quality. Post findings as a summary." \
            --output-format json > review.json
      - name: Post Review
        uses: actions/github-script@v7
        with:
          script: |
            const review = require('./review.json');
            await github.rest.pulls.createReview({
              ...context.repo,
              pull_number: context.issue.number,
              body: review.result,
              event: 'COMMENT'
            });
```

### Pattern 2: Automated Bug Triage

```
Issue created (GitHub/Jira)
  → Webhook triggers Claude Code
  → Claude analyzes issue description
  → Searches codebase for relevant files
  → Labels issue with severity/component
  → Suggests fix approach in comment
```

### Pattern 3: Deploy + Verify Pipeline

```
Code merged to main
  → CI builds and deploys
  → Webhook triggers Claude Code
  → Claude runs smoke tests
  → Claude checks health endpoint
  → Posts deploy status to Slack
  → If unhealthy: creates rollback PR
```

### Pattern 4: Scheduled Code Health

```
Weekly cron schedule
  → Claude Code runs in headless mode
  → Dependency audit (npm audit / cargo audit)
  → Tech debt assessment
  → Security scan
  → Generates health report
  → Posts to Slack/email
```

### Pattern 5: Auto-Documentation

```
PR merged
  → Webhook triggers Claude Code
  → Claude reads the diff
  → Updates relevant docs (README, API docs, CHANGELOG)
  → Creates follow-up PR with doc updates
```

### Pattern 6: Incident Response

```
PagerDuty/Datadog alert
  → Webhook triggers Claude Code
  → Claude analyzes error logs
  → Searches codebase for error origin
  → Posts initial analysis to incident channel
  → Suggests hotfix if clear root cause
```

## Workflow

### Mode: Templates

Display the pattern catalog above with implementation details.

### Mode: Create

Interactive workflow builder:

#### 1. Define Trigger

```
What triggers this workflow?
  1. GitHub event (PR, issue, push, release)
  2. Scheduled (cron/timer)
  3. Webhook (external service)
  4. Manual (CLI command)
```

#### 2. Define Actions

```
What should happen?
  1. Code review
  2. Code generation/fix
  3. Analysis/report
  4. Deploy verification
  5. Notification
  6. Custom
```

#### 3. Define Output

```
Where should results go?
  1. GitHub (PR comment, issue comment, status check)
  2. Slack/Discord
  3. Email
  4. File (report, PR, commit)
  5. Webhook (forward to another service)
```

#### 4. Generate Implementation

Based on choices, generate:
- GitHub Actions workflow YAML (if GitHub trigger)
- n8n workflow JSON (if complex multi-system)
- Shell script (if CLI/cron trigger)
- Webhook handler (if external trigger)

### Mode: Webhook

Create a webhook receiver for Claude Code:

```javascript
// webhook-handler.js
// Receives webhooks and triggers Claude Code in headless mode
import { execSync } from 'child_process';
import http from 'http';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const event = JSON.parse(body);
    const prompt = buildPrompt(event);

    // Run Claude Code headless
    const result = execSync(
      `claude -p "${prompt}" --output-format json`,
      { encoding: 'utf-8', timeout: 120000 }
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(result);
  });
});

function buildPrompt(event) {
  // Build context-aware prompt from webhook payload
  return `Analyze this event and take appropriate action: ${JSON.stringify(event)}`;
}

server.listen(3000, () => console.log('Webhook handler on :3000'));
```

### Mode: Schedule

Set up scheduled Claude Code tasks:

**Using cron (system-level):**
```bash
# Weekly security audit every Monday at 9am
0 9 * * 1 cd /path/to/project && claude -p "/oh-my-claudecode:security-audit quick" --output-format json > /tmp/security-report.json

# Daily dependency check
0 8 * * * cd /path/to/project && claude -p "Check for outdated dependencies and security vulnerabilities" > /tmp/dep-check.txt
```

**Using GitHub Actions scheduled workflow:**
```yaml
name: Weekly Health Check
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9am UTC
  workflow_dispatch:      # Manual trigger

jobs:
  health-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install -g @anthropic-ai/claude-code
      - name: Run Health Check
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Run a full project health check: dependencies, security, tech debt, test coverage. Output a structured report."
```

**Using OMC session cron (in-session only):**
```
CronCreate(cron="0 */2 * * *", prompt="Run /oh-my-claudecode:security-audit quick and report findings")
```

## n8n Integration

For complex multi-system workflows, use n8n:

#### Claude Code + n8n Architecture
```
n8n Workflow
  ├→ Trigger Node (webhook/schedule/event)
  ├→ Execute Command Node (claude -p "...")
  ├→ Parse JSON Node (extract results)
  ├→ Conditional Node (route by result)
  │   ├→ Success: Slack notification
  │   └→ Failure: Create GitHub issue
  └→ Log Node (audit trail)
```

#### Key n8n Nodes for Claude Code:
- **Execute Command**: Run `claude -p "prompt" --output-format json`
- **HTTP Request**: Call Claude API directly for more control
- **GitHub**: Create PRs, issues, comments
- **Slack**: Post messages, create threads
- **Webhook**: Receive triggers from external services

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Workflow created** | Files generated, instructions for setup provided |
| **Templates shown** | Display pattern catalog |
| **Webhook created** | Handler script and registration instructions |
| **Schedule created** | Cron entry or GitHub Actions workflow |

## Notes

- **Headless mode is key**: All automated workflows use `claude -p` for non-interactive execution.
- **API key required**: Automated workflows need `ANTHROPIC_API_KEY` configured as a secret.
- **Cost awareness**: Scheduled/automated workflows consume tokens. Budget accordingly.
- **Security**: Never expose API keys in workflow definitions. Use secret management.
- **Rate limits**: Automated workflows should include retry logic and respect rate limits.
- **Complement to /ci-pipeline**: Use `/ci-pipeline` for CI/CD specific workflows. Use `/workflow-automation` for broader automation patterns.

---

Begin workflow automation now. Parse the mode and show templates or start the creation wizard.
