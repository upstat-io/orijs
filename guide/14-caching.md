# Chapter 14: Caching

[Previous: WebSockets <-](./13-websockets.md) | [Next: Logging ->](./15-logging.md)

---

Caching is one of those problems that looks simple until you actually try to get it right. The basic concept -- store a computed result so you do not have to compute it again -- is straightforward. But in production, you face thundering herds when cache entries expire, stale data that confuses users, cascade invalidation that either misses entries or deletes too much, and inconsistent cache key formats that make debugging impossible.

OriJS's cache system addresses these problems with a provider-based architecture, entity-aware cache keys, singleflight for thundering herd prevention, grace periods for stale-while-revalidate, and cascade invalidation through dependency tracking. The system ships with two providers -- in-memory for testing and Redis for production -- and you can write your own provider for any key-value store.

## Why Another Caching System

Most caching libraries give you `get(key)` and `set(key, value, ttl)`. That works for a weekend project, but it falls apart in production:

**Thundering herd.** When a popular cache entry expires, every concurrent request that misses the cache will trigger the same expensive database query simultaneously. If 50 users hit a page at the same time and the cache just expired, you get 50 identical queries instead of 1.

**Stale data vs availability.** When your database is slow or temporarily down, do you show users an error page, or do you serve slightly stale data? Most cache libraries force you to choose at design time. OriJS lets you serve stale data during a grace period while simultaneously trying to refresh.

**Cascade invalidation.** When you update a User, you need to invalidate not just the User cache, but also the UserProfile cache, the UserPermissions cache, and any other cache that depends on user data. Doing this manually is error-prone -- you will inevitably miss an entry.

**Consistent keys.** When cache keys are freeform strings like `user:${id}`, different developers construct keys differently, making it impossible to reason about what is cached or to build reliable invalidation. OriJS uses entity-based keys generated from a registry, ensuring every cache key is consistent and discoverable.

**Tag-based cross-scope invalidation.** Sometimes you need to invalidate caches that span different entity scopes -- for example, invalidating all caches related to a user across both `account` and `project` scopes. Tags solve this without coupling the cache definitions to each other.

## The Cache Provider Interface

Like WebSockets and events, OriJS's cache system is built on a **provider interface**. The framework ships with two providers:

| Provider | Package | Use Case |
|----------|---------|----------|
| `InMemoryCacheProvider` | `@orijs/cache` | Testing, development, single-process |
| `RedisCacheProvider` | `@orijs/cache-redis` | Production, distributed, multi-process |

Both implement the `CacheProvider` interface:

```typescript
interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<number>;
  delMany(keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
```

This is the minimal interface any key-value store can implement. If you use Memcached, DynamoDB, or even a file system, you only need to implement these six methods.

The Redis provider extends this with a `CacheProviderWithMeta` interface that adds dependency tracking for cascade invalidation:

```typescript
interface CacheProviderWithMeta extends CacheProvider {
  setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void>;
  delByMeta(metaKey: string): Promise<number>;
  delByMetaMany(metaKeys: string[]): Promise<number>;
}
```

The cache system detects which provider you are using at runtime and enables cascade invalidation only when the provider supports it:

```typescript
import { hasMetaSupport } from '@orijs/cache';

if (hasMetaSupport(provider)) {
  // Redis provider -- use meta keys for cascade invalidation
  await provider.setWithMeta(key, value, ttl, metaKeys);
} else {
  // InMemory provider -- simple set, no cascade
  await provider.set(key, value, ttl);
}
```

## Entity-Based Cache Keys

OriJS does not use freeform string cache keys. Instead, cache keys are generated from an **entity registry** that defines your data model's scope hierarchy and entity definitions.

### Why Entity-Based

Freeform keys seem flexible, but they create real problems:

```typescript
// Different developers write different keys for the same data
cache.set(`user:${userId}`, data);           // Developer A
cache.set(`users:${userId}`, data);          // Developer B
cache.set(`user-${accountId}-${userId}`, data);  // Developer C

// Invalidation becomes guesswork
cache.del(`user:${userId}`);  // Did we get all the variations?
```

Entity-based keys solve this by generating cache keys from a single source of truth:

```typescript
// Define once, use everywhere
const UserCache = Cache.for(Entities.User).ttl('1h').build();

// Always generates the same key for the same parameters
await cacheService.getOrSet(UserCache, { accountUuid, userUuid }, factory);

// Invalidation is reliable
await cacheService.invalidate('User', { accountUuid });
```

### Setting Up the Entity Registry

The entity registry defines your application's scope hierarchy and entities:

```typescript
import { defineScopes, defineEntities, EntityRegistry, createCacheBuilder } from '@orijs/cache';

// Step 1: Define scope hierarchy
// Each scope inherits parameters from the scopes above it
const Scope = defineScopes({
  Global:  { name: 'global' },
  Account: { name: 'account', param: 'accountUuid' },
  Project: { name: 'project', param: 'projectUuid' },
});

// Step 2: Define entities within scopes
const Entities = defineEntities({
  Account:        { name: 'Account',        scope: Scope.Account },
  Project:        { name: 'Project',        scope: Scope.Project },
  User:           { name: 'User',           scope: Scope.Account, param: 'userUuid' },
  Monitor:        { name: 'Monitor',        scope: Scope.Project, param: 'monitorUuid' },
  MonitorConfig:  { name: 'MonitorConfig',  scope: Scope.Project, param: 'monitorUuid' },
  Incident:       { name: 'Incident',       scope: Scope.Project, param: 'incidentUuid' },
});

// Step 3: Build the registry
const registry = EntityRegistry.create()
  .scopes(Scope)
  .entities(Entities)
  .build();

// Step 4: Create the cache builder bound to the registry
const Cache = createCacheBuilder(registry);
```

The scope hierarchy means:
- `Global` scope: no parameters needed
- `Account` scope: requires `accountUuid`
- `Project` scope: requires `accountUuid` + `projectUuid` (inherits from Account)

An entity's parameters are automatically computed as scope parameters plus unique keys:

```typescript
const monitorEntity = registry.getEntity('Monitor');
// monitorEntity.params = ['accountUuid', 'projectUuid', 'monitorUuid']
// monitorEntity.scope = 'project'
```

### Defining Cache Configurations

With the registry and builder, defining caches is concise:

```typescript
// Minimal: entity + TTL
const AccountCache = Cache.for(Entities.Account).ttl('1h').build();

// With grace period for stale-while-revalidate
const UserCache = Cache.for(Entities.User).ttl('30m').grace('5m').build();

// With explicit dependency on another entity
const MonitorConfigCache = Cache.for(Entities.MonitorConfig)
  .ttl('15m')
  .grace('2m')
  .dependsOn(Entities.Monitor)
  .build();

// Cache null results (useful when "not found" is a valid, cacheable state)
const IncidentCache = Cache.for(Entities.Incident)
  .ttl('5m')
  .cacheNull()
  .build();

// With custom timeout for slow data sources
const ReportCache = Cache.for(Entities.Report)
  .ttl('1h')
  .timeout('30s')  // Override default 1s timeout
  .build();
```

### Automatic Dependency Derivation

The cache builder automatically derives hierarchy dependencies from the entity registry. A `Monitor` at `project` scope automatically depends on `Account` and `Project`:

```typescript
const MonitorCache = Cache.for(Entities.Monitor).ttl('5m').build();

// MonitorCache.dependsOn = {
//   Account: ['accountUuid'],
//   Project: ['accountUuid', 'projectUuid']
// }
```

This means when you invalidate an Account, all Monitor caches within that account are also invalidated. When you invalidate a Project, all Monitor caches within that project are invalidated. You do not need to specify this manually.

### params vs metaParams

These serve different purposes and understanding the distinction is important:

- **params**: All parameters needed to uniquely identify a specific cached value. Used for cache key generation. Example: Monitor has params `['accountUuid', 'projectUuid', 'monitorUuid']`.

- **metaParams**: Parameters used for cascade invalidation lookup. Derived from the entity's scope parameters only (not the entity's own unique key). Example: Monitor has metaParams `['accountUuid', 'projectUuid']`.

Why the distinction? When you invalidate "all Monitor caches for a project", you provide `{ accountUuid, projectUuid }` -- the metaParams. The metaParams identify the invalidation scope, while params are used when getting or setting a specific cache entry.

## The getOrSet Pattern

`getOrSet` is the primary caching method. It implements the cache-aside pattern with singleflight, grace periods, and a factory context:

```typescript
const user = await cacheService.getOrSet(
  UserCache,                                          // Cache configuration
  { accountUuid: 'abc', userUuid: 'def' },            // Parameters
  async (ctx) => {                                    // Factory function
    const user = await this.dbService.findUser(params);
    if (!user) return ctx.skip();                     // Don't cache "not found"
    return user;
  }
);
```

The lifecycle of a `getOrSet` call:

```
Check cache ──► Fresh hit?  ──► YES ──► Return cached value (no factory call)
                    │
                    NO
                    │
                    ▼
              Stale (grace)? ──► YES ──► Call factory with staleValue in context
                    │                     │
                    NO                    ├── Factory succeeds ──► Cache + return new
                    │                     └── Factory fails ──────► Return stale value
                    ▼
              Cache miss ──────────────► Call factory
                                          │
                                          ├── Factory succeeds ──► Cache + return new
                                          ├── Factory calls skip() ──► Return undefined
                                          └── Factory throws ──────► Error propagates
```

## Singleflight / Thundering Herd Prevention

This is one of the most important features of the cache system, and it is often overlooked by simpler caching libraries.

### The Problem

Imagine a cache entry for a popular dashboard page expires. In the next 100 milliseconds, 50 requests arrive for that page. Without singleflight, all 50 requests see a cache miss and all 50 trigger the same expensive database query:

```
Request 1: cache miss → SELECT * FROM dashboard_data WHERE ...
Request 2: cache miss → SELECT * FROM dashboard_data WHERE ...   (duplicate!)
Request 3: cache miss → SELECT * FROM dashboard_data WHERE ...   (duplicate!)
...
Request 50: cache miss → SELECT * FROM dashboard_data WHERE ...  (duplicate!)
```

Your database just got hit with 50 identical queries when 1 would suffice.

### How Singleflight Works

Singleflight ensures that only one request executes the factory function for a given cache key. All other concurrent requests wait for the first one to complete and share the result:

```
Request 1: cache miss → execute factory → cache result → return
Request 2: cache miss → wait for Request 1... → return shared result
Request 3: cache miss → wait for Request 1... → return shared result
...
Request 50: cache miss → wait for Request 1... → return shared result
```

50 requests, 1 database query. The `Singleflight` class maintains an in-memory map of in-flight promises keyed by cache key:

```typescript
class Singleflight {
  private readonly flights = new Map<string, Flight<unknown>>();

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Check for existing in-flight request
    const existing = this.flights.get(key);
    if (existing) {
      return existing.promise;  // Share the result
    }

    // First caller -- execute the function
    const promise = fn().finally(() => {
      this.flights.delete(key);
    });

    this.flights.set(key, { promise });
    return promise;
  }
}
```

### Error Caching

Singleflight also caches errors for a configurable TTL (default: 5 seconds). This prevents thundering herd on errors -- if the database is down, you do not want 50 requests all trying and failing simultaneously every few milliseconds.

The CacheService configures singleflight with `errorTtlMs: 0` because the cache system has its own error handling logic through the factory context's `fail()` method and grace period fallbacks.

## Grace Periods / Stale-While-Revalidate

Grace periods solve a fundamental tension: you want fresh data, but you also want high availability. The grace period creates a window after the TTL expires where stale data can still be served as a fallback.

### The Lifecycle

```
Timeline: |──────── TTL ────────|──────── Grace ────────|── Expired ──|
          ^                     ^                        ^
          createdAt             expiresAt                graceExpiresAt

FRESH (now < expiresAt):
  Return cached value immediately. No factory call.

STALE (expiresAt <= now < graceExpiresAt):
  Call factory to refresh. If factory fails, return stale value.

EXPIRED (now >= graceExpiresAt):
  Cache miss. Factory must succeed or error propagates.
```

### Why This Matters

Consider a monitoring dashboard. The data is cached for 5 minutes with a 1-minute grace period:

```typescript
const MonitorStatusCache = Cache.for(Entities.MonitorStatus)
  .ttl('5m')
  .grace('1m')
  .build();
```

At minute 5:30 (within grace period), the database is temporarily slow. Without grace:
- Cache miss, factory times out, user sees an error

With grace:
- Factory is called, times out, but the stale value from minute 0 is returned
- User sees data that is 5.5 minutes old instead of an error page
- The stale value has an age of 330 seconds, available via `ctx.staleAge`

The next successful factory call will cache fresh data and reset the cycle.

### Best of Both Worlds

Grace periods give you:
- **Freshness** during normal operation (TTL ensures data is refreshed regularly)
- **Availability** during failures (stale data is served instead of errors)
- **Observability** (your factory can check `ctx.staleAge` and decide what to do)

## Factory Context

The factory function receives a `FactoryContext` with tools for controlling cache behavior:

```typescript
interface FactoryContext<T> {
  /** Don't cache this result, return undefined to caller */
  skip(): never;

  /** Signal error but preserve stale value if within grace period */
  fail(message: string): never;

  /** Access stale value when within grace period */
  readonly staleValue: T | undefined;

  /** How old the stale value is (in seconds) */
  readonly staleAge: number | undefined;
}
```

### skip() -- Do Not Cache

Use `skip()` when the factory determines the result should not be cached:

```typescript
const user = await cacheService.getOrSet(UserCache, params, async (ctx) => {
  const user = await db.findUser(params.userUuid);

  if (!user) {
    return ctx.skip();  // Don't cache "not found" -- return undefined
  }

  return user;
});
```

### fail() -- Use Stale Fallback

Use `fail()` to signal an error while preserving the stale value if one exists:

```typescript
const data = await cacheService.getOrSet(DashboardCache, params, async (ctx) => {
  try {
    return await this.dbService.getDashboardData(params);
  } catch (err) {
    if (ctx.staleValue) {
      // Database is down, but we have stale data -- use it
      return ctx.fail('Database unavailable');
    }
    throw err;  // No stale value, propagate the error
  }
});
```

### Stale Value and Age

The factory can inspect the stale value to make decisions:

```typescript
const data = await cacheService.getOrSet(config, params, async (ctx) => {
  if (ctx.staleValue && ctx.staleAge && ctx.staleAge < 120) {
    // Stale value is less than 2 minutes old -- good enough during high load
    return ctx.staleValue;
  }

  return await fetchFreshData(params);
});
```

## Cache Invalidation Strategies

Cache invalidation is one of the two hard problems in computer science (the other is naming things and off-by-one errors). OriJS provides several strategies.

### Direct Invalidation

Delete a specific cache entry:

```typescript
// Delete a specific monitor's cache
await cacheService.delete(MonitorCache, {
  accountUuid: 'abc',
  projectUuid: 'def',
  monitorUuid: 'ghi'
});
```

### Entity-Wide Invalidation

Delete all cache entries for an entity within a scope:

```typescript
// Invalidate all Monitor caches for a project
await cacheService.invalidate('Monitor', {
  accountUuid: 'abc',
  projectUuid: 'def'
});
```

This uses the metaParams to identify the scope. All Monitor cache entries for that account/project combination are deleted.

### Cascade Invalidation (Redis Only)

When you invalidate an entity, its dependents are automatically invalidated:

```typescript
// Invalidate an Account -- cascades to all dependent caches
await cacheService.invalidate('Account', { accountUuid: 'abc' });

// This also invalidates:
// - All Project caches under account 'abc'
// - All Monitor caches under account 'abc'
// - All User caches under account 'abc'
// - Any cache with dependsOn pointing to Account
```

Cascade invalidation works through **meta keys**. When a cache entry is stored with the Redis provider, the provider also stores which meta keys (entities) this entry depends on. The meta key is a Redis SET containing references to all dependent cache keys. When you invalidate, a Lua script atomically reads the SET, deletes all referenced cache keys, and deletes the SET itself.

### Batch Invalidation

Delete multiple entities at once:

```typescript
await cacheService.invalidateMany([
  { entityType: 'User', params: { accountUuid: 'abc' } },
  { entityType: 'Monitor', params: { accountUuid: 'abc', projectUuid: 'def' } }
]);
```

### Tag-Based Cross-Scope Invalidation

Tags enable invalidation across different entity scopes. This is useful when relationships do not follow the scope hierarchy:

```typescript
// Define entities with invalidation tags
const Entities = defineEntities({
  User: {
    name: 'User',
    scope: Scope.Account,
    param: 'userUuid',
    invalidationTags: (params) => [`user:${params.fbAuthUid}`]
  }
});

// Cache tagged with the same tag
const UserAuthCache = Cache.for(Entities.UserAuth)
  .ttl('1h')
  .tags(params => [`user:${params.fbAuthUid}`])
  .build();

// When User is invalidated, UserAuth is also invalidated
// (because they share the user:{fbAuthUid} tag)
await cacheService.invalidate('User', {
  accountUuid: 'abc',
  fbAuthUid: 'firebase-uid-123'
});
```

Tags are stored as tag meta keys (`cache:tag:{hash}`) in Redis, following the same SET-based tracking pattern as entity meta keys.

## The Redis Cache Provider

The `RedisCacheProvider` from `@orijs/cache-redis` provides the full-featured production cache backend:

```typescript
import { createRedisCacheProvider } from '@orijs/cache-redis';
import { CacheService } from '@orijs/cache';

const provider = createRedisCacheProvider({
  connection: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379')
  },
  logger: appLogger,
  connectTimeout: 2000  // Fail fast if Redis is unavailable
});

const cacheService = new CacheService(provider, {
  defaultGrace: '2m'  // Default grace period for all caches
});
```

### How Meta Keys Work in Redis

When a cache entry is stored, the provider creates associations via meta keys:

```
SET cache:{hash1} → serialized JSON value (with TTL)
SADD cache:meta:{metaHash} → cache:{hash1}     (entity's own meta key)
SADD cache:meta:{depHash}  → cache:{hash1}     (dependency meta keys)
SADD cache:tag:{tagHash}   → cache:{hash1}     (tag meta keys)
```

Meta keys have a slightly longer TTL than data keys (60 seconds buffer) to ensure they outlive the data they reference.

When invalidating:

```lua
-- Atomic Lua script
-- 1. SMEMBERS: get all cache keys from the meta key set
-- 2. DEL: delete all cache keys
-- 3. DEL: delete the meta key set itself
```

The Lua script runs atomically in Redis, preventing race conditions where new keys could be added between the lookup and deletion steps.

### Performance Characteristics

- `setWithMeta` uses a Redis pipeline (single round trip for all operations)
- `delByMeta` uses a Lua script (atomic, single round trip)
- `delByMetaMany` batches multiple meta key invalidations into a single Lua script
- Connection uses `maxRetriesPerRequest: 1` for fail-fast behavior

### vs InMemory Provider

| Feature | InMemory | Redis |
|---------|----------|-------|
| Cascade invalidation | No | Yes |
| Cross-process sharing | No | Yes |
| Persistence | No | Yes (RDB/AOF) |
| Meta key tracking | No | Yes |
| Tag-based invalidation | No | Yes |
| Setup complexity | None | Requires Redis |
| Use case | Tests, dev | Production |

## Writing a Custom Cache Provider

If you use Memcached, DynamoDB, or another key-value store, implement the `CacheProvider` interface:

```typescript
import type { CacheProvider } from '@orijs/cache';

class MemcachedCacheProvider implements CacheProvider {
  constructor(private readonly client: MemcachedClient) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.client.set(key, serialized, ttlSeconds);
  }

  async del(key: string): Promise<number> {
    const deleted = await this.client.delete(key);
    return deleted ? 1 : 0;
  }

  async delMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const deleted = await this.client.delete(key);
      if (deleted) count++;
    }
    return count;
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.client.get(key);
    return value !== null;
  }

  async ttl(key: string): Promise<number> {
    // Memcached doesn't support TTL queries natively
    // Return -1 (no expiry info available)
    const exists = await this.exists(key);
    return exists ? -1 : -2;
  }
}
```

Use it with `CacheService`:

```typescript
const provider = new MemcachedCacheProvider(memcachedClient);
const cacheService = new CacheService(provider);

// All cache operations work -- getOrSet, invalidate, grace periods, singleflight
// Only cascade invalidation is unavailable (requires CacheProviderWithMeta)
```

If your custom store can support dependency tracking, also implement `CacheProviderWithMeta`:

```typescript
class DynamoDBCacheProviderWithMeta implements CacheProviderWithMeta {
  // ... base CacheProvider methods ...

  async setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void> {
    // Store value in main table
    await this.dynamodb.put({ TableName: 'cache', Item: { key, value: JSON.stringify(value), ttl: ttlSeconds } });
    // Store meta key associations in dependency table
    for (const metaKey of metaKeys) {
      await this.dynamodb.put({ TableName: 'cache-deps', Item: { metaKey, cacheKey: key } });
    }
  }

  async delByMeta(metaKey: string): Promise<number> {
    // Query dependency table for all cache keys
    const deps = await this.dynamodb.query({ TableName: 'cache-deps', KeyConditionExpression: 'metaKey = :mk', ExpressionAttributeValues: { ':mk': metaKey } });
    // Delete all cache keys
    let deleted = 0;
    for (const dep of deps.Items) {
      await this.dynamodb.delete({ TableName: 'cache', Key: { key: dep.cacheKey } });
      deleted++;
    }
    // Delete meta key entries
    for (const dep of deps.Items) {
      await this.dynamodb.delete({ TableName: 'cache-deps', Key: { metaKey, cacheKey: dep.cacheKey } });
    }
    return deleted;
  }

  async delByMetaMany(metaKeys: string[]): Promise<number> {
    let total = 0;
    for (const metaKey of metaKeys) {
      total += await this.delByMeta(metaKey);
    }
    return total;
  }
}
```

## Real-World Example: Monitoring Application

Here is a complete cache setup for a monitoring application, showing how entities, scopes, dependencies, and invalidation work together:

```typescript
// cache-config.ts
import { defineScopes, defineEntities, EntityRegistry, createCacheBuilder } from '@orijs/cache';

export const Scope = defineScopes({
  Global:  { name: 'global' },
  Account: { name: 'account', param: 'accountUuid' },
  Project: { name: 'project', param: 'projectUuid' },
});

export const Entities = defineEntities({
  Account:           { name: 'Account',           scope: Scope.Account },
  Project:           { name: 'Project',           scope: Scope.Project },
  User:              { name: 'User',              scope: Scope.Account,  param: 'userUuid' },
  Monitor:           { name: 'Monitor',           scope: Scope.Project,  param: 'monitorUuid' },
  MonitorConfig:     { name: 'MonitorConfig',     scope: Scope.Project,  param: 'monitorUuid' },
  MonitorSnapshot:   { name: 'MonitorSnapshot',   scope: Scope.Project,  param: 'monitorUuid' },
  Incident:          { name: 'Incident',          scope: Scope.Project,  param: 'incidentUuid' },
  AlertConfig:       { name: 'AlertConfig',       scope: Scope.Project },
  MonitorList:       { name: 'MonitorList',       scope: Scope.Project },
});

const registry = EntityRegistry.create()
  .scopes(Scope)
  .entities(Entities)
  .build();

export const Cache = createCacheBuilder(registry);

// Cache definitions
export const AccountCache = Cache.for(Entities.Account).ttl('1h').grace('5m').build();
export const UserCache = Cache.for(Entities.User).ttl('30m').grace('5m').build();
export const MonitorCache = Cache.for(Entities.Monitor).ttl('5m').grace('1m').build();

export const MonitorConfigCache = Cache.for(Entities.MonitorConfig)
  .ttl('15m')
  .grace('2m')
  .dependsOn(Entities.Monitor)
  .build();

export const MonitorSnapshotCache = Cache.for(Entities.MonitorSnapshot)
  .ttl('1m')
  .grace('30s')
  .dependsOn(Entities.Monitor)
  .build();

export const MonitorListCache = Cache.for(Entities.MonitorList)
  .ttl('5m')
  .grace('1m')
  .build();

export const AlertConfigCache = Cache.for(Entities.AlertConfig)
  .ttl('30m')
  .grace('5m')
  .build();
```

```typescript
// monitor-repository.ts -- Using cache in a repository
import { CacheService } from '@orijs/cache';
import { MonitorCache, MonitorListCache, MonitorConfigCache } from './cache-config';

class MonitorRepository {
  constructor(
    private cacheService: CacheService,
    private dbService: MonitorDbService
  ) {}

  async getMonitor(params: { accountUuid: string; projectUuid: string; monitorUuid: string }) {
    return this.cacheService.getOrSet(MonitorCache, params, async (ctx) => {
      const monitor = await this.dbService.findByUuid(params);
      if (!monitor) return ctx.skip();
      return monitor;
    });
  }

  async getMonitorsForProject(params: { accountUuid: string; projectUuid: string }) {
    return this.cacheService.getOrSet(MonitorListCache, params, async (ctx) => {
      try {
        return await this.dbService.findAllByProject(params);
      } catch (err) {
        // During database issues, serve stale list rather than show error
        if (ctx.staleValue) return ctx.fail('Database unavailable');
        throw err;
      }
    });
  }

  async updateMonitor(params: { accountUuid: string; projectUuid: string; monitorUuid: string }, data: UpdateMonitorInput) {
    await this.dbService.update(params, data);

    // Invalidate this monitor's cache -- cascades to MonitorConfig, MonitorSnapshot
    await this.cacheService.invalidate('Monitor', {
      accountUuid: params.accountUuid,
      projectUuid: params.projectUuid
    });

    // Also invalidate the monitor list for the project
    await this.cacheService.invalidate('MonitorList', {
      accountUuid: params.accountUuid,
      projectUuid: params.projectUuid
    });
  }
}
```

## Duration Syntax

Cache durations use a human-readable format:

```typescript
'30s'   // 30 seconds
'1m'    // 1 minute
'5m'    // 5 minutes
'15m'   // 15 minutes
'1h'    // 1 hour
'6h'    // 6 hours
'1d'    // 1 day
'7d'    // 7 days
300     // 300 seconds (numeric)
```

The builder provides compile-time checking with the `DefaultTTL` type, which restricts to common values (`'30s'`, `'1m'`, `'5m'`, `'15m'`, `'30m'`, `'1h'`, `'6h'`, `'12h'`, `'1d'`, `'7d'`). If you need custom values, you can override the type constraint:

```typescript
// Default -- only allows pre-defined TTL values
Cache.for(Entities.Product).ttl('5m').build();    // OK
Cache.for(Entities.Product).ttl('32m').build();   // Type error

// Custom -- define your own allowed values
type MyTTL = '2m' | '32m' | '2h';
Cache.for(Entities.Product).ttl<MyTTL>('32m').build();  // OK

// Numeric always works
Cache.for(Entities.Product).ttl(1920).build();    // OK (32 minutes in seconds)
```

## Cache Key Generation

Cache keys are deterministic hashes generated from the entity name and parameters:

```typescript
import { generateCacheKey } from '@orijs/cache';

const key = generateCacheKey(MonitorCache, {
  accountUuid: 'abc-123',
  projectUuid: 'def-456',
  monitorUuid: 'ghi-789'
});
// key = 'cache:7h5g8k2m4n1p'  (hash of entity name + sorted params)
```

Keys use Bun's native `Bun.hash()` (wyhash algorithm) for fast, deterministic hashing. The hash input is a `fast-json-stable-stringify` of the entity name and extracted parameters, ensuring the same parameters always produce the same key regardless of property insertion order.

**Missing parameter detection:** If you forget to provide a required parameter, the key generator throws immediately instead of silently generating a key that would collide with other entries:

```typescript
// This throws: "Missing required cache params for 'Monitor': monitorUuid"
generateCacheKey(MonitorCache, {
  accountUuid: 'abc-123',
  projectUuid: 'def-456'
  // monitorUuid is missing!
});
```

## Summary

The OriJS cache system solves the hard problems of production caching:

- **Provider-based architecture** -- swap InMemory for Redis without changing application code
- **Entity-based keys** -- consistent, discoverable, impossible to construct incorrectly
- **Singleflight** -- one database query per cache miss, not one per concurrent request
- **Grace periods** -- serve stale data during failures instead of showing errors
- **Factory context** -- skip caching, fail gracefully, inspect stale values
- **Cascade invalidation** -- entity dependencies tracked automatically via meta keys
- **Tag-based invalidation** -- cross-scope invalidation without coupling cache definitions
- **Custom providers** -- implement `CacheProvider` for any key-value store

The cache system is designed to make the easy case simple (`Cache.for(entity).ttl('5m').build()`) while giving you full control for complex cases (custom timeouts, grace periods, dependency graphs, tag-based invalidation).

---

[Previous: WebSockets <-](./13-websockets.md) | [Next: Logging ->](./15-logging.md)
