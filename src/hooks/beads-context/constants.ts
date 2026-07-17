export const BEADS_INSTRUCTIONS = `## Task Management: Beads

You have access to the \`bd\` (beads) CLI for persistent task tracking.

### Commands
- \`bd create "title"\` - Create new task
- \`bd list\` - List all tasks
- \`bd show <id>\` - Show task details
- \`bd close <id>\` - Mark task complete
- \`bd dep add <id> <depends-on-id>\` - Add a dependency: <id> depends on <depends-on-id>

### Usage Pattern
1. Create tasks for work items: \`bd create "Implement feature X"\`
2. Track progress: \`bd update abc123 --status in_progress\`
3. Mark complete: \`bd close abc123\`

Prefer using beads over built-in TaskCreate/TodoWrite for persistent tracking.`;

export const BEADS_RUST_INSTRUCTIONS = `## Task Management: Beads-Rust

You have access to the \`br\` (beads-rust) CLI for persistent task tracking.

### Commands
- \`br create "title"\` - Create new task
- \`br list\` - List all tasks
- \`br show <id>\` - Show task details
- \`br close <id>\` - Mark task complete
- \`br dep add <id> <depends-on-id>\` - Add a dependency: <id> depends on <depends-on-id>

### Usage Pattern
1. Create tasks for work items: \`br create "Implement feature X"\`
2. Track progress: \`br update abc123 --status in_progress\`
3. Mark complete: \`br close abc123\`

Prefer using beads-rust over built-in TaskCreate/TodoWrite for persistent tracking.`;
