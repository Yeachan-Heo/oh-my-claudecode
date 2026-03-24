# Worktree-First Execution Guidance

For optimal reliability in multi-agent teams using Claude Code, always initialize tasks within a git worktree. This prevents context leakage and ensures that each agent has a clean, isolated environment for its specific sub-task.

### Core Principles:
1. **Isolation**: Use `git worktree add` for every parallel agent branch.
2. **Clarity**: Explicitly name worktrees based on the Task ID.
3. **Consistency**: Use the `.agents` definition to sync skills across worktrees.
