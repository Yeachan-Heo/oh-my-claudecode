# CJK IME Input Known Issues

This document describes known issues with CJK (Chinese, Japanese, Korean) IME input in Claude Code CLI and provides workarounds for affected users.

## Table of Contents

- [Overview](#overview)
- [Affected Users](#affected-users)
- [Known Issues](#known-issues)
- [Root Cause](#root-cause)
- [Workarounds](#workarounds)
- [Related Issues](#related-issues)
- [Status](#status)

## Overview

Claude Code CLI uses React Ink for terminal UI rendering. Due to limitations in how terminal raw mode handles IME (Input Method Editor) composition events, CJK users experience various input issues ranging from invisible characters to mispositioned composition text.

## Affected Users

| Language | Input Method | Affected |
|----------|--------------|----------|
| Korean (한국어) | macOS Korean IME | ✅ Yes |
| Korean (한국어) | Windows Korean IME | ✅ Yes |
| Korean (한국어) | Gureumkim (구름) | ✅ Yes |
| Japanese (日本語) | macOS Japanese IME | ✅ Yes |
| Japanese (日本語) | Windows Japanese IME | ✅ Yes |
| Chinese (中文) | macOS Pinyin | ✅ Yes |
| Chinese (中文) | Windows Pinyin | ✅ Yes |
| Vietnamese | Telex | ✅ Yes |

## Known Issues

### 1. Invisible Characters During Composition (Critical)

**Symptom**: When typing CJK characters, nothing appears in the input field during IME composition. Characters only appear after pressing Enter.

**Platforms**: macOS, Linux

**Example (Korean)**:
- Type `ㅎ` → nothing displayed
- Type `ㅎ` + `ㅏ` → nothing displayed  
- Type `ㅎ` + `ㅏ` + `ㄴ` → nothing displayed
- Press Enter → `한` appears in output

### 2. Composition at Wrong Position

**Symptom**: Composing characters appear at the wrong position (e.g., beginning of next line) instead of at the cursor.

**Platforms**: Windows, some macOS terminals

### 3. Performance Issues and Duplicate Candidates

**Symptom**: IME input causes lag, duplicate conversion candidates, or high memory usage.

**Platforms**: All

## Root Cause

The issue stems from three interconnected technical limitations:

### 1. Terminal Raw Mode Limitation

When Node.js operates in raw mode (`process.stdin.setRawMode(true)`), it provides only byte-level STDIN access without:
- Composition event callbacks (`compositionstart`, `compositionupdate`, `compositionend`)
- IME pre-edit buffer information
- Cursor position feedback during composition

### 2. React Ink's TextInput Component

React Ink's TextInput processes individual keystrokes without understanding multi-stage character formation:
- No `isComposing` state tracking
- No separate composition buffer
- Character-by-character processing breaks CJK algorithmic composition

### 3. CJK Character Complexity

CJK languages use algorithmic composition where multiple keystrokes combine into single characters:

**Korean Hangul**:
```
ㄱ + ㅏ → 가
가 + ㄴ → 간
간 + ㅇ → (new syllable)
```

**Japanese Hiragana**:
```
k + a → か
か + n → かn (waiting for next)
かn + a → かな
```

This requires real-time composition display that terminal raw mode cannot provide.

## Workarounds

### Workaround 1: External Editor + Paste (Recommended)

Compose your text in an external editor that handles IME correctly, then paste into Claude Code.

1. Open any text editor (VS Code, Notes, TextEdit, Notepad)
2. Type your CJK text there
3. Copy (`Cmd+C` / `Ctrl+C`)
4. Paste into Claude Code (`Cmd+V` / `Ctrl+V`)

**Pros**: Works 100% reliably
**Cons**: Disrupts workflow, requires switching applications

### Workaround 2: Use English Prompts with CJK Context

When possible, use English for prompts but include CJK text in file contents or references.

```
# Instead of typing Korean directly:
# "한국어로 인사말 작성해줘"

# Use English prompt:
# "Write a greeting message in Korean language"
```

### Workaround 3: Clipboard-based Input Script

Create a script that reads from clipboard and sends to Claude Code:

```bash
# macOS
pbpaste | claude --stdin

# Linux (requires xclip)
xclip -selection clipboard -o | claude --stdin
```

### Workaround 4: Use IDE Integration

Use Claude Code through IDE integrations (VS Code extension) which may handle IME better than raw terminal.

## Related Issues

### oh-my-claudecode
- [#344](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/344) - Korean IME input invisible in input field

### anthropics/claude-code
- [#22732](https://github.com/anthropics/claude-code/issues/22732) - Korean IME: Characters completely invisible during composition
- [#18291](https://github.com/anthropics/claude-code/issues/18291) - Korean IME composition: jamo not displayed until syllable completion
- [#16322](https://github.com/anthropics/claude-code/issues/16322) - [CRITICAL] Korean IME: Composing characters display at wrong position
- [#15705](https://github.com/anthropics/claude-code/issues/15705) - Korean input characters disappear on iOS mobile SSH
- [#1547](https://github.com/anthropics/claude-code/issues/1547) - IME input causes performance issues
- [#3045](https://github.com/anthropics/claude-code/issues/3045) - Investigation: Fixing IME Issues by Patching React Ink

### Upstream (React Ink)
- React Ink's TextInput does not support IME composition state
- Minimal reproduction: https://github.com/takeru/react-ink-ime-bug

### Similar Issues in Other Projects
- [Google Gemini CLI #3014](https://github.com/google-gemini/gemini-cli/issues/3014) - Same issue affects Gemini CLI

## Status

| Fix Area | Status | Notes |
|----------|--------|-------|
| Cursor positioning | ✅ Partially Fixed | August 2025 release improved composition window position |
| Character visibility | ❌ Not Fixed | Characters still invisible during composition |
| Performance | ⚠️ Ongoing | Memory issues being investigated |
| Fundamental fix | 🔄 In Progress | Requires patching React Ink or using alternative input method |

## Contributing

If you have additional workarounds or find a solution, please:

1. Open a PR to update this document
2. Comment on the related GitHub issues
3. Share your findings with the community

## References

- [Terminal-friendly application with Node.js - User Inputs](https://blog.soulserv.net/terminal-friendly-application-with-node-js-part-iii-user-inputs/)
- [React IME Composition Events Issue #8683](https://github.com/facebook/react/issues/8683)
- [Node.js Readline Documentation](https://nodejs.org/api/readline.html)
