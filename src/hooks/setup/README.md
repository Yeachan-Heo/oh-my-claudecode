# Setup Hook

Handles OMC initialization and maintenance tasks.

## Triggers

### `init`
Initializes OMC directory structure and environment on first run or explicit setup.

**What it does:**
- Creates required directories: `.omc/state/`, `.omc/logs/`, `.omc/notepads/`, `.omc/state/checkpoints/`, `.omc/plans/`
- Validates existing config files (`.omc-config.json`)
- Sets environment variables (`OMC_INITIALIZED=true`) if `CLAUDE_ENV_FILE` is available

**Example Input:**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.md",
  "cwd": "/path/to/project",
  "permission_mode": "normal",
  "hook_event_name": "Setup",
  "trigger": "init"
}
```

**Example Output:**
```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "Setup",
    "additionalContext": "OMC initialized:\n- 5 directories created\n- 1 configs validated\n- Environment variables set: OMC_INITIALIZED"
  }
}
```

### `maintenance`
Performs periodic maintenance tasks to keep OMC state clean.

**What it does:**
- Prunes old state files (default: 7 days old)
- Cleans up orphaned session state files (>24 hours old)
- Runs VACUUM on swarm SQLite database (if exists and sqlite3 available)

**Protected Files (Never Pruned):**
- `autopilot-state.json`
- `ultrapilot-state.json`
- `ralph-state.json`
- `ultrawork-state.json`
- `swarm-state.json`

**Example Input:**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.md",
  "cwd": "/path/to/project",
  "permission_mode": "normal",
  "hook_event_name": "Setup",
  "trigger": "maintenance"
}
```

**Example Output:**
```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "Setup",
    "additionalContext": "OMC maintenance completed:\n- 3 old state files pruned\n- 1 orphaned state files cleaned\n- Swarm database vacuumed"
  }
}
```

## API

### Directory Management

#### `ensureDirectoryStructure(directory: string): string[]`
Creates all required OMC directories.

**Returns:** Array of created directory paths.

```typescript
const created = ensureDirectoryStructure('/path/to/project');
// => ['/path/to/project/.omc/state', '/path/to/project/.omc/logs', ...]
```

#### `validateConfigFiles(directory: string): string[]`
Validates that config files exist and are readable.

**Returns:** Array of validated config file paths.

```typescript
const validated = validateConfigFiles('/path/to/project');
// => ['/path/to/project/.omc-config.json']
```

### Environment Variables

#### `setEnvironmentVariables(): string[]`
Sets environment variables for OMC initialization.

**Returns:** Array of environment variable names set.

**Note:** Only works if `process.env.CLAUDE_ENV_FILE` is set.

```typescript
const envVars = setEnvironmentVariables();
// => ['OMC_INITIALIZED']
```

### Maintenance

#### `pruneOldStateFiles(directory: string, maxAgeDays?: number): number`
Deletes state files older than specified days (default: 7).

**Returns:** Number of files deleted.

**Protected files are never deleted.**

```typescript
const pruned = pruneOldStateFiles('/path/to/project', 7);
// => 3
```

#### `cleanupOrphanedState(directory: string): number`
Removes orphaned session-specific state files (>24 hours old).

**Returns:** Number of files cleaned.

```typescript
const cleaned = cleanupOrphanedState('/path/to/project');
// => 1
```

### Main Entry Points

#### `processSetupInit(input: SetupInput): Promise<HookOutput>`
Processes setup initialization.

```typescript
const result = await processSetupInit({
  session_id: 'abc123',
  transcript_path: '/tmp/transcript.md',
  cwd: '/path/to/project',
  permission_mode: 'normal',
  hook_event_name: 'Setup',
  trigger: 'init'
});
```

#### `processSetupMaintenance(input: SetupInput): Promise<HookOutput>`
Processes setup maintenance.

```typescript
const result = await processSetupMaintenance({
  session_id: 'abc123',
  transcript_path: '/tmp/transcript.md',
  cwd: '/path/to/project',
  permission_mode: 'normal',
  hook_event_name: 'Setup',
  trigger: 'maintenance'
});
```

#### `processSetup(input: SetupInput): Promise<HookOutput>`
Generic entry point that routes to init or maintenance based on trigger.

```typescript
const result = await processSetup({
  session_id: 'abc123',
  transcript_path: '/tmp/transcript.md',
  cwd: '/path/to/project',
  permission_mode: 'normal',
  hook_event_name: 'Setup',
  trigger: 'init' // or 'maintenance'
});
```

## Types

```typescript
interface SetupInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'Setup';
  trigger: 'init' | 'maintenance';
}

interface SetupResult {
  directories_created: string[];
  configs_validated: string[];
  errors: string[];
  env_vars_set: string[];
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: 'Setup';
    additionalContext: string;
  };
}
```

## Usage

### From TypeScript/JavaScript

```typescript
import { processSetup } from './hooks/setup';

// Initialize OMC
const initResult = await processSetup({
  session_id: 'session-123',
  transcript_path: '/tmp/transcript.md',
  cwd: process.cwd(),
  permission_mode: 'normal',
  hook_event_name: 'Setup',
  trigger: 'init'
});

console.log(initResult.hookSpecificOutput.additionalContext);

// Run maintenance
const maintenanceResult = await processSetup({
  session_id: 'session-123',
  transcript_path: '/tmp/transcript.md',
  cwd: process.cwd(),
  permission_mode: 'normal',
  hook_event_name: 'Setup',
  trigger: 'maintenance'
});

console.log(maintenanceResult.hookSpecificOutput.additionalContext);
```

### From Shell

```bash
#!/bin/bash

# Initialize OMC
INPUT=$(cat <<EOF
{
  "session_id": "session-123",
  "transcript_path": "/tmp/transcript.md",
  "cwd": "$(pwd)",
  "permission_mode": "normal",
  "hook_event_name": "Setup",
  "trigger": "init"
}
EOF
)

echo "$INPUT" | node dist/hooks/setup/index.js

# Run maintenance
INPUT=$(cat <<EOF
{
  "session_id": "session-123",
  "transcript_path": "/tmp/transcript.md",
  "cwd": "$(pwd)",
  "permission_mode": "normal",
  "hook_event_name": "Setup",
  "trigger": "maintenance"
}
EOF
)

echo "$INPUT" | node dist/hooks/setup/index.js
```

## Constants

- `REQUIRED_DIRECTORIES`: Array of directories to create during init
- `CONFIG_FILES`: Array of config files to validate
- `DEFAULT_STATE_MAX_AGE_DAYS`: Default max age for state files (7 days)

## Error Handling

All errors are caught and added to the `errors` array in `SetupResult`. The hook always returns `continue: true` to avoid blocking execution.

## Dependencies

- `fs`: File system operations
- `path`: Path manipulation
- `child_process`: For running `sqlite3` VACUUM command

## Notes

- Directory creation is idempotent (won't fail if directories already exist)
- Protected state files are never pruned, even if old
- Environment variable setting requires `CLAUDE_ENV_FILE` to be set
- SQLite VACUUM requires `sqlite3` command to be available
- All operations are safe and won't delete active/critical state
