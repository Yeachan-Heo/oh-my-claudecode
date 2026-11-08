---
name: session-flow
description: Reorient in the current Claude Code session with an evidence-backed map of its goal, pivots, outcomes, current step, and open decisions.
argument-hint: "[short|reset]"
disable-model-invocation: true
---

# Session Flow

Build a compact, evidence-backed map of how this conversation actually unfolded so the user can reorient after switching sessions or compacting. This is an advisory summary, not a planner, executor, or replacement for the user's task list.

## Modes

- No argument: render the full map and reconcile its session-flow Tasks when native Task tools are available.
- `short`: return only the goal, current stage, and what (if anything) needs the user. Read-only; do not change Tasks.
- `reset`: discover and delete only Tasks owned by this skill, then confirm what was removed. Do not render a new map.

## Workflow

1. Reconstruct the flow from this conversation's user messages and tool results. Do not treat repository state alone as evidence that a stage happened. Separate the original goal from explicit goal changes, pivots, completed outcomes, dropped paths, and decisions still waiting on the user.
2. Make 4–8 meaningful stages when the history supports them; use fewer rather than padding sparse histories or inventing work. Use one outcome per stage:
   - `✅` completed with an outcome supported by the conversation
   - `▶` the current unfinished stage
   - `○` an explicitly planned but unstarted stage
   - `✂` dropped, with the stated reason
   - `↪` a pivot, with the old direction and the evidenced new direction
3. Give every stage one compact evidence pointer. Use a real URL or artifact path when one appears in the conversation; otherwise cite a distinctive short user quote or tool result. Never invent a link or state an inference as fact. Mark uncertain or pre-compaction reconstruction as `inferred`.
4. Keep the full map to at most 15 lines: one line per stage, plus concise goal, `Needs you`, and `Next` lines. Include open decisions in `Needs you`; say `none` when there are none. `Next` must be a concrete next action only when the conversation supports one.
5. In the default and `reset` modes, call `TaskList` and inspect every `[S<number>]` candidate with `TaskGet` before mutating it. A Task belongs to this skill only when its subject starts with `[S<number>]` and its description contains the exact marker line `session-flow: managed stage`. Never edit, complete, delete, or reuse an unmarked Task.
6. In the default mode, update owned Tasks that still represent a stage, create missing stages with `TaskCreate`, a subject beginning `[S<number>]`, and a description whose first line is the ownership marker followed by stage evidence. Match statuses to the map: completed (including dropped or pivoted) is `completed`, current is `in_progress`, and planned is `pending`. Delete owned Tasks for stages no longer in the reconstructed map with `TaskUpdate` status `deleted`; keep surviving stage numbers stable and avoid collisions with unowned Tasks.
7. The OMC continuation hook excludes Tasks with both the `[S<number>]` subject prefix and the exact ownership marker, so these descriptive records are not treated as unfinished work. Preserve both markers on every create or update. `short` must not call mutating Task tools.
8. For `reset`, discover owned Tasks with `TaskList` and `TaskGet`, then use `TaskUpdate` status `deleted` only on confirmed owned Tasks.
9. If the native Task tools are unavailable, render the map without claiming it was persisted. For `reset`, report that owned Tasks could not be inspected or removed; do not guess which Tasks belong to the skill.

## Output

Use a stable, concise shape:

```text
🎯 Goal: <goal and any evidenced change>
✅ S1 <stage> → <outcome> — evidence: <source pointer>
↪ S2 <old direction> → <new direction> — evidence: <source pointer>
▶ S3 <current stage> — evidence: <source pointer>
✂ S4 <dropped path> — <reason> — evidence: <source pointer>
⏸ Needs you: <decision or none>
➡ Next: <supported next action or none>
```

Omit example rows that do not apply. Keep the stage order stable across calls unless the conversation provides evidence to correct it; update the owned Tasks to match any correction.
