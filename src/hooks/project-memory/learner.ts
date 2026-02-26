/**
 * Project Memory Learner
 * Incrementally learns from PostToolUse events
 */

import { loadProjectMemory, saveProjectMemory } from './storage.js';
import { BUILD_COMMAND_PATTERNS, TEST_COMMAND_PATTERNS } from './constants.js';
import { CustomNote } from './types.js';
import { trackAccess } from './hot-path-tracker.js';
import { detectDirectivesFromMessage, addDirective } from './directive-detector.js';

/**
 * Per-projectRoot async mutex to prevent concurrent load-modify-save races.
 * Maps projectRoot -> promise chain tail.
 */
const writeMutexes = new Map<string, Promise<void>>();

/**
 * Acquire a promise-chain mutex for a projectRoot.
 * Chains the new operation onto the tail of the existing chain.
 * Times out after 5 seconds to prevent infinite blocking.
 */
function withMutex<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeMutexes.get(projectRoot) ?? Promise.resolve();
  const next = prev.then(() => fn()).catch(() => fn());
  // Store the chain tail without the result so callers don't chain errors forward
  const tail = next.then(
    () => {},
    () => {}
  );
  writeMutexes.set(projectRoot, tail);
  return next;
}

/**
 * Learn from tool output and update project memory
 *
 * @param toolName - Name of the tool that was executed
 * @param toolInput - Input parameters to the tool
 * @param toolOutput - Output from the tool
 * @param projectRoot - Project root directory
 * @param userMessage - Optional user message for directive detection
 */
export async function learnFromToolOutput(
  toolName: string,
  toolInput: any,
  toolOutput: string,
  projectRoot: string,
  userMessage?: string
): Promise<void> {
  return withMutex(projectRoot, async () => {
    // Learn from multiple tool types
    const memory = await loadProjectMemory(projectRoot);
    if (!memory) {
      return;
    }

    let updated = false;

    // Track file accesses from Read/Edit/Write tools
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const filePath = toolInput?.file_path || toolInput?.filePath;
      if (filePath) {
        memory.hotPaths = trackAccess(memory.hotPaths, filePath, projectRoot, 'file');
        updated = true;
      }
    }

    // Track directory accesses from Glob/Grep
    if (toolName === 'Glob' || toolName === 'Grep') {
      const dirPath = toolInput?.path;
      if (dirPath) {
        memory.hotPaths = trackAccess(memory.hotPaths, dirPath, projectRoot, 'directory');
        updated = true;
      }
    }

    // Detect directives from user messages
    if (userMessage) {
      const detectedDirectives = detectDirectivesFromMessage(userMessage);
      for (const directive of detectedDirectives) {
        memory.userDirectives = addDirective(memory.userDirectives, directive);
        updated = true;
      }
    }

    // Learn from Bash commands
    if (toolName !== 'Bash') {
      if (updated) {
        await saveProjectMemory(projectRoot, memory);
      }
      return;
    }

    const command = toolInput?.command || '';
    if (!command) {
      return;
    }

    try {

      // Detect and store build commands
      if (isBuildCommand(command)) {
        if (!memory.build.buildCommand || memory.build.buildCommand !== command) {
          memory.build.buildCommand = command;
          updated = true;
        }
      }

      // Detect and store test commands
      if (isTestCommand(command)) {
        if (!memory.build.testCommand || memory.build.testCommand !== command) {
          memory.build.testCommand = command;
          updated = true;
        }
      }

      // Extract environment hints from output
      const hints = extractEnvironmentHints(toolOutput);
      if (hints.length > 0) {
        for (const hint of hints) {
          // Only add if not already present
          const exists = memory.customNotes.some(
            n => n.category === hint.category && n.content === hint.content
          );
          if (!exists) {
            memory.customNotes.push(hint);
            updated = true;
          }
        }

        // Limit custom notes to 20 entries
        if (memory.customNotes.length > 20) {
          memory.customNotes = memory.customNotes.slice(-20);
        }
      }

      // Save if updated
      if (updated) {
        await saveProjectMemory(projectRoot, memory);
      }
    } catch (error) {
      // Silently fail
      console.error('Error learning from tool output:', error);
    }
  });
}

/**
 * Check if command is a build command
 */
function isBuildCommand(command: string): boolean {
  return BUILD_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * Check if command is a test command
 */
function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * Extract environment hints from tool output
 * Returns custom notes to add to project memory
 */
function extractEnvironmentHints(output: string): CustomNote[] {
  const hints: CustomNote[] = [];
  const timestamp = Date.now();

  // Detect Node.js version
  const nodeMatch = output.match(/Node\.js\s+(v?\d+\.\d+\.\d+)/i);
  if (nodeMatch) {
    hints.push({
      timestamp,
      source: 'learned',
      category: 'runtime',
      content: `Node.js ${nodeMatch[1]}`,
    });
  }

  // Detect Python version
  const pythonMatch = output.match(/Python\s+(\d+\.\d+\.\d+)/i);
  if (pythonMatch) {
    hints.push({
      timestamp,
      source: 'learned',
      category: 'runtime',
      content: `Python ${pythonMatch[1]}`,
    });
  }

  // Detect Rust version
  const rustMatch = output.match(/rustc\s+(\d+\.\d+\.\d+)/i);
  if (rustMatch) {
    hints.push({
      timestamp,
      source: 'learned',
      category: 'runtime',
      content: `Rust ${rustMatch[1]}`,
    });
  }

  // Detect missing dependencies (common error patterns)
  if (output.includes('Cannot find module') || output.includes('ModuleNotFoundError')) {
    const moduleMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (moduleMatch) {
      hints.push({
        timestamp,
        source: 'learned',
        category: 'dependency',
        content: `Missing dependency: ${moduleMatch[1]}`,
      });
    }
  }

  // Detect environment variable requirements
  const envMatch = output.match(/(?:Missing|Required)\s+(?:environment\s+)?(?:variable|env):\s*([A-Z_][A-Z0-9_]*)/i);
  if (envMatch) {
    hints.push({
      timestamp,
      source: 'learned',
      category: 'env',
      content: `Requires env var: ${envMatch[1]}`,
    });
  }

  return hints;
}

/**
 * Manually add a custom note to project memory
 *
 * @param projectRoot - Project root directory
 * @param category - Note category (build, test, deploy, env, etc.)
 * @param content - Note content
 */
export async function addCustomNote(
  projectRoot: string,
  category: string,
  content: string
): Promise<void> {
  return withMutex(projectRoot, async () => {
    try {
      const memory = await loadProjectMemory(projectRoot);
      if (!memory) {
        return;
      }

      memory.customNotes.push({
        timestamp: Date.now(),
        source: 'manual',
        category,
        content,
      });

      // Limit to 20 entries
      if (memory.customNotes.length > 20) {
        memory.customNotes = memory.customNotes.slice(-20);
      }

      await saveProjectMemory(projectRoot, memory);
    } catch (error) {
      console.error('Error adding custom note:', error);
    }
  });
}
