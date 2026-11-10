---
name: typescript-best-practices
description: "TypeScript grounding for type-system discipline: discriminated unions over flags, satisfies, parse-don't-validate at boundaries, branded primitives, no non-null assertions on external data."
aliases: []
metadata:
  credits:
    type-discipline: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# TypeScript Best Practices

The type system is the cheapest place to make illegal states unrepresentable
(`principles` skill, Type system discipline). Concrete forms:

- **Discriminated unions over boolean flags.** `type Ev = {kind:'click'; x:number} | {kind:'focus'}` — not `{isClick:boolean; x?:number}`. Exhaustive `switch` on `kind` turns missing cases into compile errors.
- **`satisfies` for configuration literals.** `{...} satisfies Config` keeps literal inference while checking the shape.
- **Parse, don't validate, at boundaries.** External data (JSON, env, CLI args, API responses) passes through one parsing function returning a typed result; downstream code takes the parsed type, never `any` re-cast. `unknown` in, typed out.
- **Brand primitives that carry meaning.** `type SessionId = string & {__brand:'SessionId'}` when mixing two `string`s is a realistic bug.
- **No non-null assertions on external data.** `!` is allowed only where a check on a previous line proves the value; at boundaries it is a runtime crash with compile-time approval.
- **Return types that prevent misuse.** A function that can fail returns a result union, not `T` plus a thrown maybe; callers must handle both arms to compile.
- **`readonly` by default on shared shapes**, mutation as an explicit opt-in.

## Reviewing

When reviewing TS, the question per diff hunk is not "does it compile" but
"which illegal state did this type just permit" — flag flags-over-unions,
boundary `any`s, and unbranded overlapping primitives.

## Rules

- Discipline applies at the boundary and the domain model; inside a single
  function, pragmatism wins.
- Never introduce a type abstraction with one caller and no second one
  coming (`minimal-code-discipline`).
