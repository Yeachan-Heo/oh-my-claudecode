import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';

/**
 * Check if the encoded path looks like a Windows path (starts with drive letter)
 * Examples: "C--Users-user-project" or "D--work-project"
 */
function isWindowsEncodedPath(dirName: string): boolean {
  return /^[A-Za-z]-/.test(dirName);
}

/**
 * Metadata for a discovered transcript file
 */
export interface TranscriptFile {
  projectPath: string;        // Decoded original path (e.g., /home/bellman/Workspace/foo)
  projectDir: string;         // Encoded directory name (e.g., -home-bellman-Workspace-foo)
  sessionId: string;          // UUID from filename
  filePath: string;           // Full path to .jsonl
  fileSize: number;           // Bytes
  modifiedTime: Date;
}

/**
 * Result of scanning for transcripts
 */
export interface ScanResult {
  transcripts: TranscriptFile[];
  totalSize: number;
  projectCount: number;
}

/**
 * Options for scanning transcripts
 */
export interface ScanOptions {
  projectFilter?: string;     // Glob pattern for project path
  minDate?: Date;             // Only files modified after this date
}

/**
 * UUID regex pattern for session IDs
 */
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * Decode project directory name back to original path.
 *
 * The encoding scheme used by Claude Code is lossy - it converts all path
 * separators (/ or \) to dashes (-), but legitimate dashes in directory names
 * also become dashes, making them indistinguishable.
 *
 * Encoding patterns:
 *   - Unix: "/home/user/project" → "-home-user-project"
 *   - Windows: "C:\Users\user\project" → "C--Users-user-project"
 *
 * Strategy:
 * 1. Detect if it's a Windows or Unix encoded path
 * 2. Try simple decode (all dashes -> slashes) and check if path exists
 * 3. If not, try to reconstruct by checking filesystem for partial matches
 * 4. Fall back to simple decode if nothing else works
 *
 * @internal Exported for testing
 */
export function decodeProjectPath(dirName: string): string {
  // Handle Windows encoded paths (e.g., "C--Users-user-project")
  if (isWindowsEncodedPath(dirName)) {
    return decodeWindowsPath(dirName);
  }

  // Handle Unix encoded paths (e.g., "-home-user-project")
  if (dirName.startsWith('-')) {
    return decodeUnixPath(dirName);
  }

  // Not an encoded path, return as-is
  return dirName;
}

/**
 * Split path string preserving consecutive hyphens as single segments.
 * e.g., "a--b-c" → ["a", "-", "b", "c"] (the "-" represents a hyphen in original name)
 */
function splitPreservingConsecutiveHyphens(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] === '-') {
      if (current) {
        result.push(current);
        current = '';
      }
      // Check for consecutive hyphens
      if (i + 1 < str.length && str[i + 1] === '-') {
        // Consecutive hyphens - this means the original had a hyphen
        // Push empty string as marker, will be joined with hyphen later
        result.push('');
        i++; // Skip the second hyphen
      }
      i++;
    } else {
      current += str[i];
      i++;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

/**
 * Decode Windows encoded path (e.g., "C--Users-user-project" → "C:/Users/user/project")
 */
function decodeWindowsPath(dirName: string): string {
  const driveLetter = dirName[0];
  const rest = dirName.slice(2); // Skip "X-"

  // Simple decode: drive letter + colon + rest with dashes as slashes
  const simplePath = `${driveLetter}:/${rest.replace(/-/g, '/')}`;

  // Normalize double slashes that might occur from empty segments
  const normalizedSimple = simplePath.replace(/\/+/g, '/');

  // If simple decode exists, we're done
  if (existsSync(normalizedSimple)) {
    return normalizedSimple;
  }

  // Try to reconstruct by checking filesystem for partial matches
  // Use special splitting to handle consecutive hyphens
  const segments = splitPreservingConsecutiveHyphens(rest);
  if (segments.length === 0) {
    return `${driveLetter}:/`;
  }

  const possiblePaths: string[] = [];

  // Generate all possible interpretations by trying different hyphen positions
  function generatePaths(parts: string[], index: number, currentPath: string): void {
    if (index >= parts.length) {
      possiblePaths.push(currentPath);
      return;
    }

    const part = parts[index];

    // Empty string means this was a consecutive hyphen - must join with previous
    if (part === '' && currentPath) {
      const pathParts = currentPath.split('/');
      const lastPart = pathParts.pop() || '';
      const newPath = pathParts.join('/') + '/' + lastPart + '-';
      generatePaths(parts, index + 1, newPath);
      return;
    }

    // Try adding next segment as a new directory
    const newDir = currentPath + '/' + part;
    generatePaths(parts, index + 1, newDir);

    // Try combining with previous segment using hyphen (if not first segment)
    if (index > 0 && currentPath) {
      const pathParts = currentPath.split('/');
      const lastPart = pathParts.pop() || '';
      const newPath = pathParts.join('/') + '/' + lastPart + '-' + part;
      generatePaths(parts, index + 1, newPath);
    }
  }

  generatePaths(segments, 0, `${driveLetter}:`);

  // Find the first path that exists on filesystem
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fall back to simple decode
  return normalizedSimple;
}

/**
 * Decode Unix encoded path (e.g., "-home-user-project" → "/home/user/project")
 */
function decodeUnixPath(dirName: string): string {
  // Simple decode: replace all dashes with slashes
  const simplePath = '/' + dirName.slice(1).replace(/-/g, '/');

  // Normalize double slashes
  const normalizedSimple = simplePath.replace(/\/+/g, '/');

  // If simple decode exists, we're done
  if (existsSync(normalizedSimple)) {
    return normalizedSimple;
  }

  // Try to reconstruct by checking filesystem for partial matches
  // Use special splitting to handle consecutive hyphens
  const segments = splitPreservingConsecutiveHyphens(dirName.slice(1));
  const possiblePaths: string[] = [];

  // Generate all possible interpretations by trying different hyphen positions
  function generatePaths(parts: string[], index: number, currentPath: string): void {
    if (index >= parts.length) {
      possiblePaths.push(currentPath);
      return;
    }

    const part = parts[index];

    // Empty string means this was a consecutive hyphen - must join with previous
    if (part === '' && currentPath) {
      const pathParts = currentPath.split('/');
      const lastPart = pathParts.pop() || '';
      const newPath = pathParts.join('/') + '/' + lastPart + '-';
      generatePaths(parts, index + 1, newPath);
      return;
    }

    // Try adding next segment as a new directory
    generatePaths(parts, index + 1, currentPath + '/' + part);

    // Try combining with previous segment using hyphen (if not first segment)
    if (index > 0 && currentPath) {
      const pathParts = currentPath.split('/');
      const lastPart = pathParts.pop() || '';
      const newPath = pathParts.join('/') + '/' + lastPart + '-' + part;
      generatePaths(parts, index + 1, newPath);
    }
  }

  generatePaths(segments, 0, '');

  // Find the first path that exists on filesystem
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fall back to simple decode
  return normalizedSimple;
}

/**
 * Check if a path matches a glob pattern (simple implementation)
 */
function matchesPattern(path: string, pattern?: string): boolean {
  if (!pattern) return true;

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

/**
 * Scan for all transcript files in ~/.claude/projects/
 */
export async function scanTranscripts(options: ScanOptions = {}): Promise<ScanResult> {
  const projectsDir = join(getClaudeConfigDir(), 'projects');
  const transcripts: TranscriptFile[] = [];
  const projectDirs = new Set<string>();

  try {
    // Read all project directories
    const entries = await readdir(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = entry.name;
      const projectPath = decodeProjectPath(projectDir);

      // Apply project filter if specified
      if (!matchesPattern(projectPath, options.projectFilter)) {
        continue;
      }

      const fullProjectPath = join(projectsDir, projectDir);

      // Read all files in this project directory
      const projectFiles = await readdir(fullProjectPath);

      for (const fileName of projectFiles) {
        // Skip sessions-index.json and any non-.jsonl files
        if (fileName === 'sessions-index.json' || !fileName.endsWith('.jsonl')) {
          continue;
        }

        // Extract session ID from filename
        const sessionId = fileName.replace('.jsonl', '');

        // Validate session ID format (must be UUID)
        if (!UUID_REGEX.test(sessionId)) {
          continue;
        }

        const filePath = join(fullProjectPath, fileName);
        const fileStats = await stat(filePath);

        // Apply date filter if specified
        if (options.minDate && fileStats.mtime < options.minDate) {
          continue;
        }

        transcripts.push({
          projectPath,
          projectDir,
          sessionId,
          filePath,
          fileSize: fileStats.size,
          modifiedTime: fileStats.mtime
        });

        projectDirs.add(projectDir);
      }
    }
  } catch (error) {
    // If projects directory doesn't exist, return empty result
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        transcripts: [],
        totalSize: 0,
        projectCount: 0
      };
    }
    throw error;
  }

  const totalSize = transcripts.reduce((sum, t) => sum + t.fileSize, 0);

  return {
    transcripts,
    totalSize,
    projectCount: projectDirs.size
  };
}
