---
name: writer-memory
description: Agentic memory system for writers - track characters, relationships, scenes, and themes
argument-hint: "init|char|rel|scene|query|validate|synopsis|status|export [args]"
---

# Writer Memory - Agentic Memory System for Writers

Persistent memory system designed for creative writers, with first-class support for Korean storytelling workflows.

## Overview

Writer Memory maintains context across Claude sessions for fiction writers. It tracks:

- **Characters (캐릭터)**: Emotional arcs (감정궤도), attitudes (태도), dialogue tone (대사톤), speech levels
- **World (세계관)**: Settings, rules, atmosphere, constraints
- **Relationships (관계)**: Character dynamics and evolution over time
- **Scenes (장면)**: Cut composition (컷구성), narration tone, emotional tags
- **Themes (테마)**: Emotional themes (정서테마), authorial intent

All data persists in `.writer-memory/memory.json` for git-friendly collaboration.

## Commands

| Command | Action |
|---------|--------|
| `/oh-my-claudecode:writer-memory init <project-name>` | Initialize new project memory |
| `/oh-my-claudecode:writer-memory status` | Show memory overview (character count, scene count, etc) |
| `/oh-my-claudecode:writer-memory char add <name>` | Add new character |
| `/oh-my-claudecode:writer-memory char <name>` | View character details |
| `/oh-my-claudecode:writer-memory char update <name> <field> <value>` | Update character field |
| `/oh-my-claudecode:writer-memory char list` | List all characters |
| `/oh-my-claudecode:writer-memory rel add <char1> <char2> <type>` | Add relationship |
| `/oh-my-claudecode:writer-memory rel <char1> <char2>` | View relationship |
| `/oh-my-claudecode:writer-memory rel update <char1> <char2> <event>` | Add relationship event |
| `/oh-my-claudecode:writer-memory scene add <title>` | Add new scene |
| `/oh-my-claudecode:writer-memory scene <id>` | View scene details |
| `/oh-my-claudecode:writer-memory scene list` | List all scenes |
| `/oh-my-claudecode:writer-memory theme add <name>` | Add theme |
| `/oh-my-claudecode:writer-memory world set <field> <value>` | Set world attribute |
| `/oh-my-claudecode:writer-memory query <question>` | Query memory naturally (Korean supported) |
| `/oh-my-claudecode:writer-memory validate <character> <dialogue>` | Check if dialogue matches character tone |
| `/oh-my-claudecode:writer-memory synopsis` | Generate emotion-focused synopsis |
| `/oh-my-claudecode:writer-memory export` | Export full memory as readable markdown |
| `/oh-my-claudecode:writer-memory backup` | Create manual backup |

## Memory Types

### 캐릭터 메모리 (Character Memory)

Tracks individual character attributes essential for consistent portrayal:

| Field | Korean | Description |
|-------|--------|-------------|
| `arc` | 감정궤도 | Emotional journey (e.g., "체념 -> 욕망자각 -> 선택") |
| `attitude` | 태도 | Current disposition toward life/others |
| `tone` | 대사톤 | Dialogue style (e.g., "담백", "직설적", "회피적") |
| `speechLevel` | 말투 레벨 | Formality: 반말, 존댓말, 해체, 혼합 |
| `keywords` | 핵심 단어 | Characteristic words/phrases they use |
| `taboo` | 금기어 | Words/phrases they would never say |
| `emotional_baseline` | 감정 기준선 | Default emotional state |
| `triggers` | 트리거 | What provokes emotional reactions |

**Example:**
```
/writer-memory char add 새랑
/writer-memory char update 새랑 arc "체념 -> 욕망자각 -> 선택"
/writer-memory char update 새랑 tone "담백, 현재충실, 감정억제"
/writer-memory char update 새랑 speechLevel "해체"
/writer-memory char update 새랑 keywords "그냥, 뭐, 괜찮아"
/writer-memory char update 새랑 taboo "사랑해, 보고싶어"
```

### 세계관 메모리 (World Memory)

Establishes the universe your story inhabits:

| Field | Korean | Description |
|-------|--------|-------------|
| `setting` | 배경 | Time, place, social context |
| `rules` | 규칙 | How the world operates (magic systems, social norms) |
| `atmosphere` | 분위기 | Overall mood and tone |
| `constraints` | 제약 | What cannot happen in this world |
| `history` | 역사 | Relevant backstory |

### 관계 메모리 (Relationship Memory)

Captures the dynamic between characters over time:

| Field | Description |
|-------|-------------|
| `type` | Base relationship: romantic, familial, friendship, rivalry, professional |
| `status` | Current state: budding, stable, strained, broken, healing |
| `power_dynamic` | Who has the upper hand, if any |
| `events` | Timeline of relationship-changing moments |
| `tension` | Current unresolved conflicts |
| `intimacy_level` | Emotional closeness (1-10) |

**Example:**
```
/writer-memory rel add 새랑 해랑 romantic
/writer-memory rel update 새랑 해랑 "첫 키스 - 새랑 회피"
/writer-memory rel update 새랑 해랑 "해랑 고백 거절당함"
/writer-memory rel update 새랑 해랑 "새랑 먼저 손 잡음"
```

### 장면 메모리 (Scene Memory)

Tracks individual scenes and their emotional architecture:

| Field | Korean | Description |
|-------|--------|-------------|
| `title` | 제목 | Scene identifier |
| `characters` | 등장인물 | Who appears |
| `location` | 장소 | Where it happens |
| `cuts` | 컷 구성 | Shot-by-shot breakdown |
| `narration_tone` | 내레이션 톤 | Narrative voice style |
| `emotional_tag` | 감정 태그 | Primary emotions (e.g., "설렘+불안") |
| `purpose` | 목적 | Why this scene exists in the story |
| `before_after` | 전후 변화 | What changes for characters |

### 테마 메모리 (Theme Memory)

Captures the deeper meaning woven through your story:

| Field | Korean | Description |
|-------|--------|-------------|
| `name` | 이름 | Theme identifier |
| `expression` | 표현 방식 | How this theme manifests |
| `scenes` | 관련 장면 | Scenes that embody this theme |
| `character_links` | 캐릭터 연결 | Which characters carry this theme |
| `author_intent` | 작가 의도 | What you want readers to feel |

## Synopsis Generation (시놉시스)

The `/synopsis` command generates an emotion-focused summary using 5 essential elements:

### 5 Essential Elements (시놉시스 5요소)

1. **주인공 태도 요약** (Protagonist Attitude Summary)
   - How the protagonist approaches life/love/conflict
   - Their core emotional stance
   - Example: "새랑은 상실을 예방하기 위해 먼저 포기하는 사람"

2. **관계 핵심 구도** (Core Relationship Structure)
   - The central dynamic driving the story
   - Power imbalances and tensions
   - Example: "사랑받는 자와 사랑하는 자의 불균형"

3. **정서적 테마** (Emotional Theme)
   - The feeling the story evokes
   - Not plot, but emotional truth
   - Example: "손에 쥔 행복을 믿지 못하는 불안"

4. **장르 vs 실제감정 대비** (Genre vs Real Emotion Contrast)
   - Surface genre expectations vs. actual emotional content
   - Example: "로맨스지만 본질은 자기수용 서사"

5. **엔딩 정서 잔상** (Ending Emotional Aftertaste)
   - The lingering feeling after the story ends
   - Example: "씁쓸한 안도, 불완전한 해피엔딩의 여운"

## Character Validation (캐릭터 검증)

The `/validate` command checks if dialogue matches a character's established voice.

### What Gets Checked

| Check | Description |
|-------|-------------|
| **Speech Level** | Does formality match? (반말/존댓말/해체) |
| **Tone Match** | Does the emotional register fit? |
| **Keyword Usage** | Uses characteristic words? |
| **Taboo Violation** | Uses forbidden words? |
| **Emotional Range** | Within character's baseline? |
| **Context Fit** | Appropriate for relationship and scene? |

### Validation Results

- **PASS**: Dialogue is consistent with character
- **WARN**: Minor inconsistencies, may be intentional
- **FAIL**: Significant deviation from established voice

**Example:**
```
/writer-memory validate 새랑 "사랑해, 해랑아. 너무 보고싶었어."
```
Output:
```
[FAIL] 새랑 validation failed:
- TABOO: "사랑해" - character avoids direct declarations
- TABOO: "보고싶었어" - character suppresses longing expressions
- TONE: Too emotionally direct for 새랑's 담백 style

Suggested alternatives:
- "...왔네." (minimal acknowledgment)
- "늦었다." (deflection to external fact)
- "밥 먹었어?" (care expressed through practical concern)
```

## Context Query (맥락 질의)

Natural language queries against memory, with full Korean support.

### Example Queries

```
/writer-memory query "새랑은 이 상황에서 뭐라고 할까?"
/writer-memory query "규리의 현재 감정 상태는?"
/writer-memory query "해랑과 새랑의 관계는 어디까지 왔나?"
/writer-memory query "이 장면의 정서적 분위기는?"
/writer-memory query "새랑이 먼저 연락하는 게 맞아?"
/writer-memory query "해랑이 화났을 때 말투는?"
```

The system synthesizes answers from all relevant memory types.

## Behavior

1. **On Init**: Creates `.writer-memory/memory.json` with project metadata and empty collections
2. **Auto-Backup**: Changes are backed up before modification to `.writer-memory/backups/`
3. **Korean-First**: Emotion vocabulary uses Korean terms throughout
4. **Session Loading**: Memory is loaded on session start for immediate context
5. **Git-Friendly**: JSON formatted for clean diffs and collaboration

## Integration

### With OMC Notepad System
Writer Memory integrates with `.omc/notepad.md`:
- Scene ideas can be captured as notes
- Character insights from analysis sessions are preserved
- Cross-reference between notepad and memory

### With Architect Agent
For complex character analysis:
```
Task(subagent_type="oh-my-claudecode:architect",
     model="opus",
     prompt="Analyze 새랑's arc across all scenes...")
```

### Character Validation Pipeline
Validation pulls context from:
- Character memory (tone, keywords, taboo)
- Relationship memory (dynamics with dialogue partner)
- Scene memory (current emotional context)
- Theme memory (authorial intent)

### Synopsis Builder
Synopsis generation aggregates:
- All character arcs
- Key relationship events
- Scene emotional tags
- Theme expressions

## Examples

### Full Workflow

```
# Initialize project
/writer-memory init 봄의 끝자락

# Add characters
/writer-memory char add 새랑
/writer-memory char update 새랑 arc "체념 -> 욕망자각 -> 선택"
/writer-memory char update 새랑 tone "담백, 현재충실"
/writer-memory char update 새랑 speechLevel "해체"

/writer-memory char add 해랑
/writer-memory char update 해랑 arc "확신 -> 동요 -> 기다림"
/writer-memory char update 해랑 tone "직진, 솔직"
/writer-memory char update 해랑 speechLevel "반말"

# Establish relationship
/writer-memory rel add 새랑 해랑 romantic
/writer-memory rel update 새랑 해랑 "첫 만남 - 해랑 일방적 호감"
/writer-memory rel update 새랑 해랑 "새랑 거절"
/writer-memory rel update 새랑 해랑 "재회 - 새랑 내적 동요"

# Set world
/writer-memory world set setting "서울, 현대, 20대 후반 직장인"
/writer-memory world set atmosphere "도시의 건조함 속 미묘한 온기"

# Add themes
/writer-memory theme add "포기하지 않는 사랑"
/writer-memory theme add "자기 보호의 벽"

# Add scene
/writer-memory scene add "옥상 재회"

# Query for writing
/writer-memory query "새랑은 이별 장면에서 어떤 톤으로 말할까?"

# Validate dialogue
/writer-memory validate 새랑 "해랑아, 그만하자."

# Generate synopsis
/writer-memory synopsis

# Export for reference
/writer-memory export
```

### Quick Character Check

```
/writer-memory char 새랑
```

Output:
```
## 새랑

**Arc (감정궤도):** 체념 -> 욕망자각 -> 선택
**Attitude (태도):** 방어적, 현실주의
**Tone (대사톤):** 담백, 현재충실
**Speech Level (말투):** 해체
**Keywords (핵심어):** 그냥, 뭐, 괜찮아
**Taboo (금기어):** 사랑해, 보고싶어

**Relationships:**
- 해랑: romantic (intimacy: 6/10, status: healing)

**Scenes Appeared:** 옥상 재회, 카페 대화, 마지막 선택
```

## Storage Schema

```json
{
  "version": "1.0",
  "project": {
    "name": "봄의 끝자락",
    "genre": "로맨스",
    "created": "2024-01-15T09:00:00Z",
    "lastModified": "2024-01-20T14:30:00Z"
  },
  "characters": {
    "새랑": {
      "arc": "체념 -> 욕망자각 -> 선택",
      "attitude": "방어적, 현실주의",
      "tone": "담백, 현재충실",
      "speechLevel": "해체",
      "keywords": ["그냥", "뭐", "괜찮아"],
      "taboo": ["사랑해", "보고싶어"],
      "emotional_baseline": "평온한 무관심",
      "triggers": ["과거 언급", "미래 약속"]
    }
  },
  "world": {
    "setting": "서울, 현대, 20대 후반 직장인",
    "rules": [],
    "atmosphere": "도시의 건조함 속 미묘한 온기",
    "constraints": [],
    "history": ""
  },
  "relationships": [
    {
      "id": "rel_001",
      "from": "새랑",
      "to": "해랑",
      "type": "romantic",
      "dynamic": "해랑 주도 → 균형",
      "speechLevel": "반말",
      "evolution": [
        { "timestamp": "...", "change": "첫 만남 - 해랑 일방적 호감", "catalyst": "우연한 만남" },
        { "timestamp": "...", "change": "새랑 거절", "catalyst": "과거 트라우마" },
        { "timestamp": "...", "change": "재회 - 새랑 내적 동요", "catalyst": "옥상에서 재회" }
      ],
      "notes": "새랑의 불신 vs 해랑의 기다림",
      "created": "..."
    }
  ],
  "scenes": [
    {
      "id": "scene-001",
      "title": "옥상 재회",
      "characters": ["새랑", "해랑"],
      "location": "회사 옥상",
      "cuts": ["해랑 먼저 발견", "새랑 굳은 표정", "침묵", "해랑 먼저 말 걸기"],
      "narration_tone": "건조체",
      "emotional_tag": "긴장+그리움",
      "purpose": "재회의 어색함과 남은 감정 암시",
      "before_after": "새랑: 무관심 -> 동요"
    }
  ],
  "themes": [
    {
      "name": "포기하지 않는 사랑",
      "expression": "해랑의 일관된 태도",
      "scenes": ["옥상 재회", "마지막 고백"],
      "character_links": ["해랑"],
      "author_intent": "집착이 아닌 믿음의 사랑"
    }
  ],
  "synopsis": {
    "protagonist_attitude": "새랑은 상실을 예방하기 위해 먼저 포기하는 사람",
    "relationship_structure": "기다리는 자와 도망치는 자의 줄다리기",
    "emotional_theme": "사랑받을 자격에 대한 의심",
    "genre_contrast": "로맨스지만 본질은 자기수용 서사",
    "ending_aftertaste": "불완전하지만 따뜻한 선택의 여운"
  }
}
```

## File Structure

```
.writer-memory/
├── memory.json          # Main memory file
├── backups/             # Auto-backups before changes
│   ├── memory-2024-01-15-090000.json
│   └── memory-2024-01-20-143000.json
└── exports/             # Markdown exports
    └── export-2024-01-20.md
```

## Tips for Writers

1. **Start with Characters**: Build character memories before scenes
2. **Update Relationships After Key Scenes**: Track evolution actively
3. **Use Validation While Writing**: Catch voice inconsistencies early
4. **Query Before Difficult Scenes**: Let the system remind you of context
5. **Regular Synopsis**: Generate periodically to check thematic coherence
6. **Backup Before Major Changes**: Use `/backup` before significant story pivots

## Troubleshooting

**Memory not loading?**
- Check `.writer-memory/memory.json` exists
- Verify JSON syntax is valid
- Run `/writer-memory status` to diagnose

**Validation too strict?**
- Review taboo list for unintended entries
- Consider if character is growing (arc progression)
- Intentional breaks from pattern are valid for dramatic moments

**Query not finding context?**
- Ensure relevant data is in memory
- Try more specific queries
- Check character names match exactly
