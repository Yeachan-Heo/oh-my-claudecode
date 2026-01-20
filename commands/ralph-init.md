---
description: Initialize a PRD (Product Requirements Document) for structured ralph execution
---

[RALPH-INIT - PRD CREATION MODE]

$ARGUMENTS

## What is PRD?

A PRD (Product Requirements Document) structures your task into discrete user stories, each with:
- **ID**: Unique identifier (US-001, US-002, etc.)
- **Title**: Short description
- **Description**: Full user story
- **Acceptance Criteria**: What must be true for completion
- **Priority**: Execution order (1 = highest)
- **passes**: Boolean tracking completion

## Your Task

Create a `prd.json` file in `.sisyphus/` directory based on the task description provided.

### Step 1: Analyze the Task

Break down the task into small, focused user stories. Each story should be:
- Completable in one focused session
- Independently testable
- Clear about what "done" looks like

**Right-sized stories:**
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

**Too big (split these):**
- "Build the entire dashboard"
- "Add authentication"
- "Refactor the API"

### Step 2: Create prd.json

Write the file to `.sisyphus/prd.json` with this structure:

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Overall feature description]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want to [action] so that [benefit].",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### Step 3: Initialize Progress Log

Also create `.sisyphus/progress.txt`:

```
# Ralph Progress Log
Started: [ISO timestamp]

## Codebase Patterns
(No patterns discovered yet)

---

```

### Step 4: Report

After creating the files, output a summary:

```
PRD Created Successfully!

Project: [name]
Branch: [branch]
Stories: [count]

Stories to implement:
1. [US-001] - [title]
2. [US-002] - [title]
...

Run `/ralph` to start working through these stories.
```

## Quality Guidelines

1. **Acceptance criteria should be verifiable** - Include "Typecheck passes" and "Tests pass" where applicable
2. **Include browser verification for UI stories** - "Verify in browser" for frontend work
3. **Keep stories independent** - Avoid dependencies between stories when possible
4. **Order by priority** - Put foundational work (database, types) before UI

## Example PRD

For task: "Add user profile editing with avatar upload"

```json
{
  "project": "MyApp",
  "branchName": "ralph/user-profile-edit",
  "description": "Allow users to edit their profile information and upload avatars",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add avatar field to user model",
      "description": "As a developer, I need to store avatar URLs in the database.",
      "acceptanceCriteria": [
        "Add avatar_url column to users table",
        "Generate and run migration",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false
    },
    {
      "id": "US-002",
      "title": "Create profile edit form",
      "description": "As a user, I want to edit my profile details.",
      "acceptanceCriteria": [
        "Form with name, bio, email fields",
        "Pre-populated with current values",
        "Submit updates user record",
        "Typecheck passes",
        "Verify in browser"
      ],
      "priority": 2,
      "passes": false
    },
    {
      "id": "US-003",
      "title": "Add avatar upload component",
      "description": "As a user, I want to upload a profile picture.",
      "acceptanceCriteria": [
        "File input for image selection",
        "Preview before upload",
        "Upload to storage and save URL",
        "Typecheck passes",
        "Verify in browser"
      ],
      "priority": 3,
      "passes": false
    }
  ]
}
```

---

Begin analyzing the task and creating the PRD now.
