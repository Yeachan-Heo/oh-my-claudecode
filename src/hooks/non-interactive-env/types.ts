export interface NonInteractiveEnvConfig {
  disabled?: boolean
}

/**
 * Shell hook interface for command interception
 */
export interface ShellHook {
  name: string
  beforeCommand?(command: string): Promise<{ command: string; warning?: string }>
}
