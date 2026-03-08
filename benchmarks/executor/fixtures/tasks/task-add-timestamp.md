# Task: Add createdAt timestamp to User interface

## Context

We need to track when users are created. Add a `createdAt` field to the `User` interface and ensure it's set when creating new users.

## Existing Code

```typescript
// src/types/user.ts
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'viewer';
  isActive: boolean;
}
```

```typescript
// src/services/user-service.ts
import { User } from '../types/user';
import { db } from '../database';
import { generateId } from '../utils/id';

export async function createUser(input: { name: string; email: string; role: User['role'] }): Promise<User> {
  const user: User = {
    id: generateId(),
    name: input.name,
    email: input.email,
    role: input.role,
    isActive: true,
  };

  await db.users.insert(user);
  return user;
}

export async function getUser(id: string): Promise<User | null> {
  return db.users.findById(id);
}

export async function listUsers(): Promise<User[]> {
  return db.users.findAll();
}
```

```typescript
// src/api/routes/users.ts
import { createUser, getUser, listUsers } from '../../services/user-service';

router.post('/users', async (req, res) => {
  const { name, email, role } = req.body;
  const user = await createUser({ name, email, role });
  res.status(201).json(user);
});

router.get('/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.get('/users', async (req, res) => {
  const users = await listUsers();
  res.json(users);
});
```

## Requirements
1. Add `createdAt: Date` to the `User` interface
2. Set `createdAt` to `new Date()` in the `createUser` function
3. No changes needed to routes or other services
