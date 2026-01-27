/**
 * Relationship Graph Module for Writer Memory System
 *
 * Tracks character relationships with evolution over time,
 * Korean relationship types, and graph-based analysis.
 */

import { loadMemory, saveMemory, generateId, now } from './memory-manager';
import type {
  Relationship,
  RelationshipType,
  RelationshipEvent,
  SpeechLevel,
  WriterMemory
} from './memory-manager';

// ============================================================================
// Relationship CRUD Operations
// ============================================================================

/**
 * Create a new relationship between two characters
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @param type - Relationship type
 * @param options - Optional relationship properties
 * @returns Created relationship
 */
export function addRelationship(
  char1Name: string,
  char2Name: string,
  type: RelationshipType,
  options?: {
    dynamic?: Relationship['dynamic'];
    speechLevel?: SpeechLevel;
    notes?: string;
  }
): Relationship | null {
  const memory = loadMemory();
  if (!memory) return null;

  // Check if relationship already exists
  const existing = memory.relationships.find(r =>
    (r.from === char1Name && r.to === char2Name) ||
    (r.from === char2Name && r.to === char1Name)
  );

  if (existing) {
    return null;
  }

  const relationship: Relationship = {
    id: generateId('rel'),
    from: char1Name,
    to: char2Name,
    type,
    dynamic: options?.dynamic || 'stable',
    speechLevel: options?.speechLevel,
    notes: options?.notes,
    evolution: [],
    created: now()
  };

  memory.relationships.push(relationship);
  saveMemory(memory);

  return relationship;
}

/**
 * Update an existing relationship with partial data
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @param updates - Partial relationship updates
 * @returns Updated relationship
 */
export function updateRelationship(
  char1Name: string,
  char2Name: string,
  updates: Partial<Omit<Relationship, 'id' | 'from' | 'to' | 'created'>>
): Relationship | null {
  const memory = loadMemory();
  if (!memory) return null;

  const relationship = getRelationship(char1Name, char2Name);

  if (!relationship) {
    return null;
  }

  Object.assign(relationship, updates);
  saveMemory(memory);

  return relationship;
}

/**
 * Remove a relationship between two characters
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 */
export function removeRelationship(char1Name: string, char2Name: string): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  const index = memory.relationships.findIndex(r =>
    (r.from === char1Name && r.to === char2Name) ||
    (r.from === char2Name && r.to === char1Name)
  );

  if (index === -1) {
    return false;
  }

  memory.relationships.splice(index, 1);
  saveMemory(memory);
  return true;
}

/**
 * Get relationship between two characters (direction-agnostic)
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @returns Relationship or undefined
 */
export function getRelationship(char1Name: string, char2Name: string): Relationship | undefined {
  const memory = loadMemory();
  if (!memory) return undefined;

  return memory.relationships.find(r =>
    (r.from === char1Name && r.to === char2Name) ||
    (r.from === char2Name && r.to === char1Name)
  );
}

/**
 * List all relationships, optionally filtered by character
 *
 * @param characterName - Optional character to filter by
 * @returns Array of relationships
 */
export function listRelationships(characterName?: string): Relationship[] {
  const memory = loadMemory();
  if (!memory) return [];

  if (!characterName) {
    return memory.relationships;
  }

  return memory.relationships.filter(r =>
    r.from === characterName || r.to === characterName
  );
}

// ============================================================================
// Relationship Evolution
// ============================================================================

/**
 * Add a timeline event to a relationship
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @param change - Description of relationship change
 * @param catalyst - What caused the change
 * @param sceneId - Optional scene reference
 * @returns Created event
 */
export function addRelationshipEvent(
  char1Name: string,
  char2Name: string,
  change: string,
  catalyst: string,
  sceneId?: string
): RelationshipEvent | null {
  const relationship = getRelationship(char1Name, char2Name);

  if (!relationship) {
    return null;
  }

  const event: RelationshipEvent = {
    timestamp: now(),
    change,
    catalyst,
    sceneId
  };

  relationship.evolution.push(event);

  const memory = loadMemory();
  if (!memory) return null;

  saveMemory(memory);

  return event;
}

/**
 * Get all timeline events for a relationship
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @returns Array of events sorted by timestamp
 */
export function getRelationshipTimeline(char1Name: string, char2Name: string): RelationshipEvent[] {
  const relationship = getRelationship(char1Name, char2Name);

  if (!relationship) {
    return [];
  }

  return relationship.evolution.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Get relationship arc summary (e.g., "첫만남 → 오해 → 화해")
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @returns Arc summary string
 */
export function getRelationshipArc(char1Name: string, char2Name: string): string {
  const timeline = getRelationshipTimeline(char1Name, char2Name);

  if (timeline.length === 0) {
    return '변화 없음';
  }

  return timeline.map(e => e.change).join(' → ');
}

// ============================================================================
// Graph Operations
// ============================================================================

/**
 * Get all connections for a character with direction info
 *
 * @param characterName - Character name
 * @returns Connections with direction (outgoing/incoming/mutual)
 */
export function getCharacterConnections(characterName: string): Array<{
  relationship: Relationship;
  direction: 'outgoing' | 'incoming' | 'mutual';
  otherCharacter: string;
}> {
  const relationships = listRelationships(characterName);

  return relationships.map(r => {
    const isFrom = r.from === characterName;
    return {
      relationship: r,
      direction: 'mutual' as const, // Most relationships are bidirectional
      otherCharacter: isFrom ? r.to : r.from
    };
  });
}

/**
 * Get full relationship graph
 *
 * @returns Graph with nodes (characters) and edges (relationships)
 */
export function getRelationshipWeb(): {
  nodes: string[];
  edges: Array<{ from: string; to: string; type: RelationshipType }>
} {
  const memory = loadMemory();
  if (!memory) return { nodes: [], edges: [] };

  const nodes = new Set<string>();
  const edges: Array<{ from: string; to: string; type: RelationshipType }> = [];

  memory.relationships.forEach(r => {
    nodes.add(r.from);
    nodes.add(r.to);
    edges.push({ from: r.from, to: r.to, type: r.type });
  });

  return {
    nodes: Array.from(nodes),
    edges
  };
}

// ============================================================================
// Korean Labels
// ============================================================================

/**
 * Get Korean label for relationship type
 *
 * @param type - Relationship type
 * @returns Korean label
 */
export function getKoreanRelationType(type: RelationshipType): string {
  const labels: Record<RelationshipType, string> = {
    romantic: '연인',
    familial: '가족',
    friendship: '우정',
    antagonistic: '적대',
    professional: '직업적',
    mentor: '사제',
    complex: '복합적'
  };

  return labels[type];
}

// ============================================================================
// Profile Generation
// ============================================================================

/**
 * Generate markdown profile for a relationship
 *
 * @param char1Name - First character name
 * @param char2Name - Second character name
 * @returns Markdown profile
 */
export function generateRelationshipProfile(char1Name: string, char2Name: string): string {
  const relationship = getRelationship(char1Name, char2Name);

  if (!relationship) {
    return `# ${char1Name} ↔ ${char2Name}\n\n관계 정보 없음`;
  }

  const timeline = getRelationshipTimeline(char1Name, char2Name);
  const arc = getRelationshipArc(char1Name, char2Name);

  let profile = `# ${char1Name} ↔ ${char2Name}\n\n`;
  profile += `**관계 유형**: ${getKoreanRelationType(relationship.type)}\n`;
  profile += `**상태**: ${relationship.dynamic}\n`;

  if (relationship.speechLevel) {
    profile += `**말투**: ${relationship.speechLevel}\n`;
  }

  if (relationship.notes) {
    profile += `\n## 설명\n${relationship.notes}\n`;
  }

  if (timeline.length > 0) {
    profile += `\n## 관계 흐름\n${arc}\n\n`;
    profile += `## 주요 사건\n`;
    timeline.forEach(e => {
      profile += `- **${e.change}**: ${e.catalyst}`;
      if (e.sceneId) {
        profile += ` (${e.sceneId})`;
      }
      profile += '\n';
    });
  }

  return profile;
}

/**
 * Generate ASCII map of all relationships with symbols
 *
 * @returns ASCII relationship map
 */
export function generateRelationshipMap(): string {
  const web = getRelationshipWeb();

  if (web.nodes.length === 0) {
    return '관계 없음';
  }

  const symbols: Record<RelationshipType, string> = {
    romantic: '♥',
    familial: '家',
    friendship: '友',
    antagonistic: '敵',
    professional: '職',
    mentor: '師',
    complex: '複'
  };

  let map = '# 관계 지도\n\n';

  web.nodes.forEach(node => {
    const connections = getCharacterConnections(node);
    if (connections.length > 0) {
      map += `${node}:\n`;
      connections.forEach(conn => {
        const symbol = symbols[conn.relationship.type];
        map += `  ${symbol} ${conn.otherCharacter} (${getKoreanRelationType(conn.relationship.type)})\n`;
      });
      map += '\n';
    }
  });

  return map;
}
