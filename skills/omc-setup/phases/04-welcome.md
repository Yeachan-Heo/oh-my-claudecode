# Phase 4: Completion

## Detect Upgrade from 2.x

Check if user has existing 2.x configuration:

```bash
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
ls "$CONFIG_DIR/commands/ralph-loop.md" 2>/dev/null
```

If found, this is an upgrade from 2.x. Set `IS_UPGRADE=true`.

## Show Welcome Message

### For New Users (IS_UPGRADE is not true):

```
OMC Setup Complete!

You don't need to learn any commands. I now have intelligent behaviors that activate automatically.

WHAT HAPPENS AUTOMATICALLY:
- Complex tasks -> I parallelize and delegate to specialists

MAGIC KEYWORDS (optional power-user shortcuts):
Just include these words naturally in your request:

| Keyword | Effect | Example |
|---------|--------|---------|
| autopilot | Autonomous execution | "autopilot build me a todo app" |
| ralph | Persistence mode | "ralph: fix the auth bug" |
| ralplan | Iterative consensus planning | "ralplan this feature" |
| deep interview | Requirements interview | "deep interview me before coding" |
| deslop / anti-slop | Cleanup review | "deslop this module" |
| deep-analyze | Analysis mode | "deep-analyze the flaky test" |
| tdd | TDD mode | "tdd the parser" |
| deepsearch | Codebase search | "deepsearch where config is loaded" |
| ultrathink | Deep reasoning | "ultrathink this design" |
| cancelomc | Stop active OMC modes | "cancelomc" |

CANONICAL WORKFLOWS (Tier-0):
omc-plan -> execute -> omc-review -> verify, invoked as /oh-my-claudecode:omc-plan and /oh-my-claudecode:omc-review.
/deep-interview and /ralplan are independent planning workflows.
/research and /team are internal lanes; /autopilot, /autoresearch, /ralph, /ultragoal stay directly invocable.

TEAMS:
Spawn coordinated agents with shared task lists and real-time messaging:
- /oh-my-claudecode:team 3:executor "fix all TypeScript errors"
- /oh-my-claudecode:team 5:debugger "fix build errors in src/"
Teams use Claude Code's implicit agent team (spawn teammates directly with distinct `name` values; no TeamCreate/TeamDelete in Claude Code 2.1.178+). Team orchestration is explicit via /team — there is no bare "team" keyword.

MCP SERVERS:
Register extra MCP servers (web search, GitHub, etc.) through Claude Code's native MCP config (`claude mcp add ...` or the path selected by `CLAUDE_MCP_CONFIG_PATH`; by default, the sibling `.claude.json` next to `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`). OMC's bundled MCP server is already registered via the plugin's .mcp.json.

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

OMC CLI HELPERS (if installed):
- omc hud         - Render the current HUD statusline
- omc teleport    - Create an isolated git worktree
- omc team status - Inspect a running team job
- Session summaries are written to `.omc/sessions/*.json`

That's it! Just use Claude Code normally.
```

### Retired in 5.0.0 (all users)

The following commands and keywords were removed in 5.0.0 and are not aliased:
/ultrawork, /ultraqa, /ultrapilot, /swarm, /pipeline, /merge-readiness,
/deep-dive, /sciomc, /ccg, /omc-teams, /setup, /mcp-setup, /omc-reference,
/learner, /writer-memory, /local-build-reminder.
Use the replacement instead — see the migration table in docs/MIGRATION.md
(commonly /execute for ultrawork, /verify for ultraqa, /team for omc-teams,
/omc-setup for setup, and Claude Code's native MCP config for mcp-setup;
/wiki for omc-reference).

### For Users Upgrading from 2.x (IS_UPGRADE is true):

```
OMC Setup Complete! (Upgraded from 2.x)

IMPORTANT: Some legacy 2.x and 3.x commands were retired in 5.0.0 and are
not aliased. Use the replacement workflows listed in the migration table.

WHAT'S NEW in 3.0:
You no longer NEED those commands. Everything is automatic now:
- Just say "autopilot build me ..." instead of /autopilot
- Just say "ralph: <task>" instead of /ralph
- Just say "cancelomc" instead of /cancel

MAGIC KEYWORDS (power-user shortcuts):
| Keyword | Same as old... | Example |
|---------|----------------|---------|
| autopilot | /autopilot | "autopilot build me a todo app" |
| ralph | /ralph | "ralph: fix the bug" |
| ralplan | /ralplan | "ralplan this feature" |
| deep interview | /deep-interview | "deep interview me before coding" |
| cancelomc | /cancel | "cancelomc" |

TEAMS (NEW!):
Spawn coordinated agents with shared task lists and real-time messaging:
- /oh-my-claudecode:team 3:executor "fix all TypeScript errors"
- Uses Claude Code's implicit agent team (spawn teammates directly with distinct `name` values; no TeamCreate/TeamDelete in Claude Code 2.1.178+)

HUD STATUSLINE:
The status bar now shows OMC state. Restart Claude Code to see it.

OMC CLI HELPERS (if installed):
- omc hud         - Render the current HUD statusline
- omc teleport    - Create an isolated git worktree
- omc team status - Inspect a running team job
- Session summaries are written to `.omc/sessions/*.json`

Your configuration is preserved; retired commands are not recreated.
```

## Optional Rule Templates

OMC includes rule templates you can copy to your project's `.claude/rules/` directory for automatic context injection:

| Template | Purpose |
|----------|---------|
| `coding-style.md` | Code style, immutability, file organization |
| `testing.md` | TDD workflow, 80% coverage target |
| `security.md` | Secret management, input validation |
| `performance.md` | Model selection, context management |
| `git-workflow.md` | Commit conventions, PR workflow |
| `karpathy-guidelines.md` | Coding discipline -- think before coding, simplicity, surgical changes |

Copy with:
```bash
mkdir -p .claude/rules
cp "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/templates/rules/"*.md .claude/rules/
```

See `templates/rules/README.md` for details.

## Ask About Starring Repository

First, check if `gh` CLI is available and authenticated:

```bash
gh auth status &>/dev/null
```

### If gh is available and authenticated:

**Before prompting, check if the repository is already starred:**

```bash
gh api user/starred/Yeachan-Heo/oh-my-claudecode &>/dev/null
```

**If already starred (exit code 0):**
- Skip the prompt entirely
- Continue to completion silently

**If NOT starred (exit code non-zero):**

Use AskUserQuestion:

**Question:** "If you're enjoying oh-my-claudecode, would you like to support the project by starring it on GitHub?"

**Options:**
1. **Yes, star it!** - Star the repository
2. **No thanks** - Skip without further prompts
3. **Maybe later** - Skip without further prompts

If user chooses "Yes, star it!":

```bash
gh api -X PUT user/starred/Yeachan-Heo/oh-my-claudecode 2>/dev/null && echo "Thanks for starring!" || true
```

**Note:** Fail silently if the API call doesn't work - never block setup completion.

### If gh is NOT available or not authenticated:

```bash
echo ""
echo "If you enjoy oh-my-claudecode, consider starring the repo:"
echo "  https://github.com/Yeachan-Heo/oh-my-claudecode"
echo ""
```

## Mark Completion

Get the current OMC version and mark setup complete:

```bash
# Get current OMC version from CLAUDE.md
OMC_VERSION=""
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$CONFIG_DIR" in
  "~") CONFIG_DIR="$HOME" ;;
  "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;;
  "~\\"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~\\}" ;;
esac
if [ -f ".claude/CLAUDE.md" ]; then
  OMC_VERSION=$(grep -m1 'OMC:VERSION:' .claude/CLAUDE.md 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
elif [ -f "$CONFIG_DIR/CLAUDE.md" ]; then
  OMC_VERSION=$(grep -m1 'OMC:VERSION:' "$CONFIG_DIR/CLAUDE.md" 2>/dev/null | sed -E 's/.*OMC:VERSION:([^ ]+).*/\1/' || true)
fi
if [ -z "$OMC_VERSION" ]; then
  OMC_VERSION=$(omc --version 2>/dev/null | head -1 || true)
fi
if [ -z "$OMC_VERSION" ]; then
  OMC_VERSION="unknown"
fi

bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-progress.sh" complete "$OMC_VERSION"
```
