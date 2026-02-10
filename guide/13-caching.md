# Chapter 13: Caching

OriJS provides a multi-level caching system designed for real-world production needs: entity-based cache keys, thundering herd prevention, grace periods for stale-while-revalidate behavior, and cascade invalidation.

## Why Another Caching System?

Most caching libraries provide simple key-value storage:

```typescript
// Simple cache — works but creates problems at scale
cache.set('user:123', userData, { ttl: 300 });
const user = cache.get('user:123');
```

This works for basic use cases, but production applications face harder problems:

1. **Thundering herd.** When a popular cache entry expires, hundreds of concurrent requests all hit the database simultaneously to refetch it.
2. **Stale data vs downtime.** Should you serve stale data while refreshing, or make users wait?
3. **Cascade invalidation.** When a user updates their profile, you need to invalidate their profile cache AND every list that includes them AND every view that references them.
4. **Consistent key naming.** Without structure, cache keys become inconsistent (`user:123`, `users_123`, `user-data:123`) making invalidation unreliable.

OriJS's caching system addresses all of these.

## Entity-Based Cache Keys

Instead of ad-hoc string keys, OriJS organizes caches around **entities** with **scopes**:

```typescript
import { CacheService, CacheEntityRegistry } from '@orijs/cache';

// Define entities and their scopes
const cacheRegistry = CacheEntityRegistry.create({
  user: {
    scopes: {
      byId: { ttl: 300 },           // 5 minutes
      byEmail: { ttl: 300 },
      listByAccount: { ttl: 60 },   // 1 minute (lists change more often)
    },
  },
  monitor: {
    scopes: {
      byId: { ttl: 600 },           // 10 minutes
      listByProject: { ttl: 120 },  // 2 minutes
      statusById: { ttl: 30 },      // 30 seconds (changes frequently)
    },
  },
});
```

Each entity has named scopes with their own TTL. Cache keys are generated automatically:

```typescript
const cache = new CacheService(cacheRegistry);

// These generate structured keys:
// "cache:user:byId:user-123"
// "cache:monitor:listByProject:proj-456"
// "cache:monitor:statusById:mon-789"
```

### Why Entity-Based?

1. **Consistent naming.** Every developer uses the same key structure. No more guessing if the key is `user:123` or `users:123` or `user_data:123`.
2. **Easy invalidation.** Invalidate all scopes for an entity: "invalidate everything about user 123."
3. **Discoverable.** The registry documents every cache key in your application.
4. **Type-safe.** TypeScript enforces valid entity names and scope names.

## getOrSet Pattern

The core caching pattern in OriJS is `getOrSet` — check the cache, and if it's a miss, call a factory function to compute the value:

```typescript
class UserRepository {
  constructor(
    private cache: CacheService,
    private dbService: UserDbService,
  ) {}

  public async getById(userId: string): Promise<User> {
    return this.cache.getOrSet(
      'user', 'byId', userId,
      async () => {
        return this.dbService.findById(userId);
      },
    );
  }

  public async listByAccount(accountId: string): Promise<User[]> {
    return this.cache.getOrSet(
      'user', 'listByAccount', accountId,
      async () => {
        return this.dbService.findByAccount(accountId);
      },
    );
  }
}
```

`getOrSet(entity, scope, key, factory)`:
1. Checks the cache for `cache:user:byId:user-123`
2. If found and fresh, returns it immediately
3. If not found, calls the factory function
4. Caches the result and returns it

This pattern ensures your repository code is simple: you always call `getOrSet`, and the caching system handles the rest.

## Singleflight (Thundering Herd Prevention)

When a cache entry expires and 100 requests arrive simultaneously, without protection you'd make 100 identical database queries. OriJS's **singleflight** mechanism prevents this:

```typescript
const cacheRegistry = CacheEntityRegistry.create({
  monitor: {
    scopes: {
      statusById: { ttl: 30, singleflight: true },
    },
  },
});
```

With `singleflight: true`:
1. Request 1 arrives, cache is empty → factory function starts executing
2. Requests 2-100 arrive while factory is running → they **wait** for request 1's result
3. Factory completes → all 100 requests receive the same result
4. Only ONE database query was made

This is critical for high-traffic applications where popular cache entries expire simultaneously.

### How Singleflight Works

Under the hood, singleflight uses an in-memory map of in-flight promises:

```
Key: "cache:monitor:statusById:mon-123"

Request 1:  [--- factory executing ---] → result
Request 2:       [waiting...           ] → same result
Request 3:         [waiting...         ] → same result
Request 4:           [waiting...       ] → same result
```

All waiting requests share the same promise. Once it resolves, they all get the result. If the factory throws, all waiting requests receive the error.

## Grace Periods (Stale-While-Revalidate)

What happens when a cache entry expires? By default, the next request waits for the factory to refetch the data. With grace periods, you can serve stale data while refreshing in the background:

```typescript
const cacheRegistry = CacheEntityRegistry.create({
  monitor: {
    scopes: {
      listByProject: {
        ttl: 120,        // "Fresh" for 2 minutes
        grace: 300,      // "Stale but usable" for 5 more minutes
        singleflight: true,
      },
    },
  },
});
```

The lifecycle of a cache entry with grace:

```
0s          120s         420s
│── fresh ──│── grace ──│── expired ──→
             (stale)
```

1. **0-120s (fresh)**: Return cached value immediately.
2. **120-420s (grace/stale)**: Return cached value immediately AND trigger a background refresh. The next request after refresh completes gets the fresh value.
3. **420s+ (expired)**: Cache entry is gone. Next request must wait for the factory.

This gives you the best of both worlds: users never wait for cache refreshes (they get stale data), but the data is refreshed in the background so staleness is minimal.

### Factory Context

The factory function receives a context object for advanced control:

```typescript
this.cache.getOrSet(
  'monitor', 'listByProject', projectId,
  async (ctx) => {
    try {
      const monitors = await this.dbService.findByProject(projectId);
      return monitors;
    } catch (error) {
      // If we have a stale value and the refresh failed,
      // return the stale value instead of propagating the error
      if (ctx.staleValue) {
        ctx.log.warn('Using stale cache value due to refresh error', { error });
        return ctx.staleValue;
      }
      throw error;
    }
  },
);
```

The factory context provides:
| Property | Description |
|----------|-------------|
| `ctx.staleValue` | The previous cached value (if in grace period) |
| `ctx.skip()` | Don't cache this result (for errors or empty results) |
| `ctx.fail()` | Mark the factory as failed (returns stale value if available) |
| `ctx.log` | Logger with cache context |

`ctx.skip()` is useful when the factory returns an empty result that you don't want to cache:

```typescript
async (ctx) => {
  const result = await this.dbService.findByProject(projectId);
  if (result.length === 0) {
    ctx.skip();  // Don't cache empty results
  }
  return result;
}
```

## Cache Invalidation

When data changes, you need to invalidate the cache. OriJS provides multiple invalidation strategies:

### Direct Invalidation

Invalidate a specific cache entry:

```typescript
async updateUser(userId: string, update: UpdateUserInput): Promise<User> {
  const user = await this.dbService.update(userId, update);

  // Invalidate specific entry
  await this.cache.invalidate('user', 'byId', userId);

  return user;
}
```

### Entity-Wide Invalidation

Invalidate all scopes for an entity:

```typescript
async updateUser(userId: string, update: UpdateUserInput): Promise<User> {
  const user = await this.dbService.update(userId, update);

  // Invalidate ALL user caches for this userId
  // This clears byId, byEmail, and any other scopes
  await this.cache.invalidateEntity('user', userId);

  return user;
}
```

### Cascade Invalidation

When updating a user, you might need to invalidate not just the user cache, but also all lists that contain that user:

```typescript
async updateUser(userId: string, accountId: string, update: UpdateUserInput): Promise<User> {
  const user = await this.dbService.update(userId, update);

  // Invalidate the user's own caches
  await this.cache.invalidate('user', 'byId', userId);
  await this.cache.invalidate('user', 'byEmail', user.email);

  // Invalidate the list that contains this user
  await this.cache.invalidate('user', 'listByAccount', accountId);

  return user;
}
```

### Tag-Based Invalidation

For complex invalidation patterns, use tags:

```typescript
// When caching, tag the entry
this.cache.getOrSet(
  'user', 'byId', userId,
  async () => this.dbService.findById(userId),
  { tags: [`account:${accountId}`] },
);

this.cache.getOrSet(
  'user', 'listByAccount', accountId,
  async () => this.dbService.findByAccount(accountId),
  { tags: [`account:${accountId}`] },
);

// Invalidate all entries tagged with this account
await this.cache.invalidateByTag(`account:${accountId}`);
// This clears: user:byId:user-123, user:listByAccount:acc-456, and any other entry with this tag
```

Tag-based invalidation is powerful for cross-entity invalidation. For example, when an account's plan changes, you might need to invalidate user caches, monitor caches, and billing caches — all tagged with the account ID.

## Redis Provider

For production deployments, use Redis for distributed caching:

```typescript
import { createRedisCacheProvider } from '@orijs/cache-redis';

const cacheProvider = createRedisCacheProvider({
  connection: { host: 'localhost', port: 6379 },
  keyPrefix: 'myapp:cache:',
});

Ori.create()
  .cache({ provider: cacheProvider, registry: cacheRegistry })
  // ...
```

The Redis provider stores cache entries as Redis keys with TTL, using Redis's native key expiration. Tag-based invalidation uses Redis Sets to track tagged keys.

Without the Redis provider, caching is in-memory (per-process). This works for single-instance deployments but doesn't share cache across instances.

## Real-World Example

Here's a complete caching setup for a monitoring application:

```typescript
// Cache registry
const cacheRegistry = CacheEntityRegistry.create({
  monitor: {
    scopes: {
      byId: { ttl: 600, singleflight: true },
      listByProject: { ttl: 120, grace: 300, singleflight: true },
      configById: { ttl: 1800, singleflight: true },
    },
  },
  monitorStatus: {
    scopes: {
      current: { ttl: 30, grace: 60, singleflight: true },
      history: { ttl: 300, singleflight: true },
    },
  },
  project: {
    scopes: {
      byId: { ttl: 600 },
      listByAccount: { ttl: 300, singleflight: true },
    },
  },
});

// Repository with caching
class MonitorRepository {
  constructor(
    private cache: CacheService,
    private dbService: MonitorDbService,
  ) {}

  public async getById(monitorId: string): Promise<Monitor | null> {
    return this.cache.getOrSet(
      'monitor', 'byId', monitorId,
      async (ctx) => {
        const monitor = await this.dbService.findById(monitorId);
        if (!monitor) ctx.skip();  // Don't cache null
        return monitor;
      },
    );
  }

  public async listByProject(projectId: string): Promise<Monitor[]> {
    return this.cache.getOrSet(
      'monitor', 'listByProject', projectId,
      async () => this.dbService.findByProject(projectId),
    );
  }

  public async getCurrentStatus(monitorId: string): Promise<MonitorStatus> {
    return this.cache.getOrSet(
      'monitorStatus', 'current', monitorId,
      async (ctx) => {
        try {
          return await this.dbService.getCurrentStatus(monitorId);
        } catch (error) {
          if (ctx.staleValue) return ctx.staleValue;
          throw error;
        }
      },
    );
  }

  public async update(monitorId: string, projectId: string, update: UpdateMonitorInput): Promise<Monitor> {
    const monitor = await this.dbService.update(monitorId, update);

    // Invalidate affected caches
    await Promise.all([
      this.cache.invalidate('monitor', 'byId', monitorId),
      this.cache.invalidate('monitor', 'configById', monitorId),
      this.cache.invalidate('monitor', 'listByProject', projectId),
    ]);

    return monitor;
  }
}
```

## Summary

OriJS caching provides:

1. **Entity-based cache keys** for consistent, discoverable key naming
2. **`getOrSet` pattern** for simple, correct caching in repository code
3. **Singleflight** to prevent thundering herd (one DB query instead of hundreds)
4. **Grace periods** for stale-while-revalidate behavior (users never wait for refreshes)
5. **Multiple invalidation strategies** — direct, entity-wide, cascade, and tag-based
6. **Factory context** with `skip()`, `fail()`, and `staleValue` for advanced control
7. **Redis provider** for distributed caching across multiple instances

The combination of singleflight and grace periods means your application can handle traffic spikes gracefully — users always get a response quickly, and the database is protected from stampedes.

[Previous: WebSockets ←](./12-websockets.md) | [Next: Testing →](./14-testing.md)
