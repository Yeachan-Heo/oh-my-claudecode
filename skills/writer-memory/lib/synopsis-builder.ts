/**
 * Synopsis Builder - 정서 중심 시놉시스 생성기
 *
 * Korean writers think: emotion → relationship → event → plot
 * NOT plot-first!
 */

import { loadMemory, saveMemory, now } from './memory-manager';
import type { WriterMemory, Character, Relationship, Scene, SynopsisState } from './memory-manager';

// === Synopsis Generation ===

export function generateSynopsis(options?: {
  protagonist?: string;
  format?: 'full' | 'brief' | 'pitch';
}): string | null {
  const memory = loadMemory();
  if (!memory) return null;

  const format = options?.format || 'full';
  const protagonist = options?.protagonist;

  const attitude = extractProtagonistAttitude(memory, protagonist);
  const relationships = extractCoreRelationships(memory, protagonist);
  const theme = extractEmotionalTheme(memory);
  const genreContrast = extractGenreVsEmotion(memory);
  const aftertaste = extractEndingAftertaste(memory);

  switch (format) {
    case 'brief':
      return formatBriefSynopsis(attitude, relationships, theme, memory);
    case 'pitch':
      return formatPitchSynopsis(attitude, relationships, theme, genreContrast, memory);
    default:
      return formatFullSynopsis(attitude, relationships, theme, genreContrast, aftertaste, memory);
  }
}

// === 5 Essential Element Extractors ===

function findProtagonist(memory: WriterMemory, name?: string): Character | null {
  const chars = Object.values(memory.characters);
  if (name) {
    return chars.find(c => c.name === name || c.aliases?.includes(name)) || null;
  }
  return chars[0] || null;
}

export function extractProtagonistAttitude(memory: WriterMemory, protagonistName?: string): string {
  const protagonist = findProtagonist(memory, protagonistName);

  if (!protagonist) {
    return '⚠️ 주인공 정보 없음. 캐릭터를 먼저 등록하세요.';
  }

  const parts: string[] = [];
  if (protagonist.arc) parts.push(protagonist.arc);
  if (protagonist.attitude) parts.push(protagonist.attitude);

  if (parts.length === 0) {
    return `⚠️ ${protagonist.name}의 태도 정보 미입력. arc와 attitude 필드를 채우세요.`;
  }

  return parts.join('. ');
}

export function extractCoreRelationships(memory: WriterMemory, protagonistName?: string): string {
  const protagonist = findProtagonist(memory, protagonistName);

  if (!protagonist) {
    return '⚠️ 주인공 정보 없음.';
  }

  const rels = memory.relationships.filter(
    r => r.from === protagonist.name || r.to === protagonist.name
  );

  if (rels.length === 0) {
    return `⚠️ ${protagonist.name} 중심의 관계 정보 없음. 관계를 등록하세요.`;
  }

  return rels.map(r => {
    const other = r.from === protagonist.name ? r.to : r.from;
    return `${protagonist.name}-${other}: ${r.dynamic || r.type}`;
  }).join('\n');
}

export function extractEmotionalTheme(memory: WriterMemory): string {
  if (memory.themes.length === 0) {
    return '⚠️ 테마 정보 없음. 작품의 정서적 주제를 입력하세요.';
  }

  return memory.themes.map(t => t.description || t.name).join('. ');
}

export function extractGenreVsEmotion(memory: WriterMemory): string {
  const synopsis = memory.synopsis;
  if (synopsis?.genreVsRealEmotion) {
    return synopsis.genreVsRealEmotion;
  }

  const genre = memory.project.genre || '미지정';
  return `장르: ${genre}. 실제 정서: 미정의. genreVsRealEmotion 필드를 입력하세요.`;
}

export function extractEndingAftertaste(memory: WriterMemory): string {
  const synopsis = memory.synopsis;
  if (synopsis?.endingAftertaste) {
    return synopsis.endingAftertaste;
  }

  return '❌ 엔딩 정서 잔상 미입력. synopsis update endingAftertaste "..." 로 추가하세요.';
}

// === Synopsis State Management ===

export function saveSynopsisState(state: SynopsisState): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  memory.synopsis = { ...state, lastGenerated: now() };
  return saveMemory(memory);
}

export function loadSynopsisState(): SynopsisState | null {
  const memory = loadMemory();
  return memory?.synopsis || null;
}

export function updateSynopsisElement(element: keyof SynopsisState, value: string): boolean {
  const memory = loadMemory();
  if (!memory) return false;

  memory.synopsis = memory.synopsis || {
    protagonistAttitude: '',
    coreRelationships: '',
    emotionalTheme: '',
    genreVsRealEmotion: '',
    endingAftertaste: ''
  };

  (memory.synopsis as any)[element] = value;
  memory.synopsis.lastGenerated = now();
  return saveMemory(memory);
}

// === Format Functions ===

export function formatFullSynopsis(
  attitude: string,
  relationships: string,
  theme: string,
  genreContrast: string,
  aftertaste: string,
  memory: WriterMemory
): string {
  const projectName = memory.project.name || '제목 미정';
  const chars = Object.values(memory.characters);
  const charList = chars.map(c => `- **${c.name}**: ${c.attitude || c.arc || '설명 없음'}`).join('\n');
  const emotionFlow = memory.scenes
    .filter(s => s.emotionTags?.length > 0)
    .map(s => s.emotionTags[0])
    .join(' → ') || '아직 정의되지 않음';

  return `═══════════════════════════════
시놉시스: ${projectName}
═══════════════════════════════

## 1. 주인공의 태도
${attitude}

## 2. 관계의 핵심 구도
${relationships}

## 3. 정서적 테마
${theme}

## 4. 장르와 실제 감정의 거리
${genreContrast}

## 5. 엔딩이 남기는 잔상
${aftertaste}

---
**등장인물**:
${charList || '(등장인물 없음)'}

**장면 수**: ${memory.scenes.length}개

**감정 흐름**: ${emotionFlow}
`;
}

export function formatBriefSynopsis(
  attitude: string,
  relationships: string,
  theme: string,
  memory: WriterMemory
): string {
  const chars = Object.values(memory.characters);
  const protagonist = chars[0];
  const name = protagonist?.name || '주인공';

  return `${name}은 ${attitude.split('.')[0]}. ${theme.split('.')[0]}을 통해 ${relationships.split('\n')[0] || '관계를 형성하며'} 변화한다.`;
}

export function formatPitchSynopsis(
  attitude: string,
  relationships: string,
  theme: string,
  genreContrast: string,
  memory: WriterMemory
): string {
  const projectName = memory.project.name || '이 이야기';
  const chars = Object.values(memory.characters);
  const protagonist = chars[0];
  const name = protagonist?.name || '주인공';

  return `${projectName}는 ${attitude.split('.')[0]} ${name}이 ${theme.split('.')[0]}을 깨닫는 이야기. ${genreContrast.split('.')[0]}.`;
}

// === Checklist ===

export interface ChecklistItem {
  element: string;
  elementKr: string;
  status: 'complete' | 'partial' | 'missing';
  source: string;
  suggestion: string;
}

export function getSynopsisChecklist(memory: WriterMemory): ChecklistItem[] {
  const chars = Object.values(memory.characters);
  const protagonist = chars[0];

  const checklist: ChecklistItem[] = [];

  // 1. Protagonist Attitude
  const hasArc = protagonist?.arc ? true : false;
  const hasAttitude = protagonist?.attitude ? true : false;
  checklist.push({
    element: 'protagonistAttitude',
    elementKr: '주인공 태도 요약',
    status: hasArc && hasAttitude ? 'complete' : hasArc || hasAttitude ? 'partial' : 'missing',
    source: protagonist ? `캐릭터 '${protagonist.name}'에서 추출` : '주인공 없음',
    suggestion: hasArc && hasAttitude ? '' : 'char update <name> arc "..." attitude "..."'
  });

  // 2. Core Relationships
  const relCount = protagonist ? memory.relationships.filter(
    r => r.from === protagonist.name || r.to === protagonist.name
  ).length : 0;
  checklist.push({
    element: 'coreRelationships',
    elementKr: '관계 핵심 구도',
    status: relCount >= 2 ? 'complete' : relCount === 1 ? 'partial' : 'missing',
    source: `관계 ${relCount}개 등록됨`,
    suggestion: relCount >= 2 ? '' : 'rel add <from> <to> <type>'
  });

  // 3. Emotional Theme
  checklist.push({
    element: 'emotionalTheme',
    elementKr: '정서적 테마',
    status: memory.themes.length > 0 ? 'complete' : 'missing',
    source: `테마 ${memory.themes.length}개 등록됨`,
    suggestion: memory.themes.length > 0 ? '' : 'theme add <name>'
  });

  // 4. Genre vs Emotion
  const hasGenreContrast = memory.synopsis?.genreVsRealEmotion ? true : false;
  checklist.push({
    element: 'genreVsEmotion',
    elementKr: '장르와 실제 감정의 거리',
    status: hasGenreContrast ? 'complete' : 'missing',
    source: hasGenreContrast ? '명시적으로 입력됨' : '미입력',
    suggestion: hasGenreContrast ? '' : 'synopsis update genreVsRealEmotion "..."'
  });

  // 5. Ending Aftertaste
  const hasAftertaste = memory.synopsis?.endingAftertaste ? true : false;
  checklist.push({
    element: 'endingAftertaste',
    elementKr: '엔딩 정서 잔상',
    status: hasAftertaste ? 'complete' : 'missing',
    source: hasAftertaste ? '명시적으로 입력됨' : '미입력',
    suggestion: hasAftertaste ? '' : 'synopsis update endingAftertaste "..."'
  });

  return checklist;
}

// === Export ===

export function exportSynopsisAsMarkdown(): string {
  const memory = loadMemory();
  if (!memory) return '# Error: No memory found';

  const synopsis = generateSynopsis({ format: 'full' });
  if (!synopsis) return '# Error: Could not generate synopsis';

  const meta = `---
project: ${memory.project.name || 'Untitled'}
genre: ${memory.project.genre || 'Unspecified'}
generated: ${new Date().toISOString()}
---

`;

  return meta + synopsis;
}

export function exportSynopsisAsJSON(): object {
  const memory = loadMemory();
  if (!memory) return { error: 'No memory found' };

  const checklist = getSynopsisChecklist(memory);

  return {
    metadata: {
      project: memory.project.name,
      genre: memory.project.genre,
      generated: new Date().toISOString()
    },
    elements: {
      protagonistAttitude: extractProtagonistAttitude(memory),
      coreRelationships: extractCoreRelationships(memory),
      emotionalTheme: extractEmotionalTheme(memory),
      genreVsEmotion: extractGenreVsEmotion(memory),
      endingAftertaste: extractEndingAftertaste(memory)
    },
    checklist,
    formats: {
      full: generateSynopsis({ format: 'full' }),
      brief: generateSynopsis({ format: 'brief' }),
      pitch: generateSynopsis({ format: 'pitch' })
    }
  };
}
