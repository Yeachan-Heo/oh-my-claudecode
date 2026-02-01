export type TaskTool = 'builtin' | 'beads' | 'beads-rust';

export interface BeadsContextConfig {
  taskTool: TaskTool;
  injectInstructions: boolean;
  useMcp: boolean;
}
