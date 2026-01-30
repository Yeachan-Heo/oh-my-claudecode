/**
 * Task Decomposer Types
 *
 * Types for analyzing tasks and decomposing them into parallelizable
 * components with file ownership management.
 */

export type TaskType =
  | 'fullstack-app'
  | 'refactoring'
  | 'bug-fix'
  | 'feature'
  | 'testing'
  | 'documentation'
  | 'infrastructure'
  | 'migration'
  | 'optimization'
  | 'unknown';

export type ComponentRole =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'api'
  | 'ui'
  | 'shared'
  | 'testing'
  | 'docs'
  | 'config'
  | 'module';

export interface TaskAnalysis {
  /** Original task description */
  task: string;

  /** Detected task type */
  type: TaskType;

  /** Task complexity score (0-1) */
  complexity: number;

  /** Whether task can be parallelized */
  isParallelizable: boolean;

  /** Estimated number of components */
  estimatedComponents: number;

  /** Key areas identified in the task */
  areas: string[];

  /** Technologies/frameworks mentioned */
  technologies: string[];

  /** File patterns mentioned or inferred */
  filePatterns: string[];

  /** Dependencies between areas */
  dependencies: Array<{ from: string; to: string }>;
}

export interface Component {
  /** Unique component ID */
  id: string;

  /** Component name */
  name: string;

  /** Component role/type */
  role: ComponentRole;

  /** Description of what this component does */
  description: string;

  /** Whether this component can run in parallel */
  canParallelize: boolean;

  /** Components this depends on (must complete first) */
  dependencies: string[];

  /** Estimated effort/complexity (0-1) */
  effort: number;

  /** Technologies used by this component */
  technologies: string[];
}

export interface FileOwnership {
  /** Component ID that owns these files */
  componentId: string;

  /** Glob patterns for files this component owns exclusively */
  patterns: string[];

  /** Specific files (non-glob) this component owns */
  files: string[];

  /** Files that might overlap with other components */
  potentialConflicts: string[];
}

export interface Subtask {
  /** Unique subtask ID */
  id: string;

  /** Subtask name */
  name: string;

  /** Component this subtask implements */
  component: Component;

  /** Detailed prompt for worker agent */
  prompt: string;

  /** File ownership for this subtask */
  ownership: FileOwnership;

  /** Subtasks that must complete before this one */
  blockedBy: string[];

  /** Recommended agent type */
  agentType: string;

  /** Recommended model tier */
  modelTier: 'low' | 'medium' | 'high';

  /** Acceptance criteria */
  acceptanceCriteria: string[];

  /** Verification steps */
  verification: string[];
}

export interface SharedFile {
  /** File path or glob pattern */
  pattern: string;

  /** Why this file is shared */
  reason: string;

  /** Components that need access to this file */
  sharedBy: string[];

  /** Whether orchestration is required for this file */
  requiresOrchestration: boolean;
}

export interface DecompositionResult {
  /** Original task analysis */
  analysis: TaskAnalysis;

  /** Identified components */
  components: Component[];

  /** Generated subtasks with ownership */
  subtasks: Subtask[];

  /** Shared files requiring orchestration */
  sharedFiles: SharedFile[];

  /** Recommended execution order (by subtask ID) */
  executionOrder: string[][];

  /** Overall strategy description */
  strategy: string;

  /** Warnings or issues detected */
  warnings: string[];
}

export interface ProjectContext {
  /** Project root directory */
  rootDir: string;

  /** Project type (detected) */
  projectType?: string;

  /** Technologies in use */
  technologies?: string[];

  /** Directory structure */
  structure?: Record<string, string[]>;

  /** Existing files that might be affected */
  existingFiles?: string[];

  /** Framework conventions */
  conventions?: Record<string, any>;
}

export interface DecompositionStrategy {
  /** Strategy name */
  name: string;

  /** Task types this strategy applies to */
  applicableTypes: TaskType[];

  /** Function to decompose task */
  decompose: (
    analysis: TaskAnalysis,
    context: ProjectContext
  ) => {
    components: Component[];
    sharedFiles: SharedFile[];
  };
}
