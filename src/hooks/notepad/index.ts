/**
 * Notepad Support
 *
 * Implements compaction-resilient memory persistence using notepad.md format.
 * Provides a three-tier memory system:
 * 1. Priority Context - Always loaded, critical discoveries (max 500 chars)
 * 2. Working Memory - Session notes, auto-pruned after 7 days
 * 3. MANUAL - User content, never auto-pruned
 *
 * Structure:
 * ```markdown
 * # Notepad
 * <!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->
 *
 * ## Priority Context
 * <!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->
 *
 * ## Working Memory
 * <!-- Session notes. Auto-pruned after 7 days. -->
 *
 * ## MANUAL
 * <!-- User content. Never auto-pruned. -->
 * ```
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";

// ============================================================================
// Types
// ============================================================================

export interface NotepadConfig {
  /** Maximum characters for Priority Context section */
  priorityMaxChars: number;
  /** Days to keep Working Memory entries before pruning */
  workingMemoryDays: number;
  /** Maximum total file size in bytes */
  maxTotalSize: number;
}

export interface NotepadStats {
  /** Whether notepad.md exists */
  exists: boolean;
  /** Total file size in bytes */
  totalSize: number;
  /** Priority Context section size in bytes */
  prioritySize: number;
  /** Number of Working Memory entries */
  workingMemoryEntries: number;
  /** ISO timestamp of oldest Working Memory entry */
  oldestEntry: string | null;
}

export interface PriorityContextResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Warning message if content exceeds limit */
  warning?: string;
}

export interface PruneResult {
  /** Number of entries pruned */
  pruned: number;
  /** Number of entries remaining */
  remaining: number;
}

// ============================================================================
// Constants
// ============================================================================

export const NOTEPAD_FILENAME = "notepad.md";

export const DEFAULT_CONFIG: NotepadConfig = {
  priorityMaxChars: 500,
  workingMemoryDays: 7,
  maxTotalSize: 8192, // 8KB
};

export const PRIORITY_HEADER = "## Priority Context";
export const WORKING_MEMORY_HEADER = "## Working Memory";
export const MANUAL_HEADER = "## MANUAL";

// ============================================================================
// File Operations
// ============================================================================

/**
 * Get the path to notepad.md in .omc subdirectory
 */
export function getNotepadPath(directory: string): string {
  return join(directory, ".omc", NOTEPAD_FILENAME);
}

/**
 * Initialize notepad.md if it doesn't exist
 */
export function initNotepad(directory: string): boolean {
  const omcDir = join(directory, ".omc");
  if (!existsSync(omcDir)) {
    try {
      mkdirSync(omcDir, { recursive: true });
    } catch {
      return false;
    }
  }

  const notepadPath = getNotepadPath(directory);
  if (existsSync(notepadPath)) {
    return true; // Already exists
  }

  const content = `# Notepad
<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->

${PRIORITY_HEADER}
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

${WORKING_MEMORY_HEADER}
<!-- Session notes. Auto-pruned after 7 days. -->

${MANUAL_HEADER}
<!-- User content. Never auto-pruned. -->

`;

  try {
    atomicWriteFileSync(notepadPath, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read entire notepad content
 */
export function readNotepad(directory: string): string | null {
  const notepadPath = getNotepadPath(directory);
  if (!existsSync(notepadPath)) {
    return null;
  }

  try {
    return readFileSync(notepadPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Extract a section from notepad content using regex
 */
function extractSection(content: string, header: string): string | null {
  // Match from header to next section (## followed by space, at start of line)
  // We need to match ## at the start of a line, not ### which is a subsection
  const regex = new RegExp(`${header}\\n([\\s\\S]*?)(?=\\n## [^#]|$)`);
  const match = content.match(regex);
  if (!match) {
    return null;
  }

  // Clean up the content - remove HTML comments and trim
  let section = match[1];
  section = section.replace(/<!--[\s\S]*?-->/g, "").trim();

  return section || null;
}

/**
 * Replace a section in notepad content
 */
function replaceSection(
  content: string,
  header: string,
  newContent: string,
): string {
  const regex = new RegExp(`(${header}\\n)([\\s\\S]*?)(?=## |$)`);

  // Preserve comment if it exists
  const commentMatch = content.match(
    new RegExp(`${header}\\n(<!--[\\s\\S]*?-->)`),
  );
  const comment = commentMatch ? commentMatch[1] + "\n" : "";

  return content.replace(regex, `$1${comment}${newContent}\n\n`);
}

// ============================================================================
// Section Access
// ============================================================================

/**
 * Get Priority Context section only (for injection)
 */
export function getPriorityContext(directory: string): string | null {
  const content = readNotepad(directory);
  if (!content) {
    return null;
  }

  return extractSection(content, PRIORITY_HEADER);
}

/**
 * Get Working Memory section
 */
export function getWorkingMemory(directory: string): string | null {
  const content = readNotepad(directory);
  if (!content) {
    return null;
  }

  return extractSection(content, WORKING_MEMORY_HEADER);
}

/**
 * Get MANUAL section
 */
export function getManualSection(directory: string): string | null {
  const content = readNotepad(directory);
  if (!content) {
    return null;
  }

  return extractSection(content, MANUAL_HEADER);
}

// ============================================================================
// Section Updates
// ============================================================================

/**
 * Add/update Priority Context (replaces content, warns if over limit)
 */
export function setPriorityContext(
  directory: string,
  content: string,
  config: NotepadConfig = DEFAULT_CONFIG,
): PriorityContextResult {
  // Initialize if needed
  if (!existsSync(getNotepadPath(directory))) {
    if (!initNotepad(directory)) {
      return { success: false };
    }
  }

  const notepadPath = getNotepadPath(directory);
  let notepadContent = readFileSync(notepadPath, "utf-8");

  // Check size
  const warning =
    content.length > config.priorityMaxChars
      ? `Priority Context exceeds ${config.priorityMaxChars} chars (${content.length} chars). Consider condensing.`
      : undefined;

  // Replace the section
  notepadContent = replaceSection(notepadContent, PRIORITY_HEADER, content);

  try {
    atomicWriteFileSync(notepadPath, notepadContent);
    return { success: true, warning };
  } catch {
    return { success: false };
  }
}

/**
 * Add entry to Working Memory with timestamp
 */
export function addWorkingMemoryEntry(
  directory: string,
  content: string,
): boolean {
  // Initialize if needed
  if (!existsSync(getNotepadPath(directory))) {
    if (!initNotepad(directory)) {
      return false;
    }
  }

  const notepadPath = getNotepadPath(directory);
  let notepadContent = readFileSync(notepadPath, "utf-8");

  // Get current Working Memory content
  const currentMemory =
    extractSection(notepadContent, WORKING_MEMORY_HEADER) || "";

  // Format timestamp
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM

  // Add new entry
  const newEntry = `### ${timestamp}\n${content}\n`;
  const updatedMemory = currentMemory
    ? currentMemory + "\n" + newEntry
    : newEntry;

  // Replace the section
  notepadContent = replaceSection(
    notepadContent,
    WORKING_MEMORY_HEADER,
    updatedMemory,
  );

  try {
    atomicWriteFileSync(notepadPath, notepadContent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add to MANUAL section
 */
export function addManualEntry(directory: string, content: string): boolean {
  // Initialize if needed
  if (!existsSync(getNotepadPath(directory))) {
    if (!initNotepad(directory)) {
      return false;
    }
  }

  const notepadPath = getNotepadPath(directory);
  let notepadContent = readFileSync(notepadPath, "utf-8");

  // Get current MANUAL content
  const currentManual = extractSection(notepadContent, MANUAL_HEADER) || "";

  // Add new entry with timestamp
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM
  const newEntry = `### ${timestamp}\n${content}\n`;
  const updatedManual = currentManual
    ? currentManual + "\n" + newEntry
    : newEntry;

  // Replace the section
  notepadContent = replaceSection(notepadContent, MANUAL_HEADER, updatedManual);

  try {
    atomicWriteFileSync(notepadPath, notepadContent);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Prune Working Memory entries older than N days
 */
export function pruneOldEntries(
  directory: string,
  daysOld: number = DEFAULT_CONFIG.workingMemoryDays,
): PruneResult {
  const notepadPath = getNotepadPath(directory);
  if (!existsSync(notepadPath)) {
    return { pruned: 0, remaining: 0 };
  }

  let notepadContent = readFileSync(notepadPath, "utf-8");
  const workingMemory = extractSection(notepadContent, WORKING_MEMORY_HEADER);

  if (!workingMemory) {
    return { pruned: 0, remaining: 0 };
  }

  // Parse entries
  const entryRegex =
    /### (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\n([\s\S]*?)(?=### |$)/g;
  const entries: Array<{ timestamp: string; content: string }> = [];
  let match: RegExpExecArray | null = entryRegex.exec(workingMemory);

  while (match !== null) {
    entries.push({
      timestamp: match[1],
      content: match[2].trim(),
    });
    match = entryRegex.exec(workingMemory);
  }

  // Calculate cutoff date
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  // Filter entries
  const kept = entries.filter((entry) => {
    const entryDate = new Date(entry.timestamp);
    return entryDate >= cutoff;
  });

  const pruned = entries.length - kept.length;

  // Rebuild Working Memory section
  const newContent = kept
    .map((entry) => `### ${entry.timestamp}\n${entry.content}`)
    .join("\n\n");

  notepadContent = replaceSection(
    notepadContent,
    WORKING_MEMORY_HEADER,
    newContent,
  );

  try {
    atomicWriteFileSync(notepadPath, notepadContent);
    return { pruned, remaining: kept.length };
  } catch {
    return { pruned: 0, remaining: entries.length };
  }
}

// ============================================================================
// Stats and Info
// ============================================================================

/**
 * Get notepad stats
 */
export function getNotepadStats(directory: string): NotepadStats {
  const notepadPath = getNotepadPath(directory);

  if (!existsSync(notepadPath)) {
    return {
      exists: false,
      totalSize: 0,
      prioritySize: 0,
      workingMemoryEntries: 0,
      oldestEntry: null,
    };
  }

  const content = readFileSync(notepadPath, "utf-8");
  const priorityContext = extractSection(content, PRIORITY_HEADER) || "";
  const workingMemory = extractSection(content, WORKING_MEMORY_HEADER) || "";

  // Count entries — support both legacy ### and new HTML comment delimiter formats
  const wmMatches = workingMemory.match(
    /<\!-- WM:\d{4}-\d{2}-\d{2} \d{2}:\d{2} -->/g,
  );
  const legacyMatches = workingMemory.match(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g);
  const entryMatches = wmMatches ?? legacyMatches;
  const entryCount = entryMatches ? entryMatches.length : 0;

  // Find oldest entry
  let oldestEntry: string | null = null;
  if (entryMatches && entryMatches.length > 0) {
    // Extract just the timestamp part
    const timestamps = entryMatches.map((m) =>
      m.startsWith("<!--") ? m.replace(/^<\!-- WM:| -->$/g, "") : m.replace("### ", "")
    );
    timestamps.sort();
    oldestEntry = timestamps[0];
  }

  return {
    exists: true,
    totalSize: Buffer.byteLength(content, "utf-8"),
    prioritySize: Buffer.byteLength(priorityContext, "utf-8"),
    workingMemoryEntries: entryCount,
    oldestEntry,
  };
}

// ============================================================================
// Context Formatting
// ============================================================================

/**
 * Format context for injection into session
 */
export function formatNotepadContext(directory: string): string | null {
  const notepadPath = getNotepadPath(directory);
  if (!existsSync(notepadPath)) {
    return null;
  }

  const priorityContext = getPriorityContext(directory);

  if (!priorityContext) {
    return null;
  }

  const lines = [
    "<notepad-priority>",
    "",
    "## Priority Context",
    "",
    priorityContext,
    "",
    "</notepad-priority>",
    "",
  ];

  return lines.join("\n");
}

/**
 * Format full notepad for display
 */
export function formatFullNotepad(directory: string): string | null {
  const content = readNotepad(directory);
  if (!content) {
    return null;
  }

  return content;
}
