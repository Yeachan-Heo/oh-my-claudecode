/**
 * Character Tracking Module
 * 캐릭터 추적 및 검증 시스템
 */

import { loadMemory, saveMemory, generateId, now } from './memory-manager';
import type { Character, EmotionPoint, SpeechLevel, WriterMemory } from './memory-manager';

// === Helper to find character ===
function findCharacter(memory: WriterMemory, nameOrAlias: string): Character | null {
  // Direct lookup
  if (memory.characters[nameOrAlias]) {
    return memory.characters[nameOrAlias];
  }
  // Alias lookup
  for (const char of Object.values(memory.characters)) {
    if (char.aliases?.includes(nameOrAlias)) {
      return char;
    }
  }
  return null;
}

// === Character CRUD ===

export function addCharacter(name: string, options?: {
  arc?: string;
  tone?: string;
  speechLevel?: SpeechLevel;
  attitude?: string;
  keywords?: string[];
  notes?: string;
}): Character | null {
  const memory = loadMemory();
  if (!memory) return null;

  if (memory.characters[name]) {
    return null; // Already exists
  }

  const character: Character = {
    id: generateId('char'),
    name,
    aliases: [],
    arc: options?.arc || '',
    tone: options?.tone || '',
    speechLevel: options?.speechLevel || '반말',
    attitude: options?.attitude || '',
    keywords: options?.keywords || [],
    timeline: [],
    notes: options?.notes || '',
    created: now(),
    updated: now()
  };

  memory.characters[name] = character;
  saveMemory(memory);
  return character;
}

export function updateCharacter(name: string, updates: Partial<Character>): Character | null {
  const memory = loadMemory();
  if (!memory) return null;

  const character = findCharacter(memory, name);
  if (!character) return null;

  // Apply updates (excluding id, name, created)
  const { id, name: _, created, ...allowedUpdates } = updates as any;
  Object.assign(character, allowedUpdates, { updated: now() });

  saveMemory(memory);
  return character;
}

export function removeCharacter(name: string): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  const character = findCharacter(memory, name);
  if (!character) return false;

  delete memory.characters[character.name];
  saveMemory(memory);
  return true;
}

export interface CharacterSummary {
  id: string;
  name: string;
  arc: string;
  tone: string;
  emotionCount: number;
  lastUpdated: string;
}

export function listCharacters(): CharacterSummary[] {
  const memory = loadMemory();
  if (!memory) return [];

  return Object.values(memory.characters).map(c => ({
    id: c.id,
    name: c.name,
    arc: c.arc,
    tone: c.tone,
    emotionCount: c.timeline?.length || 0,
    lastUpdated: c.updated
  }));
}

// === Alias Management ===

export function addAlias(characterName: string, alias: string): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  const character = findCharacter(memory, characterName);
  if (!character) return false;

  if (!character.aliases.includes(alias)) {
    character.aliases.push(alias);
    character.updated = now();
    saveMemory(memory);
  }
  return true;
}

export function removeAlias(characterName: string, alias: string): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  const character = findCharacter(memory, characterName);
  if (!character) return false;

  const idx = character.aliases.indexOf(alias);
  if (idx !== -1) {
    character.aliases.splice(idx, 1);
    character.updated = now();
    saveMemory(memory);
    return true;
  }
  return false;
}

export function resolveCharacter(nameOrAlias: string): Character | null {
  const memory = loadMemory();
  if (!memory) return null;
  return findCharacter(memory, nameOrAlias);
}

// === Emotion Timeline ===

export function addEmotionPoint(characterName: string, emotion: string, trigger: string, options?: {
  sceneId?: string;
  intensity?: 1 | 2 | 3 | 4 | 5;
}): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  const character = findCharacter(memory, characterName);
  if (!character) return false;

  const point: EmotionPoint = {
    timestamp: now(),
    sceneId: options?.sceneId,
    emotion,
    trigger,
    intensity: options?.intensity || 3
  };

  character.timeline.push(point);
  character.updated = now();
  saveMemory(memory);
  return true;
}

export function getEmotionTimeline(characterName: string): EmotionPoint[] {
  const character = resolveCharacter(characterName);
  return character?.timeline || [];
}

export function getLatestEmotion(characterName: string): EmotionPoint | null {
  const timeline = getEmotionTimeline(characterName);
  return timeline.length > 0 ? timeline[timeline.length - 1] : null;
}

export function getEmotionArc(characterName: string): string {
  const timeline = getEmotionTimeline(characterName);
  if (timeline.length === 0) return '';
  return timeline.map(e => e.emotion).join(' → ');
}

// === Dialogue Validation ===

export interface ValidationResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  character: string;
  checks: {
    toneMatch: { passed: boolean; detail: string };
    speechLevelMatch: { passed: boolean; detail: string };
    keywordConsistency: { passed: boolean; detail: string };
  };
  suggestion: string;
}

export function detectSpeechLevel(text: string): SpeechLevel {
  // 존댓말 patterns
  const formal = /요$|습니다$|세요$|십시오$/;
  // 반말 patterns
  const informal = /야$|아$|어$|지$|는데$/;
  // 해체 patterns
  const casual = /임$|음$|ㅋ|ㅎ$/;

  const sentences = text.split(/[.!?]/).filter(s => s.trim());
  let formalCnt = 0, informalCnt = 0, casualCnt = 0;

  for (const s of sentences) {
    const t = s.trim();
    if (formal.test(t)) formalCnt++;
    if (informal.test(t)) informalCnt++;
    if (casual.test(t)) casualCnt++;
  }

  if (formalCnt > informalCnt && formalCnt > casualCnt) return '존댓말';
  if (casualCnt > informalCnt) return '해체';
  if (informalCnt > 0) return '반말';
  return '혼합';
}

export function validateDialogue(characterName: string, dialogue: string): ValidationResult {
  const character = resolveCharacter(characterName);

  if (!character) {
    return {
      status: 'FAIL',
      character: characterName,
      checks: {
        toneMatch: { passed: false, detail: '캐릭터를 찾을 수 없음' },
        speechLevelMatch: { passed: false, detail: '캐릭터를 찾을 수 없음' },
        keywordConsistency: { passed: false, detail: '캐릭터를 찾을 수 없음' }
      },
      suggestion: `"${characterName}" 캐릭터가 메모리에 없습니다.`
    };
  }

  // Check tone
  const exclamations = (dialogue.match(/!/g) || []).length;
  const toneCheck = { passed: true, detail: '톤 일치' };
  if (character.tone.includes('담백') && exclamations > 1) {
    toneCheck.passed = false;
    toneCheck.detail = `담백한 톤에 느낌표 ${exclamations}개는 과함`;
  }

  // Check speech level
  const detected = detectSpeechLevel(dialogue);
  const speechCheck = {
    passed: detected === character.speechLevel || detected === '혼합',
    detail: detected === character.speechLevel ? '말투 일치' : `기대: ${character.speechLevel}, 감지: ${detected}`
  };

  // Check keywords
  const keywordCheck = { passed: true, detail: '키워드 없음 (검사 생략)' };
  if (character.keywords.length > 0) {
    const hasKeyword = character.keywords.some(kw => dialogue.includes(kw));
    keywordCheck.passed = hasKeyword;
    keywordCheck.detail = hasKeyword ? '특징 키워드 포함' : `키워드 미포함: ${character.keywords.slice(0, 2).join(', ')}`;
  }

  const failCount = [toneCheck, speechCheck, keywordCheck].filter(c => !c.passed).length;
  const status: 'PASS' | 'WARN' | 'FAIL' = failCount === 0 ? 'PASS' : failCount >= 2 ? 'FAIL' : 'WARN';

  const suggestions: string[] = [];
  if (!toneCheck.passed) suggestions.push(`톤 조정 필요`);
  if (!speechCheck.passed) suggestions.push(`${character.speechLevel}로 말투 수정`);
  if (!keywordCheck.passed) suggestions.push(`특징 키워드 사용 고려`);

  return {
    status,
    character: character.name,
    checks: {
      toneMatch: toneCheck,
      speechLevelMatch: speechCheck,
      keywordConsistency: keywordCheck
    },
    suggestion: suggestions.length > 0 ? suggestions.join('. ') : '대사가 캐릭터와 잘 어울립니다.'
  };
}

// === Profile Generation ===

export function generateCharacterProfile(characterName: string): string {
  const character = resolveCharacter(characterName);

  if (!character) {
    return `# "${characterName}" 캐릭터를 찾을 수 없습니다`;
  }

  const latest = getLatestEmotion(characterName);
  const arc = getEmotionArc(characterName);

  let profile = `# ${character.name}\n\n`;

  if (character.aliases.length > 0) {
    profile += `**별칭**: ${character.aliases.join(', ')}\n\n`;
  }

  if (character.arc) {
    profile += `**캐릭터 아크**: ${character.arc}\n\n`;
  }

  if (character.tone) {
    profile += `**대사 톤**: ${character.tone}\n\n`;
  }

  profile += `**말투**: ${character.speechLevel}\n\n`;

  if (character.keywords.length > 0) {
    profile += `**핵심 키워드**: ${character.keywords.join(', ')}\n\n`;
  }

  if (latest) {
    profile += `**현재 감정**: ${latest.emotion} (강도: ${latest.intensity}/5)\n\n`;
  }

  if (character.attitude) {
    profile += `**태도**: ${character.attitude}\n\n`;
  }

  if (arc) {
    profile += `**감정 궤도**: ${arc}\n\n`;
  }

  if (character.notes) {
    profile += `**메모**: ${character.notes}\n\n`;
  }

  return profile.trim();
}
