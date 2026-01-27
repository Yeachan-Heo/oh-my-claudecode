import { loadMemory, saveMemory, findSceneById, findScenesByCharacter, generateId, now } from './memory-manager';
import type { Scene, Cut, WriterMemory } from './memory-manager';

// === Korean Emotion Vocabulary ===
const EMOTION_VOCABULARY: string[] = [
  "긴장", "설렘", "불안", "평온", "갈등",
  "슬픔", "기쁨", "분노", "체념", "희망",
  "외로움", "그리움", "애틋함", "당혹", "환희",
  "공포", "안도", "후회", "결의", "허탈"
];

const CUT_TYPE_LABELS: Record<string, string> = {
  dialogue: "대사",
  narration: "내레이션",
  action: "액션",
  internal: "내면"
};

// === Type Definitions ===
export interface SceneSummary {
  id: string;
  title: string;
  chapter?: string;
  order: number;
  characterCount: number;
  cutCount: number;
  emotionTags: string[];
}

export interface SceneFlowEntry {
  order: number;
  title: string;
  chapter?: string;
  primaryEmotion: string;
  characters: string[];
  cutCount: number;
}

// === Scene CRUD ===

export function addScene(title: string, options?: {
  chapter?: string;
  characters?: string[];
  emotionTags?: string[];
  narrationTone?: string;
  notes?: string;
}): Scene | null {
  try {
    const memory = loadMemory();

    const newScene: Scene = {
      id: generateId('scene'),
      title,
      chapter: options?.chapter,
      characters: options?.characters || [],
      emotionTags: options?.emotionTags || [],
      cuts: [],
      narrationTone: options?.narrationTone || '',
      notes: options?.notes || '',
      order: memory.scenes.length,
      created: now()
    };

    memory.scenes.push(newScene);
    saveMemory(memory);

    return newScene;
  } catch (error) {
    console.error('Failed to add scene:', error);
    return null;
  }
}

export function updateScene(sceneId: string, updates: Partial<Scene>): Scene | null {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return null;
    }

    // Apply updates (preserve immutable fields)
    Object.assign(scene, {
      ...updates,
      id: scene.id,
      created: scene.created
    });

    saveMemory(memory);
    return scene;
  } catch (error) {
    console.error('Failed to update scene:', error);
    return null;
  }
}

export function removeScene(sceneId: string): boolean {
  try {
    const memory = loadMemory();
    const index = memory.scenes.findIndex(s => s.id === sceneId);

    if (index === -1) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    memory.scenes.splice(index, 1);

    // Reorder remaining scenes
    memory.scenes.forEach((scene, idx) => {
      scene.order = idx;
    });

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to remove scene:', error);
    return false;
  }
}

export function getScene(sceneId: string): Scene | null {
  try {
    const memory = loadMemory();
    return findSceneById(memory, sceneId);
  } catch (error) {
    console.error('Failed to get scene:', error);
    return null;
  }
}

export function listScenes(options?: {
  chapter?: string;
  character?: string;
  emotionTag?: string;
}): SceneSummary[] {
  try {
    const memory = loadMemory();
    let scenes = [...memory.scenes];

    // Apply filters
    if (options?.chapter) {
      scenes = scenes.filter(s => s.chapter === options.chapter);
    }

    if (options?.character) {
      scenes = scenes.filter(s => s.characters.includes(options.character!));
    }

    if (options?.emotionTag) {
      scenes = scenes.filter(s => s.emotionTags.includes(options.emotionTag!));
    }

    // Sort by order
    scenes.sort((a, b) => a.order - b.order);

    // Convert to summaries
    return scenes.map(scene => ({
      id: scene.id,
      title: scene.title,
      chapter: scene.chapter,
      order: scene.order,
      characterCount: scene.characters.length,
      cutCount: scene.cuts.length,
      emotionTags: scene.emotionTags
    }));
  } catch (error) {
    console.error('Failed to list scenes:', error);
    return [];
  }
}

// === Cut Management (콘티 컷) ===

export function addCut(sceneId: string, cut: {
  type: "dialogue" | "narration" | "action" | "internal";
  content: string;
  character?: string;
  emotionTag?: string;
}): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    const newCut: Cut = {
      order: scene.cuts.length,
      type: cut.type,
      content: cut.content,
      character: cut.character,
      emotionTag: cut.emotionTag
    };

    scene.cuts.push(newCut);

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to add cut:', error);
    return false;
  }
}

export function updateCut(sceneId: string, cutOrder: number, updates: Partial<Cut>): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    const cut = scene.cuts.find(c => c.order === cutOrder);

    if (!cut) {
      console.error(`Cut not found: order ${cutOrder} in scene ${sceneId}`);
      return false;
    }

    // Apply updates (preserve order)
    Object.assign(cut, {
      ...updates,
      order: cut.order
    });

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to update cut:', error);
    return false;
  }
}

export function removeCut(sceneId: string, cutOrder: number): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    const index = scene.cuts.findIndex(c => c.order === cutOrder);

    if (index === -1) {
      console.error(`Cut not found: order ${cutOrder} in scene ${sceneId}`);
      return false;
    }

    scene.cuts.splice(index, 1);

    // Reorder remaining cuts
    scene.cuts.forEach((cut, idx) => {
      cut.order = idx;
    });

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to remove cut:', error);
    return false;
  }
}

export function reorderCuts(sceneId: string, newOrder: number[]): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    if (newOrder.length !== scene.cuts.length) {
      console.error('New order length does not match cuts length');
      return false;
    }

    // Validate all indices are present
    const sortedOrder = [...newOrder].sort((a, b) => a - b);
    for (let i = 0; i < sortedOrder.length; i++) {
      if (sortedOrder[i] !== i) {
        console.error('Invalid order array: must contain all indices 0 to n-1');
        return false;
      }
    }

    // Reorder cuts
    const reorderedCuts: Cut[] = newOrder.map(oldIdx => scene.cuts[oldIdx]);
    reorderedCuts.forEach((cut, newIdx) => {
      cut.order = newIdx;
    });

    scene.cuts = reorderedCuts;

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to reorder cuts:', error);
    return false;
  }
}

// === Emotion Tags ===

export function addEmotionTag(sceneId: string, tag: string): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    if (scene.emotionTags.includes(tag)) {
      console.warn(`Emotion tag already exists: ${tag}`);
      return true; // Not an error
    }

    scene.emotionTags.push(tag);

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to add emotion tag:', error);
    return false;
  }
}

export function removeEmotionTag(sceneId: string, tag: string): boolean {
  try {
    const memory = loadMemory();
    const scene = findSceneById(memory, sceneId);

    if (!scene) {
      console.error(`Scene not found: ${sceneId}`);
      return false;
    }

    const index = scene.emotionTags.indexOf(tag);

    if (index === -1) {
      console.warn(`Emotion tag not found: ${tag}`);
      return true; // Not an error
    }

    scene.emotionTags.splice(index, 1);

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to remove emotion tag:', error);
    return false;
  }
}

export function getScenesByEmotion(emotionTag: string): Scene[] {
  try {
    const memory = loadMemory();
    return memory.scenes
      .filter(scene => scene.emotionTags.includes(emotionTag))
      .sort((a, b) => a.order - b.order);
  } catch (error) {
    console.error('Failed to get scenes by emotion:', error);
    return [];
  }
}

export function getAllEmotionTags(): { tag: string; count: number }[] {
  try {
    const memory = loadMemory();
    const tagCounts = new Map<string, number>();

    memory.scenes.forEach(scene => {
      scene.emotionTags.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });

    return Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  } catch (error) {
    console.error('Failed to get all emotion tags:', error);
    return [];
  }
}

// === Scene Organization ===

export function reorderScenes(sceneIds: string[]): boolean {
  try {
    const memory = loadMemory();

    if (sceneIds.length !== memory.scenes.length) {
      console.error('Scene IDs length does not match scenes length');
      return false;
    }

    // Validate all IDs exist
    const sceneMap = new Map(memory.scenes.map(s => [s.id, s]));
    for (const id of sceneIds) {
      if (!sceneMap.has(id)) {
        console.error(`Scene not found: ${id}`);
        return false;
      }
    }

    // Reorder scenes
    memory.scenes = sceneIds.map(id => sceneMap.get(id)!);
    memory.scenes.forEach((scene, idx) => {
      scene.order = idx;
    });

    saveMemory(memory);
    return true;
  } catch (error) {
    console.error('Failed to reorder scenes:', error);
    return false;
  }
}

export function getSceneFlow(): SceneFlowEntry[] {
  try {
    const memory = loadMemory();

    return memory.scenes
      .sort((a, b) => a.order - b.order)
      .map(scene => ({
        order: scene.order + 1, // 1-indexed for display
        title: scene.title,
        chapter: scene.chapter,
        primaryEmotion: scene.emotionTags[0] || "감정 미설정",
        characters: scene.characters,
        cutCount: scene.cuts.length
      }));
  } catch (error) {
    console.error('Failed to get scene flow:', error);
    return [];
  }
}

// === Scene Profile Generation ===

export function generateSceneProfile(sceneId: string): string {
  try {
    const scene = getScene(sceneId);

    if (!scene) {
      return `# 오류: 장면을 찾을 수 없습니다 (${sceneId})`;
    }

    let profile = `# 장면: ${scene.title}\n\n`;

    if (scene.chapter) {
      profile += `**챕터**: ${scene.chapter}\n`;
    }

    if (scene.characters.length > 0) {
      profile += `**등장인물**: ${scene.characters.join(', ')}\n`;
    }

    if (scene.emotionTags.length > 0) {
      profile += `**감정 태그**: ${scene.emotionTags.join(', ')}\n`;
    }

    if (scene.narrationTone) {
      profile += `**내레이션 톤**: ${scene.narrationTone}\n`;
    }

    if (scene.notes) {
      profile += `\n**노트**: ${scene.notes}\n`;
    }

    profile += `\n## 컷 구성\n\n`;

    if (scene.cuts.length === 0) {
      profile += `*(컷이 아직 추가되지 않았습니다)*\n`;
    } else {
      scene.cuts.forEach(cut => {
        const typeLabel = CUT_TYPE_LABELS[cut.type] || cut.type;
        const charPart = cut.character ? `/${cut.character}` : '';
        const emotionPart = cut.emotionTag ? ` (감정: ${cut.emotionTag})` : '';

        profile += `${cut.order + 1}. [${typeLabel}${charPart}] ${cut.content}${emotionPart}\n`;
      });
    }

    return profile;
  } catch (error) {
    console.error('Failed to generate scene profile:', error);
    return `# 오류: 장면 프로필 생성 실패`;
  }
}

export function generateSceneList(): string {
  try {
    const memory = loadMemory();

    let list = `## 전체 장면 목록\n\n`;
    list += `| # | 제목 | 챕터 | 감정 | 등장인물 | 컷 수 |\n`;
    list += `|---|------|------|------|---------|-------|\n`;

    if (memory.scenes.length === 0) {
      list += `| - | *(장면이 아직 추가되지 않았습니다)* | - | - | - | - |\n`;
      return list;
    }

    const sortedScenes = [...memory.scenes].sort((a, b) => a.order - b.order);

    sortedScenes.forEach(scene => {
      const sceneNum = scene.order + 1;
      const title = scene.title;
      const chapter = scene.chapter || '-';
      const emotions = scene.emotionTags.length > 0
        ? scene.emotionTags.join(', ')
        : '-';
      const characters = scene.characters.length > 0
        ? scene.characters.join(', ')
        : '-';
      const cutCount = scene.cuts.length;

      list += `| ${sceneNum} | ${title} | ${chapter} | ${emotions} | ${characters} | ${cutCount} |\n`;
    });

    return list;
  } catch (error) {
    console.error('Failed to generate scene list:', error);
    return `## 오류: 장면 목록 생성 실패`;
  }
}

// Export emotion vocabulary for external use
export { EMOTION_VOCABULARY, CUT_TYPE_LABELS };
