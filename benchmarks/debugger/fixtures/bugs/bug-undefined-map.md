# Bug Report: TypeError: Cannot read properties of undefined (reading 'map')

## Environment
- React 18.2, TypeScript 5.3, Vite 5.0
- Browser: Chrome 121

## Error
```
Uncaught TypeError: Cannot read properties of undefined (reading 'map')
    at UserList (UserList.tsx:24)
    at renderWithHooks (react-dom.development.js:16305)
    at mountIndeterminateComponent (react-dom.development.js:20074)
```

## Component Code

```tsx
// UserList.tsx
import React, { useState, useEffect } from 'react';
import { fetchUsers } from '../api/users';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'viewer';
}

interface UserListProps {
  roleFilter?: string;
  onUserSelect: (user: User) => void;
}

export function UserList({ roleFilter, onUserSelect }: UserListProps) {
  const [users, setUsers] = useState<User[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      try {
        setLoading(true);
        const data = await fetchUsers({ role: roleFilter });
        if (!cancelled) {
          setUsers(data.users);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load users');
          setLoading(false);
        }
      }
    }

    loadUsers();
    return () => { cancelled = true; };
  }, [roleFilter]);

  if (loading) return <div className="spinner">Loading...</div>;
  if (error) return <div className="error">{error}</div>;

  const filteredUsers = users.map((user) => (
    <li key={user.id} onClick={() => onUserSelect(user)}>
      <span className="name">{user.name}</span>
      <span className="email">{user.email}</span>
      <span className={`role role-${user.role}`}>{user.role}</span>
    </li>
  ));

  return (
    <div className="user-list">
      <h2>Users ({users.length})</h2>
      <ul>{filteredUsers}</ul>
    </div>
  );
}
```

```typescript
// api/users.ts
import { apiClient } from './client';

export async function fetchUsers(params: { role?: string }) {
  const response = await apiClient.get('/api/users', { params });
  return response.data;  // { users: User[], total: number }
}
```

## Steps to Reproduce
1. Navigate to /admin/users
2. Component renders, crash occurs immediately on first render
3. Happens consistently on initial page load
4. After hot-reload (state preserved), it works fine

## Additional Context
- The API endpoint `/api/users` returns `{ users: [...], total: N }` correctly
- The component worked in development with mock data
- The crash only happens on initial render, not on subsequent role filter changes
