# TypeScript Build Errors — 3 failures blocking CI

## Environment
- TypeScript 5.4, strict mode enabled
- Build command: `tsc --noEmit`
- These errors appeared after merging PR #847 (added new notification types)

## Error 1: Type mismatch in event handler

```
src/handlers/notification-handler.ts(42,5): error TS2345: Argument of type 'NotificationEvent' is not assignable to parameter of type 'EmailEvent'.
  Property 'recipientEmail' is missing in type 'NotificationEvent' but required in type 'EmailEvent'.
```

```typescript
// src/types/events.ts
export interface NotificationEvent {
  id: string;
  type: 'email' | 'sms' | 'push';
  userId: string;
  message: string;
  createdAt: Date;
}

export interface EmailEvent {
  id: string;
  type: 'email';
  userId: string;
  recipientEmail: string;
  subject: string;
  message: string;
  createdAt: Date;
}

export interface SmsEvent {
  id: string;
  type: 'sms';
  userId: string;
  phoneNumber: string;
  message: string;
  createdAt: Date;
}
```

```typescript
// src/handlers/notification-handler.ts
import { NotificationEvent, EmailEvent } from '../types/events';
import { sendEmail } from '../services/email';

export async function handleNotification(event: NotificationEvent): Promise<void> {
  switch (event.type) {
    case 'email':
      // Line 42: error here
      await sendEmail(event);
      break;
    case 'sms':
      await sendSms(event);
      break;
    case 'push':
      await sendPush(event);
      break;
  }
}

// src/services/email.ts
export async function sendEmail(event: EmailEvent): Promise<void> {
  // ...
}
```

## Error 2: Possible null/undefined access

```
src/services/user-service.ts(28,25): error TS2532: Object is possibly 'undefined'.
```

```typescript
// src/services/user-service.ts
import { db } from '../database';

interface UserPreferences {
  notifications: {
    email: boolean;
    sms: boolean;
    push: boolean;
  };
  theme: 'light' | 'dark';
}

interface User {
  id: string;
  name: string;
  preferences?: UserPreferences;
}

export function getNotificationChannels(user: User): string[] {
  const channels: string[] = [];

  // Line 28: error here
  if (user.preferences.notifications.email) {
    channels.push('email');
  }
  if (user.preferences.notifications.sms) {
    channels.push('sms');
  }
  if (user.preferences.notifications.push) {
    channels.push('push');
  }

  return channels;
}
```

## Error 3: Missing property in object literal

```
src/api/routes/notifications.ts(35,7): error TS2741: Property 'retryCount' is missing in type '{ id: string; type: string; userId: string; message: string; status: string; }' but required in type 'NotificationRecord'.
```

```typescript
// src/types/records.ts
export interface NotificationRecord {
  id: string;
  type: string;
  userId: string;
  message: string;
  status: 'pending' | 'sent' | 'failed';
  retryCount: number;
  lastAttempt?: Date;
}
```

```typescript
// src/api/routes/notifications.ts
import { NotificationRecord } from '../../types/records';
import { db } from '../../database';

router.post('/notifications', async (req, res) => {
  const { type, userId, message } = req.body;

  // Line 35: error here
  const record: NotificationRecord = {
    id: generateId(),
    type,
    userId,
    message,
    status: 'pending',
  };

  await db.notifications.insert(record);
  res.json(record);
});
```
