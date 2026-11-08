# Bug Report: Intermittent Redis ECONNREFUSED after deployments

## Environment
- Node.js 20.11 LTS, Express 4.18
- Redis 7.2 via ioredis 5.3.2
- Deployed on Kubernetes (EKS), Redis ElastiCache cluster mode disabled
- Happens after every deployment (rolling restart), resolves after ~5 minutes

## Error Logs (from multiple pods)
```
[2024-01-15T14:22:03.456Z] ERROR: Redis connection error
  Error: connect ECONNREFUSED 10.0.5.42:6379
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
  code: 'ECONNREFUSED'

[2024-01-15T14:22:03.789Z] ERROR: Failed to get session data for user u_abc123
  Error: Connection is closed.
    at Commander._sendCommand (node_modules/ioredis/built/Redis.js:466:22)

[2024-01-15T14:22:05.123Z] WARN: Redis reconnecting, attempt 1
[2024-01-15T14:22:08.456Z] WARN: Redis reconnecting, attempt 2
[2024-01-15T14:22:15.789Z] INFO: Redis connection restored
```

## Relevant Code

```typescript
// config/redis.ts
import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: 0,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error', err);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

export default redis;
```

```typescript
// middleware/session.ts
import redis from '../config/redis';

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function setSession(sessionId: string, data: SessionData, ttlSeconds = 3600): Promise<void> {
  await redis.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
}
```

```typescript
// middleware/auth.ts
import { getSession } from './session';

export async function authMiddleware(req, res, next) {
  const sessionId = req.cookies?.sessionId;
  if (!sessionId) {
    return res.status(401).json({ error: 'No session' });
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    req.user = session.user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

```yaml
# kubernetes/deployment.yaml (relevant section)
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
      - name: api
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 20
```

```typescript
// routes/health.ts
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
```

## Observations
- The issue resolves itself after 3-5 minutes
- Redis ElastiCache dashboard shows no issues during the window
- `redis-cli PING` from within the pod returns PONG immediately
- The old pods shut down and new pods start during rolling restart
- ~200 concurrent users during the affected window
