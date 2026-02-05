---
name: local-skills-setup
description: Set up and manage local skills for automatic matching and invocation
argument-hint: "[list|add|scan]"
---

## Cross-Platform Compatibility

**IMPORTANT (Windows Git Bash)**: Bash scripts in this template that contain `$(...)` command substitution MUST be executed using a temp file approach to avoid escaping issues:
1. Use the **Write tool** to save the script content to a temporary file (e.g., `/tmp/omc-skills-setup.sh`)
2. Use the **Bash tool** to execute: `bash /tmp/omc-skills-setup.sh`
3. Clean up: `rm -f /tmp/omc-skills-setup.sh`

Do NOT paste scripts containing `$(...)` directly into the Bash tool command parameter.

# Local Skills Setup

This skill provides a guided wizard for setting up and managing your local learned skills. Skills are reusable problem-solving patterns that Claude automatically applies when it detects matching triggers.

## Why Local Skills?

Local skills allow you to capture hard-won insights and solutions that are specific to your codebase or workflow:
- **Project-level skills** (.omc/skills/) - Version-controlled with your repo
- **User-level skills** (~/.claude/skills/omc-learned/) - Portable across all your projects

When you solve a tricky bug or discover a non-obvious workaround, you can extract it as a skill. Claude will automatically detect and apply these skills in future conversations when it sees matching triggers.

## Interactive Workflow

### Step 1: Directory Check and Setup

First, check if skill directories exist and create them if needed:

```bash
# Check and create user-level skills directory
USER_SKILLS_DIR="$HOME/.claude/skills/omc-learned"
if [ -d "$USER_SKILLS_DIR" ]; then
  echo "User skills directory exists: $USER_SKILLS_DIR"
else
  mkdir -p "$USER_SKILLS_DIR"
  echo "Created user skills directory: $USER_SKILLS_DIR"
fi

# Check and create project-level skills directory
PROJECT_SKILLS_DIR=".omc/skills"
if [ -d "$PROJECT_SKILLS_DIR" ]; then
  echo "Project skills directory exists: $PROJECT_SKILLS_DIR"
else
  mkdir -p "$PROJECT_SKILLS_DIR"
  echo "Created project skills directory: $PROJECT_SKILLS_DIR"
fi
```

### Step 2: Skill Scan and Inventory

Scan both directories and show a comprehensive inventory:

```bash
# Scan user-level skills
echo "=== USER-LEVEL SKILLS (~/.claude/skills/omc-learned/) ==="
if [ -d "$HOME/.claude/skills/omc-learned" ]; then
  USER_COUNT=$(find "$HOME/.claude/skills/omc-learned" -name "*.md" 2>/dev/null | wc -l)
  echo "Total skills: $USER_COUNT"

  if [ $USER_COUNT -gt 0 ]; then
    echo ""
    echo "Skills found:"
    find "$HOME/.claude/skills/omc-learned" -name "*.md" -type f -exec sh -c '
      FILE="$1"
      NAME=$(grep -m1 "^name:" "$FILE" 2>/dev/null | sed "s/name: //")
      DESC=$(grep -m1 "^description:" "$FILE" 2>/dev/null | sed "s/description: //")
      MODIFIED=$(stat -c "%y" "$FILE" 2>/dev/null || stat -f "%Sm" "$FILE" 2>/dev/null)
      echo "  - $NAME"
      [ -n "$DESC" ] && echo "    Description: $DESC"
      echo "    Modified: $MODIFIED"
      echo ""
    ' sh {} \;
  fi
else
  echo "Directory not found"
fi

echo ""
echo "=== PROJECT-LEVEL SKILLS (.omc/skills/) ==="
if [ -d ".omc/skills" ]; then
  PROJECT_COUNT=$(find ".omc/skills" -name "*.md" 2>/dev/null | wc -l)
  echo "Total skills: $PROJECT_COUNT"

  if [ $PROJECT_COUNT -gt 0 ]; then
    echo ""
    echo "Skills found:"
    find ".omc/skills" -name "*.md" -type f -exec sh -c '
      FILE="$1"
      NAME=$(grep -m1 "^name:" "$FILE" 2>/dev/null | sed "s/name: //")
      DESC=$(grep -m1 "^description:" "$FILE" 2>/dev/null | sed "s/description: //")
      MODIFIED=$(stat -c "%y" "$FILE" 2>/dev/null || stat -f "%Sm" "$FILE" 2>/dev/null)
      echo "  - $NAME"
      [ -n "$DESC" ] && echo "    Description: $DESC"
      echo "    Modified: $MODIFIED"
      echo ""
    ' sh {} \;
  fi
else
  echo "Directory not found"
fi

# Summary
TOTAL=$((USER_COUNT + PROJECT_COUNT))
echo "=== SUMMARY ==="
echo "Total skills across all directories: $TOTAL"
```

### Step 3: Quick Actions Menu

After scanning, use the AskUserQuestion tool to offer these options:

**Question:** "What would you like to do with your local skills?"

**Options:**
1. **Add new skill** - Start the skill creation wizard
2. **List all skills with details** - Show comprehensive skill inventory with triggers
3. **Scan conversation for patterns** - Analyze current conversation for skill-worthy patterns
4. **Import skill** - Import a skill from URL or paste content
5. **Done** - Exit the wizard

#### Option 1: Add New Skill

If user chooses "Add new skill", invoke the learner skill:

```
Use the Skill tool to invoke: learner
```

This will guide them through the extraction process with quality validation.

#### Option 2: List All Skills with Details

Show detailed information including trigger keywords:

```bash
echo "=== DETAILED SKILL INVENTORY ==="
echo ""

# Function to show skill details
show_skill_details() {
  FILE="$1"
  LOCATION="$2"

  echo "---"
  echo "Location: $LOCATION"
  echo "File: $(basename "$FILE")"

  # Extract frontmatter
  NAME=$(grep -m1 "^name:" "$FILE" 2>/dev/null | sed "s/name: //")
  DESC=$(grep -m1 "^description:" "$FILE" 2>/dev/null | sed "s/description: //")
  TRIGGERS=$(grep -m1 "^triggers:" "$FILE" 2>/dev/null | sed "s/triggers: //")
  QUALITY=$(grep -m1 "^quality:" "$FILE" 2>/dev/null | sed "s/quality: //")

  [ -n "$NAME" ] && echo "Name: $NAME"
  [ -n "$DESC" ] && echo "Description: $DESC"
  [ -n "$TRIGGERS" ] && echo "Triggers: $TRIGGERS"
  [ -n "$QUALITY" ] && echo "Quality: $QUALITY"

  # Last modified
  MODIFIED=$(stat -c "%y" "$FILE" 2>/dev/null | cut -d. -f1 || stat -f "%Sm" "$FILE" 2>/dev/null)
  echo "Last modified: $MODIFIED"
  echo ""
}

# Export function for subshell
export -f show_skill_details

# Show user-level skills
if [ -d "$HOME/.claude/skills/omc-learned" ]; then
  echo "USER-LEVEL SKILLS:"
  find "$HOME/.claude/skills/omc-learned" -name "*.md" -type f -exec bash -c 'show_skill_details "$0" "user-level"' {} \;
fi

# Show project-level skills
if [ -d ".omc/skills" ]; then
  echo "PROJECT-LEVEL SKILLS:"
  find ".omc/skills" -name "*.md" -type f -exec bash -c 'show_skill_details "$0" "project-level"' {} \;
fi
```

#### Option 3: Scan Conversation for Patterns

Analyze the current conversation context to identify potential skill-worthy patterns. Look for:
- Recent debugging sessions with non-obvious solutions
- Tricky bugs that required investigation
- Codebase-specific workarounds discovered
- Error patterns that took time to resolve

Report findings and ask if user wants to extract any as skills.

#### Option 4: Import Skill

Ask user to provide either:
- **URL**: Download skill from a URL (e.g., GitHub gist)
- **Paste content**: Paste skill markdown content directly

Then ask for scope:
- **User-level** (~/.claude/skills/omc-learned/) - Available across all projects
- **Project-level** (.omc/skills/) - Only for this project

Validate the skill format and save to the chosen location.

### Step 4: Skill Templates

Provide quick templates for common skill types. When user wants to create a skill, offer these starting points:

#### Error Solution Template

```markdown
---
id: error-[unique-id]
name: [Error Name]
description: Solution for [specific error in specific context]
source: conversation
triggers: ["error message fragment", "file path", "symptom"]
quality: high
---

# [Error Name]

## The Insight
What is the underlying cause of this error? What principle did you discover?

## Why This Matters
What goes wrong if you don't know this? What symptom led here?

## Recognition Pattern
How do you know when this applies? What are the signs?
- Error message: "[exact error]"
- File: [specific file path]
- Context: [when does this occur]

## The Approach
Step-by-step solution:
1. [Specific action with file/line reference]
2. [Specific action with file/line reference]
3. [Verification step]

## Example
\`\`\`typescript
// Before (broken)
[problematic code]

// After (fixed)
[corrected code]
\`\`\`
```

#### Workflow Skill Template

```markdown
---
id: workflow-[unique-id]
name: [Workflow Name]
description: Process for [specific task in this codebase]
source: conversation
triggers: ["task description", "file pattern", "goal keyword"]
quality: high
---

# [Workflow Name]

## The Insight
What makes this workflow different from the obvious approach?

## Why This Matters
What fails if you don't follow this process?

## Recognition Pattern
When should you use this workflow?
- Task type: [specific task]
- Files involved: [specific patterns]
- Indicators: [how to recognize]

## The Approach
1. [Step with specific commands/files]
2. [Step with specific commands/files]
3. [Verification]

## Gotchas
- [Common mistake and how to avoid it]
- [Edge case and how to handle it]
```

#### Code Pattern Template

```markdown
---
id: pattern-[unique-id]
name: [Pattern Name]
description: Pattern for [specific use case in this codebase]
source: conversation
triggers: ["code pattern", "file type", "problem domain"]
quality: high
---

# [Pattern Name]

## The Insight
What's the key principle behind this pattern?

## Why This Matters
What problems does this pattern solve in THIS codebase?

## Recognition Pattern
When do you apply this pattern?
- File types: [specific files]
- Problem: [specific problem]
- Context: [codebase-specific context]

## The Approach
Decision-making heuristic, not just code:
1. [Principle-based step]
2. [Principle-based step]

## Example
\`\`\`typescript
[Illustrative example showing the principle]
\`\`\`

## Anti-Pattern
What NOT to do and why:
\`\`\`typescript
[Common mistake to avoid]
\`\`\`
```

#### Integration Skill Template

```markdown
---
id: integration-[unique-id]
name: [Integration Name]
description: How [system A] integrates with [system B] in this codebase
source: conversation
triggers: ["system name", "integration point", "config file"]
quality: high
---

# [Integration Name]

## The Insight
What's non-obvious about how these systems connect?

## Why This Matters
What breaks if you don't understand this integration?

## Recognition Pattern
When are you working with this integration?
- Files: [specific integration files]
- Config: [specific config locations]
- Symptoms: [what indicates integration issues]

## The Approach
How to work with this integration correctly:
1. [Configuration step with file paths]
2. [Setup step with specific details]
3. [Verification step]

## Gotchas
- [Integration-specific pitfall #1]
- [Integration-specific pitfall #2]
```

## Usage Modes

### Direct Command Mode

When invoked with an argument, skip the interactive wizard:

- `/oh-my-claudecode:local-skills-setup list` - Show detailed skill inventory
- `/oh-my-claudecode:local-skills-setup add` - Start skill creation (invoke learner)
- `/oh-my-claudecode:local-skills-setup scan` - Scan both skill directories

### Interactive Mode

When invoked without arguments, run the full guided wizard (Steps 1-4).

## Skill Quality Guidelines

Remind users that good skills are:

1. **Non-Googleable** - Can't easily find via search
   - BAD: "How to read files in TypeScript" ❌
   - GOOD: "This codebase uses custom path resolution requiring fileURLToPath" ✓

2. **Context-Specific** - References actual files/errors from THIS codebase
   - BAD: "Use try/catch for error handling" ❌
   - GOOD: "The aiohttp proxy in server.py:42 crashes on ClientDisconnectedError" ✓

3. **Actionable with Precision** - Tells exactly WHAT to do and WHERE
   - BAD: "Handle edge cases" ❌
   - GOOD: "When seeing 'Cannot find module' in dist/, check tsconfig.json moduleResolution" ✓

4. **Hard-Won** - Required significant debugging effort
   - BAD: Generic programming patterns ❌
   - GOOD: "Race condition in worker.ts - Promise.all at line 89 needs await" ✓

## Benefits of Local Skills

When introducing the skill system, explain these benefits:

**Automatic Application**: Claude detects triggers and applies skills automatically - no need to remember or search for solutions.

**Version Control**: Project-level skills (.omc/skills/) are committed with your code, so the whole team benefits.

**Evolving Knowledge**: Skills improve over time as you discover better approaches and refine triggers.

**Reduced Token Usage**: Instead of re-solving the same problems, Claude applies known patterns efficiently.

**Codebase Memory**: Preserves institutional knowledge that would otherwise be lost in conversation history.

## Related Skills

- `/oh-my-claudecode:learner` - Extract a skill from current conversation
- `/oh-my-claudecode:note` - Save quick notes (less formal than skills)
- `/oh-my-claudecode:deepinit` - Generate AGENTS.md codebase hierarchy

## Example Session

Show users what a typical session looks like:

```
> /oh-my-claudecode:local-skills-setup

Checking skill directories...
✓ User skills directory exists: ~/.claude/skills/omc-learned/
✓ Project skills directory exists: .omc/skills/

Scanning for skills...

=== USER-LEVEL SKILLS ===
Total skills: 3
  - async-network-error-handling
    Description: Pattern for handling independent I/O failures in async network code
    Modified: 2026-01-20 14:32:15

  - esm-path-resolution
    Description: Custom path resolution in ESM requiring fileURLToPath
    Modified: 2026-01-19 09:15:42

=== PROJECT-LEVEL SKILLS ===
Total skills: 5
  - session-timeout-fix
    Description: Fix for sessionId undefined after restart in session.ts
    Modified: 2026-01-22 16:45:23

  - build-cache-invalidation
    Description: When to clear TypeScript build cache to fix phantom errors
    Modified: 2026-01-21 11:28:37

=== SUMMARY ===
Total skills: 8

What would you like to do?
1. Add new skill
2. List all skills with details
3. Scan conversation for patterns
4. Import skill
5. Done
```

## Tips for Users

- Run `/oh-my-claudecode:local-skills-setup scan` periodically to review your skill library
- After solving a tricky bug, immediately run learner to capture it
- Use project-level skills for codebase-specific knowledge
- Use user-level skills for general patterns that apply everywhere
- Review and refine triggers over time to improve matching accuracy
