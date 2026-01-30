/**
 * AI-Powered Task Decomposition for Ultrapilot
 *
 * This module provides intelligent task decomposition using an Architect agent
 * to analyze tasks and break them into parallel-safe subtasks with proper
 * file ownership and dependency tracking.
 */

/**
 * Agent type for task execution, determines model complexity
 */
export type AgentType = 'executor-low' | 'executor' | 'executor-high';

/**
 * Model tier for agent execution
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * A decomposed subtask with file ownership and dependencies
 */
export interface DecomposedTask {
  /** Unique identifier for this subtask */
  id: string;
  /** Clear description of what to implement */
  description: string;
  /** Files this task will touch (can include globs) */
  files: string[];
  /** Task IDs this subtask depends on (must complete first) */
  blockedBy: string[];
  /** Agent type based on task complexity */
  agentType: AgentType;
  /** Model tier for execution */
  model: ModelTier;
}

/**
 * Result of task decomposition
 */
export interface DecompositionResult {
  /** Array of parallelizable subtasks */
  subtasks: DecomposedTask[];
  /** Files that need sequential handling (config, lock files) */
  sharedFiles: string[];
  /** Groups of task IDs that can run in parallel (dependency-ordered) */
  parallelGroups: string[][];
}

/**
 * Options for decomposition prompt generation
 */
export interface DecompositionOptions {
  /** Maximum number of subtasks to generate */
  maxSubtasks?: number;
  /** Preferred model tier for workers */
  preferredModel?: ModelTier;
  /** Additional context about project structure */
  projectContext?: string;
}

/**
 * Default shared file patterns that should be handled by the orchestrator
 */
export const DEFAULT_SHARED_FILE_PATTERNS = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.*.json',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  '.eslintrc.*',
  '.prettierrc.*',
  '.gitignore',
  'README.md',
  'Makefile',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Dockerfile',
  'docker-compose.yml',
  '.github/**',
  '.gitlab-ci.yml'
];

/**
 * Generate a prompt for the Architect agent to decompose a task
 *
 * This prompt instructs the Architect to analyze the task and codebase context,
 * then produce a structured JSON decomposition with file ownership and dependencies.
 *
 * @param task - The task description to decompose
 * @param codebaseContext - Context about the codebase structure, files, and patterns
 * @param options - Optional configuration for decomposition
 * @returns Formatted prompt string for the Architect agent
 *
 * @example
 * ```typescript
 * const prompt = generateDecompositionPrompt(
 *   "Build a full-stack todo app with React and Express",
 *   "Project has src/client and src/server directories..."
 * );
 * // Use with Architect agent via Task tool
 * ```
 */
export function generateDecompositionPrompt(
  task: string,
  codebaseContext: string,
  options: DecompositionOptions = {}
): string {
  const { maxSubtasks = 5, preferredModel = 'sonnet', projectContext = '' } = options;

  const additionalContext = projectContext ? `\nPROJECT NOTES:\n${projectContext}\n` : '';

  return `Analyze this task and decompose it into parallel-safe subtasks for concurrent execution.

TASK: ${task}

CODEBASE CONTEXT:
${codebaseContext}
${additionalContext}
OUTPUT REQUIREMENTS:
Return a valid JSON object matching this exact schema:

{
  "subtasks": [
    {
      "id": "1",
      "description": "Clear, actionable description of what to implement",
      "files": ["src/path/to/file.ts", "src/path/to/other.ts"],
      "blockedBy": [],
      "agentType": "executor",
      "model": "sonnet"
    }
  ],
  "sharedFiles": ["package.json", "tsconfig.json"],
  "parallelGroups": [["1", "2"], ["3"]]
}

DECOMPOSITION RULES:

1. FILE OWNERSHIP:
   - Each subtask should have exclusive ownership of its files
   - NO file should appear in multiple subtasks' files arrays
   - Use specific file paths, not directories (unless truly needed)
   - Mark config/lock files as sharedFiles (handled by coordinator)

2. DEPENDENCIES (blockedBy):
   - Only add blockedBy if subtask TRULY requires another to complete first
   - Prefer parallel execution - maximize independent subtasks
   - Common dependencies: type definitions, shared utilities, API contracts

3. PARALLEL GROUPS:
   - Group subtasks that can run simultaneously
   - First group has no dependencies
   - Later groups depend on earlier ones completing
   - Example: [["1", "2", "3"], ["4", "5"]] means 1,2,3 run first, then 4,5

4. AGENT/MODEL SELECTION:
   - executor-low/haiku: Simple changes, single file, straightforward logic
   - executor/sonnet: Standard implementation, moderate complexity (DEFAULT)
   - executor-high/opus: Complex refactoring, architectural changes, multi-file coordination

5. SUBTASK GUIDELINES:
   - Maximum ${maxSubtasks} subtasks
   - Preferred model tier: ${preferredModel}
   - Each subtask should be completable in 2-10 minutes
   - Subtask description should be actionable and specific
   - Include all files the subtask will CREATE or MODIFY

6. SHARED FILES (orchestrator handles):
   - package.json, lock files
   - tsconfig.json, config files
   - Root README.md
   - Docker/CI configuration
   - Any file multiple subtasks would need to modify

EXAMPLE OUTPUT:

{
  "subtasks": [
    {
      "id": "1",
      "description": "Create Express API routes for todo CRUD operations",
      "files": ["src/server/routes/todos.ts", "src/server/controllers/todoController.ts"],
      "blockedBy": [],
      "agentType": "executor",
      "model": "sonnet"
    },
    {
      "id": "2",
      "description": "Create React components for todo list UI",
      "files": ["src/client/components/TodoList.tsx", "src/client/components/TodoItem.tsx"],
      "blockedBy": [],
      "agentType": "executor",
      "model": "sonnet"
    },
    {
      "id": "3",
      "description": "Create database schema and migrations for todos",
      "files": ["src/db/migrations/001_create_todos.ts", "src/db/models/Todo.ts"],
      "blockedBy": [],
      "agentType": "executor-low",
      "model": "haiku"
    },
    {
      "id": "4",
      "description": "Wire up API client in frontend to connect to backend",
      "files": ["src/client/api/todoApi.ts", "src/client/hooks/useTodos.ts"],
      "blockedBy": ["1", "2"],
      "agentType": "executor",
      "model": "sonnet"
    }
  ],
  "sharedFiles": ["package.json", "tsconfig.json", "src/types/todo.ts"],
  "parallelGroups": [["1", "2", "3"], ["4"]]
}

Return ONLY the JSON object, no markdown code fences or additional text.`;
}

/**
 * Parse the Architect's response into a structured DecompositionResult
 *
 * Handles various response formats including:
 * - Raw JSON
 * - JSON wrapped in markdown code fences
 * - JSON with surrounding explanation text
 *
 * @param response - Raw response string from the Architect agent
 * @returns Parsed and validated DecompositionResult
 * @throws Error if response cannot be parsed or is invalid
 *
 * @example
 * ```typescript
 * const result = parseDecompositionResult(architectResponse);
 * console.log(result.subtasks.length); // Number of parallel tasks
 * console.log(result.parallelGroups); // Execution order
 * ```
 */
export function parseDecompositionResult(response: string): DecompositionResult {
  // Try to extract JSON from response (may be wrapped in markdown or have surrounding text)
  let jsonStr: string;

  // First, try to find JSON in markdown code fences
  const fencedMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch && fencedMatch[1]) {
    jsonStr = fencedMatch[1].trim();
  } else {
    // Try to find raw JSON object
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        'Could not parse decomposition result: no JSON object found in response'
      );
    }
    jsonStr = jsonMatch[0];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Could not parse decomposition result: invalid JSON - ${e instanceof Error ? e.message : 'unknown error'}`
    );
  }

  // Validate structure
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not parse decomposition result: response is not an object');
  }

  const result = parsed as Record<string, unknown>;

  // Validate required fields
  if (!Array.isArray(result.subtasks)) {
    throw new Error('Could not parse decomposition result: missing or invalid subtasks array');
  }

  // Validate each subtask
  for (const subtask of result.subtasks) {
    if (!subtask || typeof subtask !== 'object') {
      throw new Error('Could not parse decomposition result: invalid subtask object');
    }
    const st = subtask as Record<string, unknown>;
    if (typeof st.id !== 'string' || !st.id) {
      throw new Error('Could not parse decomposition result: subtask missing id');
    }
    if (typeof st.description !== 'string' || !st.description) {
      throw new Error('Could not parse decomposition result: subtask missing description');
    }
    if (!Array.isArray(st.files)) {
      throw new Error(`Could not parse decomposition result: subtask ${st.id} missing files array`);
    }
    if (!Array.isArray(st.blockedBy)) {
      // Default to empty array if not provided
      st.blockedBy = [];
    }
    // Validate and default agentType
    const validAgentTypes = ['executor-low', 'executor', 'executor-high'];
    if (!st.agentType || !validAgentTypes.includes(st.agentType as string)) {
      st.agentType = 'executor';
    }
    // Validate and default model
    const validModels = ['haiku', 'sonnet', 'opus'];
    if (!st.model || !validModels.includes(st.model as string)) {
      st.model = 'sonnet';
    }
  }

  // Validate/default sharedFiles
  if (!Array.isArray(result.sharedFiles)) {
    result.sharedFiles = [];
  }

  // Validate/default parallelGroups
  if (!Array.isArray(result.parallelGroups)) {
    // Generate default parallel groups based on blockedBy
    result.parallelGroups = generateParallelGroups(result.subtasks as DecomposedTask[]);
  }

  return result as unknown as DecompositionResult;
}

/**
 * Generate parallel groups from subtask dependencies
 *
 * Creates an ordered array of task ID groups where each group can run
 * in parallel, and later groups depend on earlier ones completing.
 *
 * @param subtasks - Array of decomposed subtasks with blockedBy fields
 * @returns Array of parallel groups (each group is array of task IDs)
 */
export function generateParallelGroups(subtasks: DecomposedTask[]): string[][] {
  const groups: string[][] = [];
  const completed = new Set<string>();
  const remaining = new Set(subtasks.map((t) => t.id));

  while (remaining.size > 0) {
    const currentGroup: string[] = [];

    for (const subtask of subtasks) {
      if (!remaining.has(subtask.id)) continue;

      // Check if all dependencies are completed
      const depsCompleted = subtask.blockedBy.every((dep) => completed.has(dep));
      if (depsCompleted) {
        currentGroup.push(subtask.id);
      }
    }

    if (currentGroup.length === 0) {
      // Circular dependency detected - add remaining tasks to break cycle
      const remainingIds = Array.from(remaining);
      groups.push(remainingIds);
      break;
    }

    // Mark current group as completed
    for (const id of currentGroup) {
      completed.add(id);
      remaining.delete(id);
    }

    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Validate that file ownership doesn't overlap between subtasks
 *
 * @param subtasks - Array of decomposed subtasks
 * @returns Object with isValid flag and any conflicts found
 */
export function validateFileOwnership(subtasks: DecomposedTask[]): {
  isValid: boolean;
  conflicts: Array<{ file: string; owners: string[] }>;
} {
  const fileToOwners = new Map<string, string[]>();

  for (const subtask of subtasks) {
    for (const file of subtask.files) {
      if (!fileToOwners.has(file)) {
        fileToOwners.set(file, []);
      }
      fileToOwners.get(file)!.push(subtask.id);
    }
  }

  const conflicts: Array<{ file: string; owners: string[] }> = [];
  for (const [file, owners] of fileToOwners.entries()) {
    if (owners.length > 1) {
      conflicts.push({ file, owners });
    }
  }

  return {
    isValid: conflicts.length === 0,
    conflicts
  };
}

/**
 * Merge shared files from subtasks into the sharedFiles list
 *
 * Identifies files that match shared file patterns and removes them
 * from subtask ownership, adding them to sharedFiles instead.
 *
 * @param result - DecompositionResult to process
 * @param patterns - Array of glob patterns for shared files
 * @returns Updated DecompositionResult with shared files extracted
 */
export function extractSharedFiles(
  result: DecompositionResult,
  patterns: string[] = DEFAULT_SHARED_FILE_PATTERNS
): DecompositionResult {
  const sharedSet = new Set(result.sharedFiles);

  // Simple pattern matching (exact match or basic glob)
  const isSharedFile = (file: string): boolean => {
    const fileName = file.split('/').pop() || file;
    return patterns.some((pattern) => {
      if (pattern.includes('*')) {
        // Basic glob: convert to regex
        const regex = new RegExp(
          '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
        );
        return regex.test(file) || regex.test(fileName);
      }
      return file === pattern || fileName === pattern;
    });
  };

  // Process each subtask
  const updatedSubtasks = result.subtasks.map((subtask) => {
    const ownedFiles: string[] = [];
    for (const file of subtask.files) {
      if (isSharedFile(file)) {
        sharedSet.add(file);
      } else {
        ownedFiles.push(file);
      }
    }
    return { ...subtask, files: ownedFiles };
  });

  return {
    subtasks: updatedSubtasks,
    sharedFiles: Array.from(sharedSet),
    parallelGroups: result.parallelGroups
  };
}

/**
 * Convert DecompositionResult to simple string array for legacy compatibility
 *
 * @param result - Full decomposition result
 * @returns Array of task description strings
 */
export function toSimpleSubtasks(result: DecompositionResult): string[] {
  return result.subtasks.map((t) => t.description);
}
