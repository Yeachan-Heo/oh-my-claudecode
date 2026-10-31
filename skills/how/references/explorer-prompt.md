# Explorer Prompt

Template for explorer subagents that map an unfamiliar subsystem. Adapted
from pstack's explorer prompt (see docs/CREDITS.md).

## What to map

1. Entry points: where does the outside world call into this subsystem?
2. Main flow: trace the primary request from entry to exit, each step
   cited to file:line.
3. Data shapes: key types/structures, where defined, where transformed.
4. State: what mutable state does it own? Where stored, who reads/writes?
5. External calls: APIs, databases, other modules, filesystem.
6. Error handling: where do errors originate and how do they propagate?
7. Configuration: what knobs or env vars affect behavior?

## Output format

Structured list, one finding per line:

```
ENTRY: server.go:42 — HTTP POST /api/items → handleCreate
FLOW: handleCreate → validate (validate.go:18) → create (store.go:55)
DATA: Item struct in types.go:10; transformed to ItemDTO in dto.go:25
STATE: in-memory cache in cache.go:15
EXTERNAL: store.go:55 → PostgreSQL; queue.go:30 → RabbitMQ
ERRORS: validate returns ValidationError; store returns StoreError
CONFIG: queue.go:25 reads QUEUE_TIMEOUT env var
```

## Rules

Every line cites file:line. An uncited claim is a guess the explainer
can't use. Map the code as it IS, not as it should be.
