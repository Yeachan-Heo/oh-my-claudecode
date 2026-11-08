/**
 * Setup Hook Types
 */

export interface SetupInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'Setup';
  trigger: 'init' | 'maintenance';
}

export interface SetupResult {
  directories_created: string[];
  configs_validated: string[];
  errors: string[];
  env_vars_set: string[];
}

export interface HookOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: 'Setup';
    additionalContext: string;
  };
}
