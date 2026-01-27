# Project Session Manager (PSM) - Design Document

> **Skill Name:** `project-session-manager` (alias: `psm`)
> **Version:** 1.0.0
> **Author:** oh-my-claudecode
> **Status:** Design Draft

## Executive Summary

Project Session Manager (PSM) automates the creation and management of isolated development environments using git worktrees and tmux sessions with Claude Code. It enables parallel work across multiple tasks, projects, and repositories while maintaining clean separation and easy context switching.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Use Cases](#2-use-cases)
3. [Command Interface](#3-command-interface)
4. [Architecture](#4-architecture)
5. [Directory Structure](#5-directory-structure)
6. [Session Naming Conventions](#6-session-naming-conventions)
7. [Workflow Presets](#7-workflow-presets)
8. [State Management](#8-state-management)
9. [Cleanup Strategies](#9-cleanup-strategies)
10. [Integration Points](#10-integration-points)
11. [Edge Cases & Error Handling](#11-edge-cases--error-handling)
12. [Security Considerations](#12-security-considerations)
13. [Future Enhancements](#13-future-enhancements)

---

## 1. Problem Statement

### Current Pain Points

1. **Context Switching Overhead**: Switching between tasks requires stashing changes, switching branches, and losing Claude Code context
2. **PR Review Isolation**: Reviewing PRs often contaminates the working directory
3. **Parallel Work Limitation**: Can only work on one task at a time per repository
4. **Session Management**: Manual tmux session creation is tedious and inconsistent
5. **Cleanup Burden**: Orphaned worktrees and sessions accumulate over time

### Solution

PSM provides a unified interface to:
- Create isolated worktrees with a single command
- Spawn pre-configured tmux sessions with Claude Code
- Track and manage all active sessions
- Automate cleanup of completed work

---

## 2. Use Cases

### 2.1 PR Review

```bash
# Review PR #123 from oh-my-claudecode repo
/psm review omc#123

# Review PR from any GitHub URL
/psm review https://github.com/anthropics/claude-code/pull/456

# Review with specific focus
/psm review omc#123 --focus "security implications"
```

**What happens:**
1. Fetches PR branch
2. Creates worktree at `~/.psm/worktrees/omc/pr-123`
3. Spawns tmux session `psm:omc:pr-123`
4. Launches Claude Code with PR context pre-loaded
5. Opens diff in editor (optional)

### 2.2 Issue Fixing

```bash
# Fix issue #42
/psm fix omc#42

# Fix with branch name override
/psm fix omc#42 --branch fix/auth-timeout

# Fix from issue URL
/psm fix https://github.com/anthropics/claude-code/issues/789
```

**What happens:**
1. Fetches issue details via `gh`
2. Creates feature branch from main
3. Creates worktree at `~/.psm/worktrees/omc/issue-42`
4. Spawns tmux session with issue context
5. Pre-populates Claude Code with issue description

### 2.3 Feature Development

```bash
# Start new feature
/psm feature omc "add-webhook-support"

# Feature from existing branch
/psm feature omc --branch feature/webhooks

# Feature with specific base
/psm feature omc "dark-mode" --base develop
```

**What happens:**
1. Creates feature branch from specified base
2. Creates worktree
3. Spawns session with feature context
4. Optionally creates draft PR

### 2.4 Release Preparation

```bash
# Prepare release
/psm release omc v3.5.0

# Release candidate
/psm release omc v3.5.0-rc1 --draft

# Hotfix release
/psm release omc v3.4.1 --hotfix --base v3.4.0
```

**What happens:**
1. Creates release branch
2. Creates worktree
3. Spawns session with release checklist
4. Pre-loads CHANGELOG context

### 2.5 Session Management

```bash
# List all sessions
/psm list

# List sessions for specific project
/psm list omc

# Attach to existing session
/psm attach omc:pr-123

# Detach current session (return to main)
/psm detach

# Kill specific session
/psm kill omc:pr-123

# Kill all sessions for project
/psm kill omc --all

# Cleanup completed sessions
/psm cleanup

# Cleanup aggressively (force)
/psm cleanup --force --older-than 7d
```

### 2.6 Quick Context Switch

```bash
# Switch to another session (detach current, attach target)
/psm switch omc:feature-auth

# Switch with session picker (fzf)
/psm switch
```

---

## 3. Command Interface

### 3.1 Primary Commands

| Command | Description | Aliases |
|---------|-------------|---------|
| `review <ref>` | Start PR review session | `pr`, `r` |
| `fix <ref>` | Start issue fix session | `issue`, `i` |
| `feature <name>` | Start feature development | `feat`, `f` |
| `release <version>` | Start release preparation | `rel` |
| `list [project]` | List active sessions | `ls`, `l` |
| `attach <session>` | Attach to session | `a` |
| `detach` | Detach from current | `d` |
| `switch [session]` | Switch sessions | `sw`, `s` |
| `kill <session>` | Kill session | `k`, `rm` |
| `cleanup` | Clean up completed | `gc`, `clean` |
| `status` | Show current session info | `st` |

### 3.2 Global Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--project`, `-p` | Project identifier or path | Current directory |
| `--no-claude` | Skip Claude Code launch | false |
| `--no-tmux` | Use current terminal | false |
| `--editor`, `-e` | Open in editor after | false |
| `--verbose`, `-v` | Verbose output | false |
| `--dry-run` | Show what would happen | false |

### 3.3 Project References

PSM supports multiple reference formats:

```bash
# Short alias (requires ~/.psm/projects.json config)
omc#123

# Full GitHub reference
anthropics/claude-code#123

# GitHub URL
https://github.com/anthropics/claude-code/pull/123

# Local path
/path/to/repo#123

# Current directory (implicit)
#123
```

### 3.4 Project Aliases Configuration

```json
// ~/.psm/projects.json
{
  "aliases": {
    "omc": {
      "repo": "anthropics/oh-my-claudecode",
      "local": "~/Workspace/oh-my-claudecode",
      "default_base": "main"
    },
    "cc": {
      "repo": "anthropics/claude-code",
      "local": "~/Workspace/claude-code",
      "default_base": "main"
    },
    "myapp": {
      "repo": "myorg/myapp",
      "local": "~/Projects/myapp",
      "default_base": "develop"
    }
  },
  "defaults": {
    "worktree_root": "~/.psm/worktrees",
    "cleanup_after_days": 14,
    "auto_cleanup_merged": true
  }
}
```

---

## 4. Architecture

### 4.1 Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PSM Skill Entry Point                     │
│                   /oh-my-claudecode:psm                      │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
    │  Command Parser │ │ State Store │ │ Project Resolver│
    │   (argparse)    │ │  (JSON DB)  │ │  (git/gh API)   │
    └─────────────────┘ └─────────────┘ └─────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
    ┌─────────────────────────────────────────────────────────┐
    │                   Session Orchestrator                   │
    └─────────────────────────────────────────────────────────┘
              │               │               │
              ▼               ▼               ▼
    ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
    │ Worktree Manager│ │Tmux Manager │ │ Claude Launcher │
    │   (git cmd)     │ │ (tmux cmd)  │ │  (claude cmd)   │
    └─────────────────┘ └─────────────┘ └─────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
    ┌─────────────────────────────────────────────────────────┐
    │                    Integration Layer                     │
    │  (gh CLI, git, tmux, claude, omc skills, Clawdbot)       │
    └─────────────────────────────────────────────────────────┘
```

### 4.2 Session Lifecycle

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│  CREATING  │ ──▶ │   ACTIVE   │ ──▶ │  DETACHED  │ ──▶ │  ARCHIVED  │
└────────────┘     └────────────┘     └────────────┘     └────────────┘
      │                  │                  │                  │
      │                  │                  │                  │
      ▼                  ▼                  ▼                  ▼
  - Fetch refs      - Claude active    - Session saved    - Worktree kept
  - Create worktree - Tmux attached    - Tmux running     - PR merged
  - Create branch   - Work in progress - Can resume       - Ready for GC
  - Start tmux
  - Launch claude
```

### 4.3 Data Flow

```
User Command
     │
     ▼
┌─────────────────┐
│ Parse Arguments │
└─────────────────┘
     │
     ▼
┌─────────────────┐     ┌─────────────────┐
│ Resolve Project │◀───▶│ projects.json   │
└─────────────────┘     └─────────────────┘
     │
     ▼
┌─────────────────┐     ┌─────────────────┐
│ Fetch Context   │◀───▶│ GitHub API (gh) │
│ (PR/Issue/etc)  │     └─────────────────┘
└─────────────────┘
     │
     ▼
┌─────────────────┐     ┌─────────────────┐
│ Create Worktree │◀───▶│ Git Repository  │
└─────────────────┘     └─────────────────┘
     │
     ▼
┌─────────────────┐     ┌─────────────────┐
│ Create Session  │◀───▶│ sessions.json   │
└─────────────────┘     └─────────────────┘
     │
     ▼
┌─────────────────┐
│ Launch Tmux +   │
│ Claude Code     │
└─────────────────┘
```

---

## 5. Directory Structure

### 5.1 Global PSM Directory

```
~/.psm/
├── config.json              # Global configuration
├── projects.json            # Project aliases
├── sessions.json            # Active session registry
├── templates/               # Session templates
│   ├── pr-review.md         # PR review prompt template
│   ├── issue-fix.md         # Issue fix prompt template
│   ├── feature.md           # Feature dev template
│   └── release.md           # Release prep template
├── logs/                    # Session logs
│   └── psm.log
└── worktrees/               # Default worktree location
    ├── omc/                 # Per-project worktrees
    │   ├── pr-123/
    │   ├── issue-42/
    │   └── feature-auth/
    └── claude-code/
        └── pr-456/
```

### 5.2 Per-Session Directory

```
~/.psm/worktrees/omc/pr-123/
├── .git                     # Git worktree link
├── .psm-session.json        # Session metadata
├── .psm-context.md          # Pre-loaded Claude context
├── <project files>          # Actual code
└── .omc/                    # OMC state (if applicable)
```

### 5.3 Session Metadata File

```json
// .psm-session.json
{
  "id": "omc:pr-123",
  "type": "review",
  "project": "omc",
  "ref": "pr-123",
  "branch": "feature/add-hooks",
  "base": "main",
  "created_at": "2024-01-26T10:30:00Z",
  "last_accessed": "2024-01-26T14:45:00Z",
  "tmux_session": "psm:omc:pr-123",
  "worktree_path": "~/.psm/worktrees/omc/pr-123",
  "source_repo": "~/Workspace/oh-my-claudecode",
  "github": {
    "pr_number": 123,
    "pr_title": "Add webhook support",
    "pr_author": "contributor",
    "pr_url": "https://github.com/anthropics/oh-my-claudecode/pull/123"
  },
  "state": "active",
  "notes": []
}
```

---

## 6. Session Naming Conventions

### 6.1 Tmux Session Names

Format: `psm:<project>:<type>-<identifier>`

| Type | Pattern | Example |
|------|---------|---------|
| PR Review | `psm:<proj>:pr-<num>` | `psm:omc:pr-123` |
| Issue Fix | `psm:<proj>:issue-<num>` | `psm:omc:issue-42` |
| Feature | `psm:<proj>:feat-<name>` | `psm:omc:feat-auth` |
| Release | `psm:<proj>:rel-<ver>` | `psm:omc:rel-v3.5.0` |
| Generic | `psm:<proj>:<name>` | `psm:omc:experiment` |

### 6.2 Worktree Directory Names

Format: `<type>-<identifier>`

| Type | Pattern | Example |
|------|---------|---------|
| PR Review | `pr-<num>` | `pr-123` |
| Issue Fix | `issue-<num>` | `issue-42` |
| Feature | `feat-<name>` | `feat-auth` |
| Release | `rel-<ver>` | `rel-v3.5.0` |

### 6.3 Branch Names

| Type | Pattern | Example |
|------|---------|---------|
| PR Review | (uses PR branch) | `feature/add-hooks` |
| Issue Fix | `fix/<issue>-<slug>` | `fix/42-auth-timeout` |
| Feature | `feature/<name>` | `feature/auth` |
| Release | `release/<ver>` | `release/v3.5.0` |
| Hotfix | `hotfix/<ver>` | `hotfix/v3.4.1` |

---

## 7. Workflow Presets

### 7.1 PR Review Preset

```yaml
name: pr-review
steps:
  - fetch_pr_info
  - create_worktree_from_pr_branch
  - generate_review_context:
      template: pr-review.md
      includes:
        - pr_description
        - changed_files_summary
        - commit_history
        - related_issues
  - spawn_tmux_session
  - launch_claude_with_context:
      initial_prompt: |
        You are reviewing PR #{{pr_number}}: {{pr_title}}

        Focus areas:
        - Code quality and patterns
        - Security implications
        - Test coverage
        - Documentation updates

        Changed files:
        {{changed_files}}
```

### 7.2 Issue Fix Preset

```yaml
name: issue-fix
steps:
  - fetch_issue_info
  - create_branch_from_base
  - create_worktree
  - generate_fix_context:
      template: issue-fix.md
      includes:
        - issue_description
        - issue_labels
        - related_code_search
        - similar_issues
  - spawn_tmux_session
  - launch_claude_with_context:
      initial_prompt: |
        You are fixing issue #{{issue_number}}: {{issue_title}}

        Issue description:
        {{issue_body}}

        Labels: {{labels}}

        Potentially related files:
        {{related_files}}
```

### 7.3 Feature Development Preset

```yaml
name: feature-dev
steps:
  - create_feature_branch
  - create_worktree
  - generate_feature_context:
      template: feature.md
      includes:
        - project_structure
        - related_components
        - coding_standards
  - spawn_tmux_session
  - launch_claude_with_context:
      initial_prompt: |
        You are developing feature: {{feature_name}}

        Project context loaded. Ready to implement.

        Suggested starting point:
        {{suggested_files}}
```

### 7.4 Release Preparation Preset

```yaml
name: release-prep
steps:
  - validate_version_format
  - create_release_branch
  - create_worktree
  - generate_release_context:
      template: release.md
      includes:
        - changelog_since_last_release
        - pending_prs
        - version_files
        - release_checklist
  - spawn_tmux_session
  - launch_claude_with_context:
      initial_prompt: |
        You are preparing release {{version}}

        Changes since last release:
        {{changelog}}

        Release checklist:
        - [ ] Update version in package.json
        - [ ] Update CHANGELOG.md
        - [ ] Run full test suite
        - [ ] Update documentation
        - [ ] Create release notes
```

---

## 8. State Management

### 8.1 Sessions Registry

```json
// ~/.psm/sessions.json
{
  "version": 1,
  "sessions": {
    "omc:pr-123": {
      "id": "omc:pr-123",
      "state": "active",
      "created_at": "2024-01-26T10:30:00Z",
      "last_accessed": "2024-01-26T14:45:00Z",
      "worktree": "~/.psm/worktrees/omc/pr-123",
      "tmux": "psm:omc:pr-123",
      "type": "review",
      "metadata": {
        "pr_number": 123,
        "pr_merged": false
      }
    },
    "omc:issue-42": {
      "id": "omc:issue-42",
      "state": "detached",
      "created_at": "2024-01-25T09:00:00Z",
      "last_accessed": "2024-01-25T18:00:00Z",
      "worktree": "~/.psm/worktrees/omc/issue-42",
      "tmux": "psm:omc:issue-42",
      "type": "fix",
      "metadata": {
        "issue_number": 42,
        "issue_closed": false
      }
    }
  },
  "stats": {
    "total_created": 45,
    "total_cleaned": 32,
    "active_count": 3
  }
}
```

### 8.2 State Transitions

```
┌───────────┐
│  CREATING │ ─── on success ───▶ ACTIVE
└───────────┘
      │
      │ on failure
      ▼
┌───────────┐
│  FAILED   │ ─── cleanup ───▶ (removed)
└───────────┘

┌───────────┐
│  ACTIVE   │ ─── detach ───▶ DETACHED
└───────────┘
      │
      │ kill
      ▼
┌───────────┐
│ ARCHIVED  │ ─── cleanup ───▶ (removed)
└───────────┘

┌───────────┐
│ DETACHED  │ ─── attach ───▶ ACTIVE
└───────────┘
      │
      │ pr_merged / issue_closed / timeout
      ▼
┌───────────┐
│ ARCHIVED  │
└───────────┘
```

### 8.3 Auto-Archive Triggers

Sessions automatically transition to ARCHIVED when:

1. **PR Merged**: GitHub webhook or polling detects merge
2. **Issue Closed**: GitHub webhook or polling detects closure
3. **Inactivity Timeout**: No access for configured days (default: 14)
4. **Manual Archive**: User marks as complete

---

## 9. Cleanup Strategies

### 9.1 Cleanup Levels

| Level | Command | What it Cleans |
|-------|---------|----------------|
| Safe | `/psm cleanup` | Merged PRs, closed issues, archived |
| Moderate | `/psm cleanup --stale` | + Inactive > 14 days |
| Aggressive | `/psm cleanup --force` | + All detached sessions |
| Nuclear | `/psm cleanup --all` | Everything (with confirmation) |

### 9.2 Cleanup Algorithm

```python
def cleanup(options):
    sessions = load_sessions()
    to_remove = []

    for session in sessions:
        should_remove = False

        # Level 1: Safe (always)
        if session.type == "review" and session.pr_merged:
            should_remove = True
        elif session.type == "fix" and session.issue_closed:
            should_remove = True
        elif session.state == "archived":
            should_remove = True

        # Level 2: Stale
        if options.stale:
            days_inactive = now() - session.last_accessed
            if days_inactive > options.older_than:
                should_remove = True

        # Level 3: Force
        if options.force:
            if session.state == "detached":
                should_remove = True

        if should_remove:
            to_remove.append(session)

    # Execute cleanup
    for session in to_remove:
        if not options.dry_run:
            kill_tmux_session(session.tmux)
            remove_worktree(session.worktree)
            remove_session_record(session.id)

        log(f"Cleaned: {session.id}")
```

### 9.3 Cleanup Safeguards

1. **Uncommitted Changes Check**: Warn if worktree has uncommitted changes
2. **Unpushed Commits Check**: Warn if local commits not pushed
3. **Active Session Check**: Never cleanup currently attached session
4. **Confirmation Prompt**: For aggressive/nuclear cleanup
5. **Dry Run**: Always preview what will be cleaned

### 9.4 Scheduled Cleanup

```json
// ~/.psm/config.json
{
  "cleanup": {
    "auto_enabled": true,
    "schedule": "daily",
    "level": "safe",
    "older_than_days": 14,
    "notify_before_cleanup": true
  }
}
```

---

## 10. Integration Points

### 10.1 OMC Skill Integration

| OMC Skill | PSM Integration |
|-----------|-----------------|
| `autopilot` | Can spawn PSM session for isolated work |
| `ultrawork` | Parallel agents across PSM sessions |
| `ralph` | Persistence tracking per PSM session |
| `git-master` | Aware of worktree context |
| `deepsearch` | Scoped to session worktree |

### 10.2 Clawdbot Integration

```typescript
// Clawdbot can manage PSM sessions
interface ClawdbotPSMIntegration {
  // List sessions via Clawdbot UI
  listSessions(): Promise<Session[]>;

  // Create session from Clawdbot
  createSession(options: SessionOptions): Promise<Session>;

  // Attach to session in new terminal
  attachSession(sessionId: string): Promise<void>;

  // Session status in Clawdbot dashboard
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
}
```

### 10.3 GitHub Integration

| Feature | Integration |
|---------|-------------|
| PR Creation | Auto-create draft PR from feature session |
| PR Status | Track merge status for cleanup |
| Issue Linking | Auto-link commits to issue |
| Review Comments | Load review comments as context |
| CI Status | Show CI status in session info |

### 10.4 Editor Integration

```bash
# VSCode
/psm review omc#123 --editor vscode

# Cursor
/psm review omc#123 --editor cursor

# Neovim
/psm review omc#123 --editor nvim
```

Opens editor in worktree directory alongside tmux session.

### 10.5 HUD Integration

PSM status in OMC HUD statusline:

```
[psm:omc:pr-123] 📋 Review | 🕐 2h active | 📁 ~/.psm/worktrees/omc/pr-123
```

---

## 11. Edge Cases & Error Handling

### 11.1 Common Edge Cases

| Scenario | Handling |
|----------|----------|
| Worktree already exists | Offer: attach, recreate, or abort |
| Tmux session name conflict | Append timestamp suffix |
| PR branch force-pushed | Warn and offer to refetch |
| Network offline | Cache what's possible, queue GitHub ops |
| Git dirty state in main repo | Warn but allow (worktree is isolated) |
| Worktree on different filesystem | Use git clone instead |
| Very large repository | Shallow clone option |
| Session metadata corrupted | Rebuild from git/tmux state |

### 11.2 Error Recovery

```bash
# Rebuild sessions.json from existing worktrees and tmux
/psm repair

# Fix orphaned tmux sessions (no worktree)
/psm repair --orphaned-tmux

# Fix orphaned worktrees (no session record)
/psm repair --orphaned-worktrees

# Full reconstruction
/psm repair --full
```

### 11.3 Conflict Resolution

```
User runs: /psm review omc#123

Existing session found!

Options:
  [A] Attach to existing session (recommended)
  [R] Recreate (destroys existing worktree)
  [C] Create parallel (omc:pr-123-2)
  [Q] Quit
```

---

## 12. Security Considerations

### 12.1 Credential Handling

- **GitHub Token**: Uses existing `gh` CLI auth, never stored by PSM
- **SSH Keys**: Relies on system SSH agent
- **Secrets in Worktrees**: Worktrees inherit .gitignore, secrets not duplicated

### 12.2 Path Sanitization

```python
def sanitize_session_name(name: str) -> str:
    # Prevent path traversal
    name = name.replace("..", "")
    name = name.replace("/", "-")
    name = name.replace("\\", "-")
    # Limit length
    name = name[:64]
    # Alphanumeric + dash only
    name = re.sub(r'[^a-zA-Z0-9-]', '', name)
    return name
```

### 12.3 Permissions

- Worktree directories: `0755` (user rwx, others rx)
- Session metadata: `0600` (user only)
- Config files: `0600` (user only)

---

## 13. Future Enhancements

### 13.1 Planned Features

| Feature | Priority | Description |
|---------|----------|-------------|
| Session Templates | High | Custom workflow templates |
| Team Sharing | Medium | Share session configs |
| Session Recording | Medium | Record session for replay |
| Cloud Sync | Low | Sync sessions across machines |
| Auto-PR Creation | Medium | Create PR when session completes |
| Session Metrics | Low | Time tracking per session |

### 13.2 Extension Points

```typescript
// Plugin interface for custom workflows
interface PSMPlugin {
  name: string;

  // Called before session creation
  beforeCreate?(context: SessionContext): Promise<void>;

  // Called after session creation
  afterCreate?(session: Session): Promise<void>;

  // Custom cleanup logic
  shouldCleanup?(session: Session): Promise<boolean>;

  // Custom context generation
  generateContext?(session: Session): Promise<string>;
}
```

### 13.3 Potential Integrations

- **Linear**: Create sessions from Linear issues
- **Jira**: Create sessions from Jira tickets
- **Slack**: Notifications on session events
- **Discord**: Team session coordination

---

## Appendix A: Quick Reference Card

```
┌────────────────────────────────────────────────────────────┐
│            Project Session Manager (PSM)                   │
├────────────────────────────────────────────────────────────┤
│ CREATE SESSIONS                                            │
│   /psm review <pr>      Review a PR                       │
│   /psm fix <issue>      Fix an issue                      │
│   /psm feature <name>   Start feature                     │
│   /psm release <ver>    Prepare release                   │
├────────────────────────────────────────────────────────────┤
│ MANAGE SESSIONS                                            │
│   /psm list             List all sessions                 │
│   /psm attach <id>      Attach to session                 │
│   /psm switch [id]      Switch sessions                   │
│   /psm detach           Detach current                    │
│   /psm status           Current session info              │
├────────────────────────────────────────────────────────────┤
│ CLEANUP                                                    │
│   /psm cleanup          Clean merged/closed               │
│   /psm kill <id>        Kill specific session             │
│   /psm repair           Fix corrupted state               │
├────────────────────────────────────────────────────────────┤
│ REFERENCES                                                 │
│   omc#123               Project alias + number            │
│   org/repo#123          Full GitHub reference             │
│   https://...           GitHub URL                        │
└────────────────────────────────────────────────────────────┘
```

---

## Appendix B: Configuration Reference

```json
// ~/.psm/config.json (complete)
{
  "version": 1,
  "worktree_root": "~/.psm/worktrees",
  "defaults": {
    "editor": "cursor",
    "launch_claude": true,
    "launch_tmux": true,
    "shallow_clone_depth": 100
  },
  "cleanup": {
    "auto_enabled": true,
    "schedule": "daily",
    "level": "safe",
    "older_than_days": 14,
    "notify_before_cleanup": true,
    "keep_archived_days": 7
  },
  "tmux": {
    "session_prefix": "psm",
    "default_layout": "main-vertical",
    "status_bar": true
  },
  "claude": {
    "auto_context": true,
    "context_template": "default",
    "model": "opus"
  },
  "github": {
    "poll_interval_minutes": 5,
    "auto_fetch_pr_reviews": true
  },
  "notifications": {
    "on_pr_merged": true,
    "on_issue_closed": true,
    "on_cleanup": true
  }
}
```

---

## Appendix C: Example Session Transcript

```bash
$ /psm review omc#123

🔍 Fetching PR #123 from oh-my-claudecode...
   Title: "Add webhook support for external integrations"
   Author: @contributor
   Changed: 12 files (+450, -23)

📁 Creating worktree at ~/.psm/worktrees/omc/pr-123...
   Branch: feature/webhook-support
   Base: main

🖥️  Creating tmux session: psm:omc:pr-123...

🤖 Launching Claude Code with PR context...

✅ Session ready!

   Session ID: omc:pr-123
   Worktree:   ~/.psm/worktrees/omc/pr-123
   Tmux:       psm:omc:pr-123

   Commands:
     /psm attach omc:pr-123  - Reattach later
     /psm kill omc:pr-123    - End session
     /psm cleanup            - Clean when PR merged

Attaching to session...
```

---

*Document Version: 1.0.0*
*Last Updated: 2024-01-26*
