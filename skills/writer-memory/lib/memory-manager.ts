/**
 * memory-manager.ts
 *
 * Core memory management module for the Writer Memory System.
 * Handles all CRUD operations for .writer-memory/ storage.
 *
 * This is a REFERENCE IMPLEMENTATION that Claude reads when the skill
 * is activated. Written as real, runnable TypeScript with proper types,
 * error handling, and atomic operations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, readdirSync } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpeechLevel = "반말" | "존댓말" | "해체" | "혼합";

export type RelationshipType =
  | "romantic"
  | "familial"
  | "friendship"
  | "antagonistic"
  | "professional"
  | "mentor"
  | "complex";

export interface EmotionPoint {
  timestamp: string;
  sceneId?: string;
  /** Korean emotion word, e.g. "그리움" */
  emotion: string;
  /** What caused this emotion */
  trigger: string;
  intensity: 1 | 2 | 3 | 4 | 5;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  /** Arc summary, e.g. "체념->욕망자각->선택" */
  arc: string;
  /** Tone summary, e.g. "담백, 현재충실" */
  tone: string;
  speechLevel: SpeechLevel;
  /** Characteristic phrases/words */
  keywords: string[];
  /** Attitude summary (태도 요약) */
  attitude: string;
  timeline: EmotionPoint[];
  notes: string;
  created: string;
  updated: string;
  /** Words/patterns the character would NEVER say */
  taboo?: string[];
  /** Default emotional state */
  emotional_baseline?: string;
  /** What triggers emotional changes */
  triggers?: string[];
}

export interface WorldRule {
  id: string;
  category: string;
  description: string;
}

export interface Location {
  id: string;
  name: string;
  description: string;
  atmosphere: string;
  /** Other location IDs */
  connectedTo: string[];
}

export interface WorldMemory {
  name: string;
  era: string;
  atmosphere: string;
  rules: WorldRule[];
  locations: Location[];
  culturalNotes: string[];
  notes: string;
}

export interface RelationshipEvent {
  timestamp: string;
  sceneId?: string;
  change: string;
  catalyst: string;
}

export interface Relationship {
  id: string;
  /** Character ID */
  from: string;
  /** Character ID */
  to: string;
  type: RelationshipType;
  /** e.g. "일방적 짝사랑 -> 상호 이해" */
  dynamic: string;
  speechLevel?: SpeechLevel;
  evolution: RelationshipEvent[];
  notes?: string;
  created: string;
}

export interface Cut {
  order: number;
  type: "dialogue" | "narration" | "action" | "internal";
  content: string;
  character?: string;
  emotionTag?: string;
}

export interface Scene {
  id: string;
  title: string;
  chapter?: string;
  order: number;
  characters: string[];
  emotionTags: string[];
  cuts: Cut[];
  narrationTone?: string;
  notes?: string;
  created: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  relatedCharacters: string[];
  relatedScenes: string[];
}

export interface SynopsisState {
  /** 주인공 태도 요약 */
  protagonistAttitude: string;
  /** 관계 핵심 구도 */
  coreRelationships: string;
  /** 정서적 테마 */
  emotionalTheme: string;
  /** 장르 vs 실제감정 대비 */
  genreVsRealEmotion: string;
  /** 엔딩 정서 잔상 */
  endingAftertaste: string;
  lastGenerated?: string;
}

export interface ProjectMeta {
  name: string;
  genre: string;
  /** ISO timestamp */
  created: string;
  /** ISO timestamp */
  updated: string;
}

export interface WriterMemory {
  version: "1.0";
  project: ProjectMeta;
  characters: Record<string, Character>;
  world: WorldMemory;
  relationships: Relationship[];
  scenes: Scene[];
  themes: Theme[];
  synopsis: SynopsisState;
}

export interface MemoryStats {
  characterCount: number;
  relationshipCount: number;
  sceneCount: number;
  themeCount: number;
  totalEmotionPoints: number;
  lastUpdated: string;
  storageSizeKB: number;
}

export interface SearchResult {
  type: "character" | "relationship" | "scene" | "theme" | "world";
  id: string;
  title: string;
  relevance: string;
  snippet: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_DIR = ".writer-memory";
const MEMORY_FILE = "memory.json";
const BACKUP_DIR = "backups";
const MAX_BACKUPS = 20;

// ---------------------------------------------------------------------------
// Path Helpers
// ---------------------------------------------------------------------------

/** Returns the path to the main memory JSON file. */
export function getMemoryPath(): string {
  return join(MEMORY_DIR, MEMORY_FILE);
}

/** Returns the path to the backups directory. */
export function getBackupPath(): string {
  return join(MEMORY_DIR, BACKUP_DIR);
}

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a prefixed unique ID using unix timestamp + random suffix.
 * @param prefix - e.g. "char", "rel", "scene"
 * @returns e.g. "char_1706123456_a3f"
 */
export function generateId(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${prefix}_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Returns the current time as an ISO 8601 string. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Format an ISO timestamp into Korean date format.
 * @param iso - ISO 8601 string
 * @returns e.g. "2024년 1월 24일"
 */
export function formatKoreanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso; // fallback for invalid dates
  }
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${year}년 ${month}월 ${day}일`;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Create a fresh WriterMemory structure for a new project.
 * Also ensures the .writer-memory/ directory tree exists on disk.
 *
 * @param projectName - e.g. "이별의 온도"
 * @param genre - e.g. "멜로 / 성장 드라마"
 */
export function initMemory(projectName: string, genre: string): WriterMemory {
  const timestamp = now();

  // Ensure directory structure
  const memDir = MEMORY_DIR;
  const backDir = getBackupPath();
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }
  if (!existsSync(backDir)) {
    mkdirSync(backDir, { recursive: true });
  }

  const memory: WriterMemory = {
    version: "1.0",
    project: {
      name: projectName,
      genre,
      created: timestamp,
      updated: timestamp,
    },
    characters: {},
    world: {
      name: "",
      era: "",
      atmosphere: "",
      rules: [],
      locations: [],
      culturalNotes: [],
      notes: "",
    },
    relationships: [],
    scenes: [],
    themes: [],
    synopsis: {
      protagonistAttitude: "",
      coreRelationships: "",
      emotionalTheme: "",
      genreVsRealEmotion: "",
      endingAftertaste: "",
    },
  };

  saveMemory(memory);
  return memory;
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Load the writer memory from disk.
 * @returns The parsed WriterMemory, or null if the file does not exist or is corrupt.
 */
export function loadMemory(): WriterMemory | null {
  const memPath = getMemoryPath();
  try {
    if (!existsSync(memPath)) {
      return null;
    }
    const raw = readFileSync(memPath, "utf-8");
    const parsed = JSON.parse(raw) as WriterMemory;
    return parsed;
  } catch (err) {
    console.error(`[writer-memory] Failed to load memory from ${memPath}:`, err);
    return null;
  }
}

/**
 * Persist memory to disk using an atomic write (write to temp, then rename).
 * Automatically updates the project.updated timestamp and creates a backup
 * of the previous state.
 *
 * @returns true on success, false on failure
 */
export function saveMemory(memory: WriterMemory): boolean {
  const memPath = getMemoryPath();
  const memDir = dirname(memPath);

  try {
    // Ensure directory exists
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    // Backup existing file before overwriting
    if (existsSync(memPath)) {
      try {
        const existing = readFileSync(memPath, "utf-8");
        const existingMemory = JSON.parse(existing) as WriterMemory;
        createBackup(existingMemory);
      } catch {
        // If backup fails, continue with save anyway
      }
    }

    // Update timestamp
    memory.project.updated = now();

    // Atomic write: write to temp file, then rename
    const tmpPath = memPath + ".tmp";
    const json = JSON.stringify(memory, null, 2);
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, memPath);

    return true;
  } catch (err) {
    console.error(`[writer-memory] Failed to save memory to ${memPath}:`, err);
    return false;
  }
}

/**
 * Create a timestamped backup of the given memory state.
 * Old backups beyond MAX_BACKUPS are pruned automatically.
 *
 * @returns The backup file path, or empty string on failure.
 */
export function createBackup(memory: WriterMemory): string {
  const backDir = getBackupPath();

  try {
    if (!existsSync(backDir)) {
      mkdirSync(backDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = join(backDir, `memory-${ts}.json`);
    const json = JSON.stringify(memory, null, 2);
    writeFileSync(backupFile, json, "utf-8");

    // Prune old backups
    pruneBackups(backDir);

    return backupFile;
  } catch (err) {
    console.error("[writer-memory] Failed to create backup:", err);
    return "";
  }
}

/**
 * Remove oldest backup files when count exceeds MAX_BACKUPS.
 */
function pruneBackups(backDir: string): void {
  try {
    const files = readdirSync(backDir)
      .filter((f) => f.startsWith("memory-") && f.endsWith(".json"))
      .sort(); // lexicographic sort works because filenames contain ISO timestamps

    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift()!;
      const fullPath = join(backDir, oldest);
      // Use writeFileSync trick: overwrite then unlink is not needed;
      // simply use fs.unlinkSync
      require("fs").unlinkSync(fullPath);
    }
  } catch {
    // Non-critical; ignore pruning errors
  }
}

// ---------------------------------------------------------------------------
// Memory Stats
// ---------------------------------------------------------------------------

/**
 * Compute aggregate statistics about the memory store.
 */
export function getMemoryStats(memory: WriterMemory): MemoryStats {
  const characters = Object.values(memory.characters);
  const totalEmotionPoints = characters.reduce(
    (sum, c) => sum + c.timeline.length,
    0
  );

  let storageSizeKB = 0;
  try {
    const memPath = getMemoryPath();
    if (existsSync(memPath)) {
      const stat = statSync(memPath);
      storageSizeKB = Math.round((stat.size / 1024) * 100) / 100;
    }
  } catch {
    // If stat fails, leave at 0
  }

  return {
    characterCount: characters.length,
    relationshipCount: memory.relationships.length,
    sceneCount: memory.scenes.length,
    themeCount: memory.themes.length,
    totalEmotionPoints,
    lastUpdated: memory.project.updated,
    storageSizeKB,
  };
}

// ---------------------------------------------------------------------------
// Search / Query Helpers
// ---------------------------------------------------------------------------

/**
 * Find a character by exact name match (case-sensitive).
 * @param name - e.g. "서연"
 */
export function findCharacterByName(
  memory: WriterMemory,
  name: string
): Character | null {
  for (const char of Object.values(memory.characters)) {
    if (char.name === name) {
      return char;
    }
  }
  return null;
}

/**
 * Find a character by one of their aliases.
 * @param alias - e.g. "연이" (nickname for 서연)
 */
export function findCharacterByAlias(
  memory: WriterMemory,
  alias: string
): Character | null {
  for (const char of Object.values(memory.characters)) {
    if (char.aliases.includes(alias)) {
      return char;
    }
  }
  return null;
}

/**
 * Find a relationship between two characters (in either direction).
 * @param char1 - Character ID
 * @param char2 - Character ID
 */
export function findRelationship(
  memory: WriterMemory,
  char1: string,
  char2: string
): Relationship | null {
  return (
    memory.relationships.find(
      (r) =>
        (r.from === char1 && r.to === char2) ||
        (r.from === char2 && r.to === char1)
    ) ?? null
  );
}

/**
 * Find a scene by its unique ID.
 */
export function findSceneById(
  memory: WriterMemory,
  id: string
): Scene | null {
  return memory.scenes.find((s) => s.id === id) ?? null;
}

/**
 * Find all scenes that include a given character.
 * @param characterId - Character ID to search for
 */
export function findScenesByCharacter(
  memory: WriterMemory,
  characterId: string
): Scene[] {
  return memory.scenes.filter((s) => s.characters.includes(characterId));
}

/**
 * Full-text search across all memory domains.
 * Matches query substring (case-insensitive) against names, descriptions,
 * notes, keywords, and content fields.
 *
 * @param query - Search string, e.g. "그리움" or "카페"
 * @returns Matching results sorted by domain priority
 */
export function searchMemory(
  memory: WriterMemory,
  query: string
): SearchResult[] {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();

  const matches = (text: string | undefined): boolean =>
    text != null && text.toLowerCase().includes(q);

  // Search characters
  for (const char of Object.values(memory.characters)) {
    if (
      matches(char.name) ||
      matches(char.arc) ||
      matches(char.tone) ||
      matches(char.attitude) ||
      matches(char.notes) ||
      char.aliases.some(matches) ||
      char.keywords.some(matches)
    ) {
      results.push({
        type: "character",
        id: char.id,
        title: char.name,
        relevance: matches(char.name) ? "name" : "content",
        snippet: truncate(
          [char.arc, char.tone, char.attitude].filter(Boolean).join(" | "),
          120
        ),
      });
    }
  }

  // Search relationships
  for (const rel of memory.relationships) {
    if (matches(rel.dynamic) || matches(rel.notes)) {
      const fromChar = memory.characters[rel.from];
      const toChar = memory.characters[rel.to];
      const fromName = fromChar?.name ?? rel.from;
      const toName = toChar?.name ?? rel.to;
      results.push({
        type: "relationship",
        id: rel.id,
        title: `${fromName} <-> ${toName}`,
        relevance: "content",
        snippet: truncate(rel.dynamic, 120),
      });
    }
  }

  // Search scenes
  for (const scene of memory.scenes) {
    if (
      matches(scene.title) ||
      matches(scene.narrationTone) ||
      matches(scene.notes) ||
      scene.emotionTags.some(matches) ||
      scene.cuts.some((c) => matches(c.content))
    ) {
      results.push({
        type: "scene",
        id: scene.id,
        title: scene.title,
        relevance: matches(scene.title) ? "title" : "content",
        snippet: truncate(
          scene.cuts
            .slice(0, 2)
            .map((c) => c.content)
            .join(" / "),
          120
        ),
      });
    }
  }

  // Search themes
  for (const theme of memory.themes) {
    if (
      matches(theme.name) ||
      matches(theme.description) ||
      theme.keywords.some(matches)
    ) {
      results.push({
        type: "theme",
        id: theme.id,
        title: theme.name,
        relevance: matches(theme.name) ? "name" : "content",
        snippet: truncate(theme.description, 120),
      });
    }
  }

  // Search world
  const world = memory.world;
  if (
    matches(world.name) ||
    matches(world.era) ||
    matches(world.atmosphere) ||
    matches(world.notes) ||
    world.culturalNotes.some(matches) ||
    world.locations.some(
      (l) => matches(l.name) || matches(l.description) || matches(l.atmosphere)
    )
  ) {
    // Find the most relevant location if applicable
    const matchedLoc = world.locations.find(
      (l) => matches(l.name) || matches(l.description)
    );
    results.push({
      type: "world",
      id: matchedLoc?.id ?? "world",
      title: matchedLoc?.name ?? (world.name || "World"),
      relevance: "content",
      snippet: truncate(
        matchedLoc?.description ?? world.atmosphere ?? world.notes,
        120
      ),
    });
  }

  return results;
}

/** Truncate a string to maxLen, appending ellipsis if needed. */
function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the structural integrity of a WriterMemory object.
 * Checks for required fields, dangling references, and data consistency.
 */
export function validateMemory(memory: WriterMemory): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Version check
  if (memory.version !== "1.0") {
    errors.push(`Unsupported version: "${memory.version}" (expected "1.0")`);
  }

  // Project meta
  if (!memory.project.name) {
    errors.push("Project name is empty");
  }
  if (!memory.project.genre) {
    warnings.push("Project genre is empty");
  }
  if (!memory.project.created) {
    errors.push("Project created timestamp is missing");
  }

  // Characters
  const charIds = new Set(Object.keys(memory.characters));
  for (const [id, char] of Object.entries(memory.characters)) {
    if (char.id !== id) {
      errors.push(
        `Character key "${id}" does not match character.id "${char.id}"`
      );
    }
    if (!char.name) {
      errors.push(`Character "${id}" has no name`);
    }
    for (const ep of char.timeline) {
      if (ep.intensity < 1 || ep.intensity > 5) {
        warnings.push(
          `Character "${char.name}" has emotion point with intensity ${ep.intensity} (expected 1-5)`
        );
      }
      if (ep.sceneId && !memory.scenes.some((s) => s.id === ep.sceneId)) {
        warnings.push(
          `Character "${char.name}" references non-existent scene "${ep.sceneId}" in timeline`
        );
      }
    }
  }

  // Relationships
  for (const rel of memory.relationships) {
    if (!charIds.has(rel.from)) {
      errors.push(
        `Relationship "${rel.id}" references non-existent character "${rel.from}"`
      );
    }
    if (!charIds.has(rel.to)) {
      errors.push(
        `Relationship "${rel.id}" references non-existent character "${rel.to}"`
      );
    }
    if (rel.from === rel.to) {
      warnings.push(
        `Relationship "${rel.id}" is self-referential (from === to === "${rel.from}")`
      );
    }
  }

  // Scenes
  const sceneIds = new Set<string>();
  for (const scene of memory.scenes) {
    if (sceneIds.has(scene.id)) {
      errors.push(`Duplicate scene ID: "${scene.id}"`);
    }
    sceneIds.add(scene.id);

    for (const charId of scene.characters) {
      if (!charIds.has(charId)) {
        warnings.push(
          `Scene "${scene.title}" references non-existent character "${charId}"`
        );
      }
    }
    if (scene.cuts.length === 0) {
      warnings.push(`Scene "${scene.title}" has no cuts`);
    }
  }

  // Themes
  for (const theme of memory.themes) {
    for (const charId of theme.relatedCharacters) {
      if (!charIds.has(charId)) {
        warnings.push(
          `Theme "${theme.name}" references non-existent character "${charId}"`
        );
      }
    }
    for (const sid of theme.relatedScenes) {
      if (!sceneIds.has(sid)) {
        warnings.push(
          `Theme "${theme.name}" references non-existent scene "${sid}"`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
