---
name: project-session-manager
description: Manage isolated dev environments with git worktrees and tmux sessions
aliases: [psm]
---

# Project Session Manager (PSM) Skill

Automate isolated development environments using git worktrees and tmux sessions with Claude Code. Enables parallel work across multiple tasks, projects, and repositories.

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `review <ref>` | PR review session | `/psm review omc#123` |
| `fix <ref>` | Issue fix session | `/psm fix omc#42` |
| `feature <proj> <name>` | Feature development | `/psm feature omc add-webhooks` |
| `list [project]` | List active sessions | `/psm list` |
| `attach <session>` | Attach to session | `/psm attach omc:pr-123` |
| `kill <session>` | Kill session | `/psm kill omc:pr-123` |
| `cleanup` | Clean merged/closed | `/psm cleanup` |
| `status` | Current session info | `/psm status` |

## Project References

Supported formats:
- **Alias**: `omc#123` (requires `~/.psm/projects.json`)
- **Full**: `owner/repo#123`
- **URL**: `https://github.com/owner/repo/pull/123`
- **Current**: `#123` (uses current directory's repo)

## Configuration

### Project Aliases (`~/.psm/projects.json`)

```json
{
  "aliases": {
    "omc": {
      "repo": "Yeachan-Heo/oh-my-claudecode",
      "local": "~/Workspace/oh-my-claudecode",
      "default_base": "main"
    }
  },
  "defaults": {
    "worktree_root": "~/.psm/worktrees",
    "cleanup_after_days": 14
  }
}
```

## Providers

PSM supports multiple issue tracking providers:

| Provider | CLI Required | Reference Formats | Commands |
|----------|--------------|-------------------|----------|
| GitHub (default) | `gh` | `owner/repo#123`, `alias#123`, GitHub URLs | review, fix, feature |
| Jira | `jira` | `PROJ-123` (if PROJ configured), `alias#123` | fix, feature |

### Jira Configuration

To use Jira, add an alias with `jira_project` and `provider: "jira"`:

```json
{
  "aliases": {
    "mywork": {
      "jira_project": "MYPROJ",
      "repo": "mycompany/my-project",
      "local": "~/Workspace/my-project",
      "default_base": "develop",
      "provider": "jira"
    }
  }
}
```

**Important:** The `repo` field is still required for cloning the git repository. Jira tracks issues, but you work in a git repo.

For non-GitHub repos, use `clone_url` instead:
```json
{
  "aliases": {
    "private": {
      "jira_project": "PRIV",
      "clone_url": "git@gitlab.internal:team/repo.git",
      "local": "~/Workspace/repo",
      "provider": "jira"
    }
  }
}
```

### Jira Reference Detection

PSM only recognizes `PROJ-123` format as Jira when `PROJ` is explicitly configured as a `jira_project` in your aliases. This prevents false positives from branch names like `FIX-123`.

### Jira Examples

```bash
# Fix a Jira issue (MYPROJ must be configured)
psm fix MYPROJ-123

# Fix using alias (recommended)
psm fix mywork#123

# Feature development (works same as GitHub)
psm feature mywork add-webhooks

# Note: 'psm review' is not supported for Jira (no PR concept)
# Use 'psm fix' for Jira issues
```

### Jira CLI Setup

Install the Jira CLI:
```bash
# macOS
brew install ankitpokhrel/jira-cli/jira-cli

# Linux
# See: https://github.com/ankitpokhrel/jira-cli#installation

# Configure (interactive)
jira init
```

The Jira CLI handles authentication separately from PSM.

## Directory Structure

```
~/.psm/
├── projects.json       # Project aliases
├── sessions.json       # Active session registry
└── worktrees/          # Worktree storage
    └── <project>/
        └── <type>-<id>/
```

## Session Naming

| Type | Tmux Session | Worktree Dir |
|------|--------------|--------------|
| PR Review | `psm:omc:pr-123` | `~/.psm/worktrees/omc/pr-123` |
| Issue Fix | `psm:omc:issue-42` | `~/.psm/worktrees/omc/issue-42` |
| Feature | `psm:omc:feat-auth` | `~/.psm/worktrees/omc/feat-auth` |

---

## Implementation Protocol

When the user invokes a PSM command, follow this protocol:

### Parse Arguments

Parse `{{ARGUMENTS}}` to determine:
1. **Subcommand**: review, fix, feature, list, attach, kill, cleanup, status
2. **Reference**: project#number, URL, or session ID
3. **Options**: --branch, --base, --no-claude, --no-tmux, etc.

### Subcommand: `review <ref>`

**Purpose**: Create PR review session

**Steps**:

1. **Resolve reference**:
   ```bash
   # Read project aliases
   cat ~/.psm/projects.json 2>/dev/null || echo '{"aliases":{}}'

   # Parse ref format: alias#num, owner/repo#num, or URL
   # Extract: project_alias, repo (owner/repo), pr_number, local_path
   ```

2. **Fetch PR info**:
   ```bash
   gh pr view <pr_number> --repo <repo> --json number,title,author,headRefName,baseRefName,body,files,url
   ```

3. **Ensure local repo exists**:
   ```bash
   # If local path doesn't exist, clone
   if [[ ! -d "$local_path" ]]; then
     git clone "https://github.com/$repo.git" "$local_path"
   fi
   ```

4. **Create worktree**:
   ```bash
   worktree_path="$HOME/.psm/worktrees/$project_alias/pr-$pr_number"

   # Fetch PR branch
   cd "$local_path"
   git fetch origin "pull/$pr_number/head:pr-$pr_number-review"

   # Create worktree
   git worktree add "$worktree_path" "pr-$pr_number-review"
   ```

5. **Create session metadata**:
   ```bash
   cat > "$worktree_path/.psm-session.json" << EOF
   {
     "id": "$project_alias:pr-$pr_number",
     "type": "review",
     "project": "$project_alias",
     "ref": "pr-$pr_number",
     "branch": "<head_branch>",
     "base": "<base_branch>",
     "created_at": "$(date -Iseconds)",
     "tmux_session": "psm:$project_alias:pr-$pr_number",
     "worktree_path": "$worktree_path",
     "source_repo": "$local_path",
     "github": {
       "pr_number": $pr_number,
       "pr_title": "<title>",
       "pr_author": "<author>",
       "pr_url": "<url>"
     },
     "state": "active"
   }
   EOF
   ```

6. **Update sessions registry**:
   ```bash
   # Add to ~/.psm/sessions.json
   ```

7. **Create tmux session**:
   ```bash
   tmux new-session -d -s "psm:$project_alias:pr-$pr_number" -c "$worktree_path"
   ```

8. **Launch Claude Code** (unless --no-claude):
   ```bash
   tmux send-keys -t "psm:$project_alias:pr-$pr_number" "claude" Enter
   ```

9. **Output session info**:
   ```
   Session ready!

     ID: omc:pr-123
     Worktree: ~/.psm/worktrees/omc/pr-123
     Tmux: psm:omc:pr-123

   To attach: tmux attach -t psm:omc:pr-123
   ```

### Subcommand: `fix <ref>`

**Purpose**: Create issue fix session

**Steps**:

1. **Resolve reference** (same as review)

2. **Fetch issue info**:
   ```bash
   gh issue view <issue_number> --repo <repo> --json number,title,body,labels,url
   ```

3. **Create feature branch**:
   ```bash
   cd "$local_path"
   git fetch origin main
   branch_name="fix/$issue_number-$(echo "$title" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | head -c 30)"
   git checkout -b "$branch_name" origin/main
   ```

4. **Create worktree**:
   ```bash
   worktree_path="$HOME/.psm/worktrees/$project_alias/issue-$issue_number"
   git worktree add "$worktree_path" "$branch_name"
   ```

5. **Create session metadata** (similar to review, type="fix")

6. **Update registry, create tmux, launch claude** (same as review)

### Subcommand: `feature <project> <name>`

**Purpose**: Start feature development

**Steps**:

1. **Resolve project** (from alias or path)

2. **Create feature branch**:
   ```bash
   cd "$local_path"
   git fetch origin main
   branch_name="feature/$feature_name"
   git checkout -b "$branch_name" origin/main
   ```

3. **Create worktree**:
   ```bash
   worktree_path="$HOME/.psm/worktrees/$project_alias/feat-$feature_name"
   git worktree add "$worktree_path" "$branch_name"
   ```

4. **Create session, tmux, launch claude** (same pattern)

### Subcommand: `list [project]`

**Purpose**: List active sessions

**Steps**:

1. **Read sessions registry**:
   ```bash
   cat ~/.psm/sessions.json 2>/dev/null || echo '{"sessions":{}}'
   ```

2. **Check tmux sessions**:
   ```bash
   tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^psm:"
   ```

3. **Check worktrees**:
   ```bash
   ls -la ~/.psm/worktrees/*/ 2>/dev/null
   ```

4. **Format output**:
   ```
   Active PSM Sessions:

   ID                 | Type    | Status   | Worktree
   -------------------|---------|----------|---------------------------
   omc:pr-123        | review  | active   | ~/.psm/worktrees/omc/pr-123
   omc:issue-42      | fix     | detached | ~/.psm/worktrees/omc/issue-42
   ```

### Subcommand: `attach <session>`

**Purpose**: Attach to existing session

**Steps**:

1. **Parse session ID**: `project:type-number`

2. **Verify session exists**:
   ```bash
   tmux has-session -t "psm:$session_id" 2>/dev/null
   ```

3. **Attach**:
   ```bash
   tmux attach -t "psm:$session_id"
   ```

### Subcommand: `kill <session>`

**Purpose**: Kill session and cleanup

**Steps**:

1. **Kill tmux session**:
   ```bash
   tmux kill-session -t "psm:$session_id" 2>/dev/null
   ```

2. **Remove worktree**:
   ```bash
   worktree_path=$(jq -r ".sessions[\"$session_id\"].worktree" ~/.psm/sessions.json)
   source_repo=$(jq -r ".sessions[\"$session_id\"].source_repo" ~/.psm/sessions.json)

   cd "$source_repo"
   git worktree remove "$worktree_path" --force
   ```

3. **Update registry**:
   ```bash
   # Remove from sessions.json
   ```

### Subcommand: `cleanup`

**Purpose**: Clean up merged PRs and closed issues

**Steps**:

1. **Read all sessions**

2. **For each PR session, check if merged**:
   ```bash
   gh pr view <pr_number> --repo <repo> --json merged,state
   ```

3. **For each issue session, check if closed**:
   ```bash
   gh issue view <issue_number> --repo <repo> --json closed,state
   ```

4. **Clean up merged/closed sessions**:
   - Kill tmux session
   - Remove worktree
   - Update registry

5. **Report**:
   ```
   Cleanup complete:
     Removed: omc:pr-123 (merged)
     Removed: omc:issue-42 (closed)
     Kept: omc:feat-auth (active)
   ```

### Subcommand: `status`

**Purpose**: Show current session info

**Steps**:

1. **Detect current session** from tmux or cwd:
   ```bash
   tmux display-message -p "#{session_name}" 2>/dev/null
   # or check if cwd is inside a worktree
   ```

2. **Read session metadata**:
   ```bash
   cat .psm-session.json 2>/dev/null
   ```

3. **Show status**:
   ```
   Current Session: omc:pr-123
   Type: review
   PR: #123 - Add webhook support
   Branch: feature/webhooks
   Created: 2 hours ago
   ```

---

## Error Handling

| Error | Resolution |
|-------|------------|
| Worktree exists | Offer: attach, recreate, or abort |
| PR not found | Verify URL/number, check permissions |
| No tmux | Warn and skip session creation |
| No gh CLI | Error with install instructions |

## Requirements

Required:
- `git` - Version control (with worktree support v2.5+)
- `jq` - JSON parsing
- `tmux` - Session management (optional, but recommended)

Optional (per provider):
- `gh` - GitHub CLI (for GitHub workflows)
- `jira` - Jira CLI (for Jira workflows)

## Initialization

On first run, create default config:

```bash
mkdir -p ~/.psm/worktrees ~/.psm/logs

# Create default projects.json if not exists
if [[ ! -f ~/.psm/projects.json ]]; then
  cat > ~/.psm/projects.json << 'EOF'
{
  "aliases": {
    "omc": {
      "repo": "Yeachan-Heo/oh-my-claudecode",
      "local": "~/Workspace/oh-my-claudecode",
      "default_base": "main"
    }
  },
  "defaults": {
    "worktree_root": "~/.psm/worktrees",
    "cleanup_after_days": 14,
    "auto_cleanup_merged": true
  }
}
EOF
fi

# Create sessions.json if not exists
if [[ ! -f ~/.psm/sessions.json ]]; then
  echo '{"version":1,"sessions":{},"stats":{"total_created":0,"total_cleaned":0}}' > ~/.psm/sessions.json
fi
```
