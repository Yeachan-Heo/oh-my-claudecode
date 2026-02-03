# Project Memory Hook - Implementation Summary

## Overview

Successfully implemented a comprehensive project memory system that auto-detects project environment and **ensures user directives survive compaction** - addressing the key sponsor pain point.

## ✅ Core Features Implemented

### 1. Auto-Detection (Phase 1 - Complete)
- **Languages**: TypeScript, JavaScript, Rust, Python, Go, Java, etc.
- **Frameworks**: React, Next.js, Vue, Express, FastAPI, axum, etc.
- **Package Managers**: pnpm, npm, yarn, cargo, poetry, etc.
- **Build Commands**: Automatically extracted from package.json, Cargo.toml, etc.
- **Project Structure**: Monorepo detection, workspace identification

### 2. Context Injection (Phase 2 - Complete)
- Injects concise project summary via `contextCollector`
- High-priority context registration
- Session-based deduplication (no duplicate injection per session)
- Format: `[Project Environment] TypeScript/React using pnpm | Build: pnpm build | Test: pnpm test`

### 3. Incremental Learning (Phase 3 - Complete)
- **Build Command Learning**: Detects `pnpm build`, `cargo build`, etc. from Bash tool usage
- **Test Command Learning**: Detects `pytest`, `cargo test`, etc.
- **Environment Hints**: Extracts Node.js/Python/Rust versions from command output
- **Missing Dependencies**: Detects "Cannot find module" errors
- **Environment Variables**: Detects required env var errors

### 4. **🎯 Compaction Resilience (Phase 4 - NEW - Complete)**

#### **User Directives** - THE KEY FEATURE
- **Auto-Detection**: Recognizes directive patterns in user messages:
  - "only look at X"
  - "always use Y"
  - "never modify Z"
  - "focus on A"
  - "prioritize B"
- **Manual Directives**: Can be added programmatically
- **Persistence**: Stored in `.omc/project-memory.json`
- **Priority Levels**: High (critical) vs Normal
- **Compaction Survival**: Re-injected via PreCompact hook

#### **Hot Path Tracking**
- Tracks frequently accessed files and directories
- Built from Read/Edit/Write/Glob/Grep tool usage
- Sorted by access count
- Decays over time (7-day window)
- Max 50 hot paths tracked

#### **Directory Mapping**
- Auto-detects directory purposes (src/, config/, tests/, etc.)
- Tracks file counts and key files
- Two-level deep scanning
- Patterns: 60+ common directory types recognized

#### **PreCompact Hook**
- Executes before context compaction
- Exports critical state to systemMessage
- **Ensures user directives survive compaction**
- Re-injects: directives, hot paths, tech stack, key directories

## 📁 File Structure

```
src/hooks/project-memory/
├── index.ts                 # Main orchestrator + context registration
├── types.ts                 # TypeScript interfaces (expanded)
├── constants.ts             # Detection patterns, config paths
├── detector.ts              # Auto-detection logic (expanded)
├── storage.ts               # Read/write .omc/project-memory.json
├── formatter.ts             # Context string generation (expanded)
├── learner.ts               # PostToolUse incremental learning (expanded)
├── directory-mapper.ts      # NEW: Directory structure detection
├── hot-path-tracker.ts      # NEW: Frequent file/dir tracking
├── directive-detector.ts    # NEW: User directive extraction
├── pre-compact.ts           # NEW: Compaction resilience
└── __tests__/
    ├── detector.test.ts     # 6 tests
    ├── formatter.test.ts    # 6 tests
    ├── storage.test.ts      # 11 tests
    ├── learner.test.ts      # 13 tests
    └── integration.test.ts  # 8 tests

scripts/
├── project-memory-session.mjs      # SessionStart hook
├── project-memory-posttool.mjs     # PostToolUse hook
└── project-memory-precompact.mjs   # NEW: PreCompact hook
```

## 🔧 Hook Integration

### hooks/hooks.json
```json
{
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [
        {"command": "node scripts/session-start.mjs", "timeout": 5},
        {"command": "node scripts/project-memory-session.mjs", "timeout": 5}
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {"command": "node scripts/post-tool-verifier.mjs", "timeout": 3},
        {"command": "node scripts/project-memory-posttool.mjs", "timeout": 3}
      ]
    }
  ],
  "PreCompact": [
    {
      "matcher": "*",
      "hooks": [
        {"command": "node scripts/pre-compact.mjs", "timeout": 10},
        {"command": "node scripts/project-memory-precompact.mjs", "timeout": 5}
      ]
    }
  ]
}
```

## 📊 Data Schema

```typescript
interface ProjectMemory {
  version: string;
  lastScanned: number;
  projectRoot: string;

  // Original fields
  techStack: TechStack;
  build: BuildInfo;
  conventions: CodeConventions;
  structure: ProjectStructure;
  customNotes: CustomNote[];

  // NEW: Compaction resilience fields
  directoryMap: Record<string, DirectoryInfo>;  // Key directories + purposes
  hotPaths: HotPath[];                          // Frequently accessed files
  userDirectives: UserDirective[];              // CRITICAL: User instructions
}

interface UserDirective {
  timestamp: number;
  directive: string;           // "only look at symbol=perpetual"
  context: string;            // Full sentence where it appeared
  source: 'explicit' | 'inferred';
  priority: 'high' | 'normal';
}

interface HotPath {
  path: string;
  accessCount: number;
  lastAccessed: number;
  type: 'file' | 'directory';
}

interface DirectoryInfo {
  path: string;
  purpose: string | null;      // "Source code", "Test files", etc.
  fileCount: number;
  lastAccessed: number;
  keyFiles: string[];
}
```

## 🎯 Context Injection Format (with directives)

```
**User Directives (Must Follow):**

🔴 **Critical:**
- only look at symbol=perpetual
- never modify config files

- focus on authentication module
- prioritize performance over readability

**Frequently Accessed:**
- src/auth/index.ts (42x)
- src/config/database.ts (18x)
- tests/auth.test.ts (12x)

**Key Directories:**
- src: Source code
- tests: Test files
- config: Configuration files

[Project Environment] TypeScript/React using pnpm | Build: pnpm build | Test: pnpm test
```

## 📦 Storage

- **Location**: `<project-root>/.omc/project-memory.json`
- **Cache Expiry**: 24 hours
- **Session Deduplication**: Tracks injected projects per session
- **Incremental Updates**: Saves on every learning event

## ✅ Test Coverage

- **Total Tests**: 44 tests across 5 test files
- **All Passing**: ✓ 100% pass rate
- **Coverage**: Storage, Detection, Formatting, Learning, Integration
- **Test Fixtures**: TypeScript+pnpm, Rust+Cargo, Python+Poetry scenarios

## 🔥 Key Innovations

### 1. **Compaction Resilience** (Sponsor-Requested)
The critical problem: User says "only look at symbol=perpetual" → compaction happens → AI forgets.

**Solution**:
- Directive detector recognizes instruction patterns
- Stores in persistent `.omc/project-memory.json`
- PreCompact hook re-injects into systemMessage
- **Directives survive compaction and persist across sessions**

### 2. **Hot Path Intelligence**
- Tracks which files/directories the user actually works on
- Helps AI focus on relevant code
- Decays over time (don't get stuck on old code)

### 3. **Directory Purpose Mapping**
- Automatically understands project structure
- Knows `src/` is source code, `tests/` is tests, etc.
- 60+ recognized patterns

### 4. **Multi-Tool Learning**
- Learns from Bash (commands)
- Learns from Read/Edit/Write (file access)
- Learns from Glob/Grep (directory access)
- Learns from user messages (directives)

## 🚀 Usage

### Automatic (Zero Configuration)
1. Start session in a project → auto-detects environment
2. Run commands → learns build/test patterns
3. Give instructions → detects and saves directives
4. Compaction happens → directives re-injected
5. **User instructions never get lost**

### Manual
```typescript
// Force rescan
await rescanProjectEnvironment(projectRoot);

// Add custom directive
await addCustomNote(projectRoot, 'deploy', 'Requires Docker');

// Add directive explicitly
const directive = {
  timestamp: Date.now(),
  directive: 'only use async/await, no callbacks',
  context: 'User coding style preference',
  source: 'explicit',
  priority: 'high',
};
```

## 🎓 Examples

### Example 1: TypeScript + React + pnpm
**Detected**:
- Language: TypeScript (5.3.3)
- Framework: React (18.2.0), Vite (5.0.0)
- Package Manager: pnpm
- Build: `pnpm build`
- Test: `pnpm test`

### Example 2: Rust + Cargo + axum
**Detected**:
- Language: Rust
- Framework: axum (backend)
- Package Manager: cargo
- Build: `cargo build`
- Test: `cargo test`
- Lint: `cargo clippy`

### Example 3: Python + Poetry + FastAPI
**Detected**:
- Language: Python
- Framework: FastAPI
- Package Manager: poetry
- Test: `pytest`
- Lint: `ruff check`

## 🔍 Verification

### Manual Testing
```bash
# 1. SessionStart injection
cd <project> && echo '{"directory":"'$(pwd)'","sessionId":"test"}' | \
  node scripts/project-memory-session.mjs

# 2. Verify memory file
cat .omc/project-memory.json

# 3. PostToolUse learning
echo '{"toolName":"Bash","toolInput":{"command":"pnpm build"},"toolOutput":"","directory":"'$(pwd)'"}' | \
  node scripts/project-memory-posttool.mjs

# 4. PreCompact resilience
echo '{"session_id":"test","cwd":"'$(pwd)'","hook_event_name":"PreCompact","trigger":"auto"}' | \
  node scripts/project-memory-precompact.mjs
```

### Automated Testing
```bash
npm test -- src/hooks/project-memory/__tests__/ --run
# Result: ✓ 44 tests passed
```

## 📈 Success Metrics

✅ **All 44 tests passing**
✅ **Zero TypeScript errors**
✅ **All hook scripts executable**
✅ **Context injection working**
✅ **Learning from tool usage working**
✅ **Compaction resilience implemented**
✅ **User directives preserved**
✅ **Hot path tracking functional**
✅ **Directory mapping complete**

## 🎯 Impact

### Problem Solved
**Before**: User gives instructions → compaction happens → instructions lost → AI asks for instructions again

**After**: User gives instructions → stored in project memory → compaction happens → instructions re-injected → **AI remembers forever**

### Additional Benefits
1. **Auto-detects** project environment (no manual setup)
2. **Learns** build/test commands (no need to specify)
3. **Tracks** frequently accessed files (helps AI focus)
4. **Understands** project structure (knows where things are)
5. **Survives compaction** (critical instructions never lost)

## 🔗 Integration with OMC

- Uses existing `contextCollector` API
- Follows `learner` and `beads-context` patterns
- Uses existing `findProjectRoot()` utility
- Integrates with `PreCompact` hook system
- Follows OMC state management conventions

## 📝 Next Steps (Optional Enhancements)

1. **Per-workspace memory** for monorepos
2. **Git branch-specific** directives
3. **Team-shared** directives via git
4. **Directive expiry** for temporary instructions
5. **ML-based** directive inference
6. **Directive conflicts** resolution
7. **Visual dashboard** for project memory

## 🎉 Conclusion

Successfully implemented a comprehensive project memory system with **compaction resilience** as the core innovation. User directives, hot paths, and project context now survive compaction, solving the sponsor's primary pain point: instructions getting lost after compaction.

All 44 tests passing, zero errors, production-ready code following OMC patterns.
