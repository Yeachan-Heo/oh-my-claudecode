# TypeScript Patterns

Concrete code patterns for each rule. Adapted from pstack's patterns
reference (see docs/CREDITS.md). The underlying principles are
language-agnostic.

## Branded types

Brand primitives so they can't be mixed up. Validate once at the boundary.

```ts
type AgentId = string & { readonly __brand: "AgentId" };

function isAgentId(input: string): input is AgentId {
  return isUUID(input);
}

function parseAgentId(input: string): AgentId {
  if (!isAgentId(input)) throw new Error(`Invalid agent id: ${input}`);
  return input;
}

function focusAgent(id: AgentId): void { /* trusted */ }
```

## Discriminated unions

Model variants with a literal discriminant. Every variant shares the field
name; each variant's value is unique.

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function handle(r: Result<number>): number {
  if (r.ok) return r.value;   // r.error not accessible here
  throw new Error(r.error);   // r.value not accessible here
}
```

## satisfies for config literals

Check the shape without widening the type.

```ts
const config = {
  retries: 3,
  timeout: 5000,
} satisfies RetryConfig;  // retries: number (literal preserved)
```

## Parse, don't validate

External data enters as `unknown` and exits as a trusted type.

```ts
function parseAgentConfig(raw: unknown): AgentConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.retries !== "number") throw new Error("retries must be a number");
  return { retries: obj.retries };
}
```

## No non-null assertions on external data

```ts
// BAD: crashes if the API changed
const id = response.data.id!;

// GOOD: narrow explicitly
const id = typeof response.data?.id === "string" ? response.data.id : null;
if (id === null) throw new Error("missing id in response");
```

## Readonly by default on shared shapes

```ts
interface Config {
  readonly retries: number;
  readonly timeout: number;
}
```
