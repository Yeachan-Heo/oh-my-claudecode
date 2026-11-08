# Demo 2: Ultrawork - Maximum Parallelism

**Duration:** 3 minutes
**Objective:** Demonstrate multiple agents fixing different issues simultaneously

## Pre-requisites

- Project with intentional TypeScript errors
- OMC installed and configured
- HUD statusline visible (shows multiple active agents)

## Setup (2 minutes before demo)

Create a sample TypeScript project with intentional errors across multiple files:

```bash
# Navigate to demo workspace
cd ~/demo-workspace
mkdir -p typescript-errors-demo
cd typescript-errors-demo

# Create package.json
cat > package.json << 'EOF'
{
  "name": "typescript-errors-demo",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "check": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
EOF

# Create tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true
  }
}
EOF

# Create files with errors
mkdir -p src

cat > src/user.ts << 'EOF'
export interface User {
  id: number;
  name: string;
  email: string;
}

export function createUser(name: string): User {
  return {
    id: Math.random(),
    name: name,
    email: undefined  // ERROR: Type 'undefined' not assignable to 'string'
  };
}

export function validateEmail(email) {  // ERROR: Parameter 'email' implicitly has 'any' type
  return email.includes('@');
}
EOF

cat > src/order.ts << 'EOF'
export interface Order {
  id: string;
  userId: number;
  items: string[];
  total: number;
}

export function calculateTotal(items: string[]): number {
  let total = 0;
  for (let item of items) {
    total += item;  // ERROR: Operator '+=' cannot be applied to 'number' and 'string'
  }
  return total;
}

export function createOrder(userId: number, items): Order {  // ERROR: Parameter 'items' implicitly has 'any' type
  return {
    id: userId.toString(),
    userId: userId,
    items: items,
    total: calculateTotal(items)
  };
}
EOF

cat > src/product.ts << 'EOF'
export interface Product {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
}

export function getProduct(id: string): Product {
  return {
    id: id,
    name: "Sample",
    price: "29.99",  // ERROR: Type 'string' not assignable to 'number'
    inStock: 1  // ERROR: Type 'number' not assignable to 'boolean'
  };
}

export function filterInStock(products: Product[]): Product[] {
  return products.filter(p => p.inStock === "yes");  // ERROR: Operator '===' cannot be applied to 'boolean' and 'string'
}
EOF

cat > src/index.ts << 'EOF'
import { createUser, validateEmail } from './user';
import { createOrder } from './order';
import { getProduct, filterInStock } from './product';

function main() {
  const user = createUser("John Doe");
  console.log(validateEmail(user.email));

  const order = createOrder(user.id, ["item1", "item2"]);
  console.log(order);

  const product = getProduct("123");
  const available = filterInStock([product]);
  console.log(available);
}

main();
EOF

# Install dependencies
npm install

# Verify errors exist
echo "Running TypeScript check to show errors..."
npm run check
```

This should produce 8-10 TypeScript errors across 4 files.

## The Command

```
ulw fix all TypeScript errors in the project
```

## Expected Flow (2-3 minutes)

### Phase 1: Activation & Analysis (0:00-0:20)
**What happens:**
- OMC announces: "I'm activating ultrawork for maximum parallel execution..."
- Explorer agent scans codebase
- Identifies errors across `user.ts`, `order.ts`, `product.ts`, `index.ts`

**Presenter talking points:**
- "Ultrawork activates automatically from 'ulw' keyword"
- "First, it scans to understand all the errors"
- Watch HUD: "One explorer agent analyzing the codebase"

### Phase 2: Parallel Execution (0:20-2:00)
**What happens:**
- 4 executor agents spawned simultaneously
- Each assigned to a different file
- All agents work in parallel:
  - executor-1: Fixes `src/user.ts`
  - executor-2: Fixes `src/order.ts`
  - executor-3: Fixes `src/product.ts`
  - executor-4: Fixes `src/index.ts`

**Presenter talking points:**
- Point to HUD: "See the statusline? Four agents active simultaneously"
- "Each agent is fixing a different file - no conflicts"
- "Traditional approach: Fix one file, wait, fix next. Ultrawork: Fix all at once"
- "This is how OMC achieves 3-5x speedup on multi-file tasks"

### Phase 3: Verification (2:00-2:30)
**What happens:**
- All agents complete
- Build-fixer runs TypeScript compilation
- All errors resolved

**Presenter talking points:**
- "All agents completed in parallel"
- "Final TypeScript check..."
- "Zero errors! All fixed simultaneously"

### Phase 4: Report (2:30-3:00)
**What happens:**
- Summary report generated:
  - 4 files modified
  - 8 errors fixed
  - 0 errors remaining
  - Completed in ~90 seconds

**Presenter talking points:**
- "Report shows all changes"
- "Compare: Serial fixing would take 5-6 minutes minimum"
- "Ultrawork completed in under 2 minutes"

## Expected Output

### Terminal Output
```
$ ulw fix all TypeScript errors in the project

I'm activating ultrawork for maximum parallel execution.

Scanning codebase for TypeScript errors...
✓ Found 8 errors across 4 files (3s)

Spawning 4 executor agents in parallel...
[executor-1] Assigned: src/user.ts (2 errors)
[executor-2] Assigned: src/order.ts (2 errors)
[executor-3] Assigned: src/product.ts (3 errors)
[executor-4] Assigned: src/index.ts (1 error)

[executor-1] Fixing user.ts...
[executor-2] Fixing order.ts...
[executor-3] Fixing product.ts...
[executor-4] Fixing index.ts...

✓ executor-4 completed src/index.ts (12s)
✓ executor-1 completed src/user.ts (18s)
✓ executor-2 completed src/order.ts (19s)
✓ executor-3 completed src/product.ts (22s)

Running TypeScript compilation...
✓ Build successful - 0 errors (2s)

Summary:
  - Files modified: 4
  - Errors fixed: 8
  - Errors remaining: 0
  - Time: 1m 34s
  - Agents used: 4 executors (parallel)

Serial execution would have taken: ~5m 30s
Speedup: 3.5x
```

### Fixed Code Examples

**src/user.ts** (fixed):
```typescript
export function createUser(name: string): User {
  return {
    id: Math.random(),
    name: name,
    email: `${name.toLowerCase().replace(' ', '.')}@example.com`  // FIX: Generate valid email
  };
}

export function validateEmail(email: string): boolean {  // FIX: Add type annotation
  return email.includes('@');
}
```

**src/order.ts** (fixed):
```typescript
export function calculateTotal(items: { price: number }[]): number {  // FIX: Proper type for items
  let total = 0;
  for (let item of items) {
    total += item.price;  // FIX: Access price property
  }
  return total;
}

export function createOrder(userId: number, items: { price: number }[]): Order {  // FIX: Add type
  // ...
}
```

**src/product.ts** (fixed):
```typescript
export function getProduct(id: string): Product {
  return {
    id: id,
    name: "Sample",
    price: 29.99,  // FIX: Number instead of string
    inStock: true  // FIX: Boolean instead of number
  };
}

export function filterInStock(products: Product[]): Product[] {
  return products.filter(p => p.inStock === true);  // FIX: Boolean comparison
}
```

## Key Talking Points

### What makes ultrawork special?
1. **Intelligent parallelization** - Automatically determines which tasks can run in parallel
2. **File-level coordination** - No conflicts between agents working on different files
3. **Maximum throughput** - 3-5x faster than serial execution
4. **Automatic task distribution** - You don't specify how many agents or which files
5. **HUD visibility** - See all active agents in real-time

### When to use ultrawork
- Multiple independent errors across files
- Multi-file refactoring
- Adding features to multiple modules
- Batch operations (e.g., "add error handling to all services")

### Architecture highlight
- "OMC uses a file ownership coordinator - prevents two agents from editing the same file"
- "Each agent gets exclusive write access to its assigned files"
- "Shared reads are fine - conflicts only happen on writes"

## Fallback: Pre-recorded Output

If live demo fails, show this realistic terminal output:

```
$ npm run check

src/user.ts:8:5 - error TS2322: Type 'undefined' is not assignable to type 'string'.
src/user.ts:13:29 - error TS7006: Parameter 'email' implicitly has an 'any' type.
src/order.ts:12:5 - error TS2365: Operator '+=' cannot be applied to types 'number' and 'string'.
src/order.ts:17:46 - error TS7006: Parameter 'items' implicitly has an 'any' type.
src/product.ts:13:5 - error TS2322: Type 'string' is not assignable to type 'number'.
src/product.ts:14:5 - error TS2322: Type 'number' is not assignable to type 'boolean'.
src/product.ts:19:38 - error TS2367: This condition will always return 'false'.
src/index.ts:6:28 - error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.

Found 8 errors in 4 files.

$ ulw fix all TypeScript errors in the project

I'm activating ultrawork for maximum parallel execution.

[HUD: OMC │ explore:1 scanning...]

Scanning codebase for TypeScript errors...
✓ Found 8 errors across 4 files (3s)

[HUD: OMC │ executor-low:4 active │ Tasks: 4/4 in progress]

Spawning 4 executor agents in parallel...
[executor-1] Assigned: src/user.ts (2 errors)
[executor-2] Assigned: src/order.ts (2 errors)
[executor-3] Assigned: src/product.ts (3 errors)
[executor-4] Assigned: src/index.ts (1 error)

[0:08] executor-1: Fixing undefined email → generate from name
[0:08] executor-2: Fixing 'any' type → adding proper interfaces
[0:08] executor-3: Fixing type mismatches → correcting literals
[0:08] executor-4: Fixing argument type → updating function call

[0:12] ✓ executor-4 completed src/index.ts (12s)
[0:18] ✓ executor-1 completed src/user.ts (18s)
[0:19] ✓ executor-2 completed src/order.ts (19s)
[0:22] ✓ executor-3 completed src/product.ts (22s)

[HUD: OMC │ build-fixer:1 active │ Verifying...]

Running TypeScript compilation...
✓ Build successful - 0 errors (2s)

[COMPLETE]

Summary:
  Files modified: 4
    - src/user.ts: Fixed 2 type errors
    - src/order.ts: Fixed 2 type errors
    - src/product.ts: Fixed 3 type errors
    - src/index.ts: Fixed 1 type error

  Errors fixed: 8
  Errors remaining: 0
  Time: 1m 34s
  Peak agents: 4 executors (parallel)

Serial execution estimate: ~5m 30s
Speedup achieved: 3.5x

$ npm run check

Success: no errors found.
```

## Common Issues & Troubleshooting

### Issue: Fewer agents spawn than expected
**Solution:**
- Still good for demo! Point out: "OMC determined 3 agents was optimal for this workload"
- Explain: "It balances parallelism with coordination overhead"

### Issue: One agent takes much longer
**Solution:**
- Point it out: "See? That file had a complex error requiring more analysis"
- Emphasize: "Other agents finished while this one worked - still faster than serial"

### Issue: TypeScript errors still remain after fixes
**Solution:**
- Good teaching moment: "Ultra work found a follow-up issue"
- Show it auto-correcting: "Watch - it's spawning another agent to fix the new error"

## HUD Watching Tips

Point out these HUD states during the demo:

**During scanning:**
```
OMC │ explore:1 scanning │ 0s
```

**During parallel execution:**
```
OMC │ executor-low:4 active │ Tasks: 4/4 in progress │ 18s
```

**During verification:**
```
OMC │ build-fixer:1 verifying │ 22s
```

**After completion:**
```
OMC │ idle │ Last: 4 agents, 1m34s
```

## Transition to Next Demo

"That's ultrawork - maximum parallelism for speed. But sometimes you need coordination, not just speed. What if you want agents to pass data between each other in a specific sequence? That's where pipeline comes in - our next demo."

**Transition action:** Navigate to a codebase directory for pipeline demo (or use the same directory from Demo 2)

## Q&A Preparation

**Q: How many agents can run in parallel?**
A: Typically 3-5 for ultrawork. The system balances parallelism with context overhead. For larger swarms, use the `swarm` skill (10+ agents).

**Q: What happens if two agents need to edit the same file?**
A: The file ownership coordinator prevents this. One agent gets the file, the other waits or is assigned different work. Shared reads are fine.

**Q: Does ultrawork work with any task?**
A: Best for tasks that are naturally parallelizable - multiple files, independent modules, batch operations. For sequential dependencies, use `pipeline` instead.

**Q: Can I control how many agents spawn?**
A: Yes! Use `/oh-my-claudecode:swarm N:agent-type "task"` for explicit control. Ultrawork auto-determines the optimal number.

**Q: What's the token cost of ultrawork vs serial?**
A: Similar total tokens, but compressed wall-clock time. You're paying for parallelism, not more work. Think: 4 workers × 2 minutes vs 1 worker × 8 minutes.
