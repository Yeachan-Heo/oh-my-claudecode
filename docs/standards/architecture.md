# Architecture Standards

Rule-shaped, checkable writing; every rule carries a "why". Empty sections are legal — sediment is gradual.

## Module boundaries
- Skills are markdown-defined capabilities under `skills/`; runtime wiring lives in `src/features/builtin-skills/` and loads every `skills/<name>/SKILL.md` automatically. Why: adding a skill must not require registry edits.
