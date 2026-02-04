# Caching

OriJS provides a multi-level caching system with entity-based organization, cascade invalidation, and thundering herd prevention.

---

## Overview

The caching system features:

- **Entity-based cache keys** - Organize cache around domain entities with auto-derived params
- **TTL and grace periods** - Control cache lifetime and stale-while-revalidate behavior
- **Singleflight** - Prevent thundering herd on cache miss (deduplicate concurrent requests)
- **Cascade invalidation** - Automatically invalidate dependent caches via meta keys
- **Tag-based invalidation** - Cross-scope cache invalidation via shared tags
- **Factory context** - Skip caching, fail gracefully, access stale values
- **Type-safe configuration** - Builder API with compile-time validation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CacheService                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
│  │ getOrSet()  │  │ invalidate()│  │    Singleflight             │ │
│  │   get()     │  │ invalidate- │  │  (thundering herd)          │ │
│  │   set()     │  │    Many()   │  │                             │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┬──────────────┘ │
│         │                │                         │                │
│         └────────────────┴─────────────────────────┘                │
│                                 │                                    │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
            ┌───────┴───────┐         ┌────────┴────────┐
            │ InMemory      │         │ Redis           │
            │ CacheProvider │         │ CacheProvider   │
            │ (testing)     │         │ (production)    │
            └───────────────┘         └─────────────────┘
                                             │
                                      ┌──────┴──────┐
                                      │ Meta Keys   │
                                      │ (cascade)   │
                                      └─────────────┘
```

---

## Entity Registry Setup

Before defining caches, set up your entity registry with scopes and entities:

```typescript
import { EntityRegistry, defineScopes, defineEntities, createCacheBuilder } from '@orijs/cache';

// 1. Define scopes (hierarchy with param inheritance)
const Scope = defineScopes({
	Global: { name: 'global' },
	Account: { name: 'account', param: 'accountUuid' },
	Project: { name: 'project', param: 'projectUuid' }
});

// 2. Define entities (associated with scopes)
const Entities = defineEntities({
	Account: { name: 'Account', scope: Scope.Account },
	Project: { name: 'Project', scope: Scope.Project },
	User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
	Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
	Check: { name: 'Check', scope: Scope.Project, param: 'checkUuid' },
	MonitorList: { name: 'MonitorList', scope: Scope.Project }
});

// 3. Build registry
const registry = EntityRegistry.create().scopes(Scope).entities(Entities).build();

// 4. Create cache builder bound to registry
const Cache = createCacheBuilder(registry);
```

### Scope Hierarchy

Scopes form a hierarchy with param inheritance:

```
global         → []
  account      → [accountUuid]
    project    → [accountUuid, projectUuid]
```

When you define an entity at `project` scope with `param: 'monitorUuid'`, its full params are auto-derived: `['accountUuid', 'projectUuid', 'monitorUuid']`.

---

## Defining Cache Configurations

### Basic Cache Setup

```typescript
// Simple cache - everything auto-derived from registry
const UserCache = Cache.for(Entities.User).ttl('10m').build();

// UserCache.params = ['accountUuid', 'userUuid']
// UserCache.metaParams = ['accountUuid']
// UserCache.dependsOn = { Account: ['accountUuid'] }
```

### TTL Format

Use human-readable duration strings:

| Format  | Example | Description |
| ------- | ------- | ----------- |
| Seconds | `'30s'` | 30 seconds  |
| Minutes | `'5m'`  | 5 minutes   |
| Hours   | `'2h'`  | 2 hours     |
| Days    | `'7d'`  | 7 days      |
| Numeric | `300`   | 300 seconds |

### Pre-defined TTL Values

The builder enforces type-safe TTL values by default:

```typescript
type DefaultTTL = '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '6h' | '12h' | '1d' | '7d';

// These work:
Cache.for(Entities.User).ttl('5m').build(); // OK
Cache.for(Entities.User).ttl(300).build(); // OK (numeric always allowed)

// Custom TTL type when needed:
type MyTTL = '2m' | '32m' | '2h';
Cache.for(Entities.User).ttl<MyTTL>('32m').build(); // OK
```

### Full Configuration Options

```typescript
const MonitorCache = Cache.for(Entities.Monitor)
	.ttl('5m') // Required: time-to-live
	.grace('1m') // Optional: stale-while-revalidate window
	.timeout('10s') // Optional: fetch timeout (default 1s)
	.cacheNull() // Optional: cache null/undefined results
	.dependsOn(Entities.Project) // Optional: additional dependency
	.build();
```

---

## CacheService Operations

### Creating CacheService

```typescript
import { CacheService } from '@orijs/cache';
import { RedisCacheProvider } from '@orijs/cache-redis';

// Production: Redis provider
const provider = new RedisCacheProvider({
	connection: { host: 'localhost', port: 6379 },
	logger: myLogger,
	connectTimeout: 2000 // Fail fast
});

const cacheService = new CacheService(provider, {
	defaultGrace: '30s' // Default grace period if not specified per-cache
});

// Testing: In-memory provider
import { InMemoryCacheProvider } from '@orijs/cache';
const testProvider = new InMemoryCacheProvider();
const testCacheService = new CacheService(testProvider);
```

### getOrSet Pattern (Primary Method)

The most common pattern - get from cache, or compute and cache:

```typescript
class UserService {
	constructor(
		private cache: CacheService,
		private db: DatabaseService
	) {}

	async getUser(accountUuid: string, userUuid: string): Promise<User | undefined> {
		return await this.cache.getOrSet(
			UserCache,
			{ accountUuid, userUuid }, // Must match cache params
			async (ctx) => {
				// Factory runs on cache miss or stale
				const user = await this.db.findUser(userUuid);

				// Don't cache if not found
				if (!user) return ctx.skip();

				return user;
			}
		);
	}
}
```

### Cache Entry Lifecycle

```
Timeline: |-------- TTL --------|-------- Grace --------|--- Expired ---|
          ^                     ^                       ^
          createdAt             expiresAt               graceExpiresAt

FRESH (now < expiresAt):
  - Return cached value immediately
  - No factory call

STALE (expiresAt <= now < graceExpiresAt):
  - Call factory to revalidate
  - Factory receives staleValue and staleAge in context
  - If factory succeeds: cache new value, return it
  - If factory fails/times out: return stale value as fallback

EXPIRED (now >= graceExpiresAt) or MISS (no entry):
  - Call factory to compute value
  - No stale fallback available
  - If factory fails: error propagates to caller
```

---

## Factory Context

The factory function receives a context object with powerful control methods:

### ctx.skip() - Don't Cache This Result

```typescript
async (ctx) => {
	const user = await this.db.findUser(userUuid);

	// User not found - don't cache undefined, don't return cached value
	if (!user) return ctx.skip();

	return user;
};
```

### ctx.fail() - Graceful Degradation

```typescript
async (ctx) => {
	try {
		return await this.externalApi.fetchData();
	} catch (error) {
		// If we have stale data, signal failure but use stale
		if (ctx.staleValue !== undefined) {
			return ctx.fail('External API unavailable');
		}
		// No stale data - propagate the error
		throw error;
	}
};
```

### ctx.staleValue and ctx.staleAge

```typescript
async (ctx) => {
	// Access stale value during grace period
	if (ctx.staleValue !== undefined) {
		console.log(`Refreshing stale value (${ctx.staleAge}s old)`);

		// Optionally use stale value in computation
		const refreshed = await this.db.refreshFrom(ctx.staleValue);
		return refreshed;
	}

	// No stale value - full fetch
	return await this.db.fullFetch();
};
```

---

## Singleflight (Thundering Herd Prevention)

Singleflight prevents duplicate concurrent requests for the same key. When multiple callers request the same cache key simultaneously:

1. First caller executes the factory function
2. Subsequent callers wait for and share the same result
3. Only one computation happens per key

### How It Works

```
Time 0ms:  Request A arrives for key "user:123" → Starts factory
Time 5ms:  Request B arrives for key "user:123" → Waits for A's result
Time 10ms: Request C arrives for key "user:123" → Waits for A's result
Time 50ms: Factory completes → All three requests get the same result

Without singleflight: 3 database queries
With singleflight: 1 database query
```

### Built-in to CacheService

CacheService uses singleflight automatically:

```typescript
// These concurrent calls result in only ONE database query
const [user1, user2, user3] = await Promise.all([
	userService.getUser('account-1', 'user-123'),
	userService.getUser('account-1', 'user-123'),
	userService.getUser('account-1', 'user-123')
]);
// All three get the same user object
```

### Direct Singleflight Usage

For use cases outside CacheService:

```typescript
import { Singleflight, globalSingleflight } from '@orijs/cache';

// Use global instance for simple cases
const result = await globalSingleflight.do('expensive-operation', async () => {
	return await computeExpensiveValue();
});

// Create separate instance for isolation
const sf = new Singleflight();

const [a, b, c] = await Promise.all([
	sf.do('compute-key', () => expensiveComputation()),
	sf.do('compute-key', () => expensiveComputation()),
	sf.do('compute-key', () => expensiveComputation())
]);
// Only one computation runs
```

### Error Caching in Singleflight

Standalone Singleflight caches errors to prevent thundering herd on failures:

```typescript
// Configure error TTL (default: 5 seconds)
const sf = new Singleflight({ errorTtlMs: 10000 });

// First call fails - error is cached
try {
	await sf.do('failing-key', async () => {
		throw new Error('Database connection failed');
	});
} catch (e) {
	// Error thrown
}

// Subsequent calls get cached error without executing
try {
	await sf.do('failing-key', async () => {
		return 'would succeed now'; // Never runs - cached error is thrown
	});
} catch (e) {
	// Same error thrown
}

// Clear error to allow retry
sf.forgetError('failing-key');
// Or wait for errorTtlMs to expire
```

**Note**: CacheService disables error caching (`errorTtlMs: 0`) because it has its own error handling with grace period fallback.

### Singleflight Methods

```typescript
const sf = new Singleflight({ errorTtlMs: 5000 });

// Execute with singleflight protection
await sf.do(key, factory);

// Check if request is in-flight
sf.isInflight(key);

// Check if error is cached
sf.hasError(key);

// Clear in-flight request AND cached error
sf.forget(key);

// Clear only cached error
sf.forgetError(key);

// Monitoring
sf.getInflightCount();
sf.getErrorCount();

// Reset (for testing)
sf.clear();
```

---

## Grace Periods (Stale-While-Revalidate)

Grace periods allow serving stale data while refreshing in the background:

```typescript
const MonitorCache = Cache.for(Entities.Monitor)
	.ttl('5m') // Fresh for 5 minutes
	.grace('1m') // Serve stale for 1 more minute while refreshing
	.build();
```

### Grace Period Behavior

1. **0-5 minutes** (Fresh): Return cached value immediately
2. **5-6 minutes** (Stale): Call factory, return stale on timeout/failure
3. **After 6 minutes** (Expired): Cache miss, wait for factory

### Timeout Handling

```typescript
const SlowDataCache = Cache.for(Entities.SlowData)
	.ttl('10m')
	.grace('2m')
	.timeout('30s') // Allow longer timeout for slow sources (default: 1s)
	.build();
```

If factory exceeds timeout:

- **During grace period**: Return stale value
- **After grace/no stale**: Throw `CacheTimeoutError`

---

## Cache Dependencies

### Auto-Derived Hierarchy Dependencies

Entities automatically depend on their scope hierarchy:

```typescript
const MonitorCache = Cache.for(Entities.Monitor).ttl('5m').build();

// Auto-derived dependencies:
// MonitorCache.dependsOn = {
//   Account: ['accountUuid'],
//   Project: ['accountUuid', 'projectUuid']
// }
```

### Explicit Sibling Dependencies

For same-level entity dependencies:

```typescript
// MonitorStats depends on Monitor (both at project scope)
const MonitorStatsCache = Cache.for(Entities.MonitorStats)
	.ttl('1m')
	.dependsOn(Entities.Monitor) // Params auto-derived from registry
	.build();

// MonitorStatsCache.dependsOn includes:
// - Account, Project (hierarchy)
// - Monitor: ['accountUuid', 'projectUuid', 'monitorUuid']
```

### Explicit Params Override

When dependent entity uses different param names:

```typescript
const OrderCache = Cache.for(Entities.Order)
	.ttl('10m')
	.dependsOn(Entities.Product, ['accountUuid', 'projectUuid', 'orderProductUuid'])
	.build();
```

---

## Cascade Invalidation

### How Cascade Works

When you invalidate an entity, all dependent caches are also cleared:

```
Project invalidated
    ↓
Monitor cache cleared (depends on Project)
    ↓
Check cache cleared (depends on Monitor)
    ↓
MonitorStats cache cleared (depends on Monitor)
```

### Meta Keys (Redis Implementation)

Cascade invalidation uses Redis sets called "meta keys":

1. When setting a cache entry, its key is added to meta key sets for each dependency
2. When invalidating, SMEMBERS retrieves all dependent cache keys
3. All dependent keys are deleted atomically via Lua script

```
Meta Key: cache:meta:{hash(Account:abc)}
Contains: [cache:xyz1, cache:xyz2, cache:xyz3]  // All caches depending on Account abc

When Account abc changes:
1. Lookup meta key
2. Get all member cache keys
3. Delete all cache keys atomically
4. Delete meta key
```

### Invalidation Methods

```typescript
// Single entity invalidation (cascades by default)
await cacheService.invalidate('User', { accountUuid: 'abc' });

// Non-cascading invalidation
await cacheService.invalidate('UserPresence', { accountUuid, userUuid }, { cascade: false });

// Batch invalidation (more efficient)
await cacheService.invalidateMany([
	{ entityType: 'User', params: { accountUuid: 'abc' } },
	{ entityType: 'Project', params: { accountUuid: 'abc', projectUuid: 'def' } }
]);
```

### Usage in Services

```typescript
class ProjectService {
	async updateProject(projectId: string, data: UpdateProjectDto): Promise<void> {
		await this.db.updateProject(projectId, data);

		// This invalidates:
		// - Project cache for this project
		// - Monitor caches (depends on Project)
		// - Check caches (depends on Monitor)
		// - Any other caches that depend on Project
		await this.cache.invalidate('Project', {
			accountUuid: data.accountUuid,
			projectUuid: projectId
		});
	}

	async deleteMonitor(projectId: string, monitorId: string): Promise<void> {
		await this.db.deleteMonitor(monitorId);

		// Invalidate specific monitor AND the list cache
		await this.cacheService.invalidateMany([
			{ entityType: 'Monitor', params: { projectUuid: projectId, monitorUuid: monitorId } },
			{ entityType: 'MonitorList', params: { projectUuid: projectId } }
		]);
	}
}
```

---

## Tag-Based Cross-Scope Invalidation

Sometimes you need to invalidate caches that don't fit the normal scope hierarchy. Tags enable cross-scope invalidation where a cache at one scope level can be cleared when an entity at a different scope is invalidated.

### The Problem

Consider authentication caching:

```typescript
// User entity is at account scope (requires accountUuid + fbAuthUid)
const UserCache = Cache.for(Entities.User).ttl('1h').build();

// But auth guards only have fbAuthUid from the Firebase token
// We need a global cache keyed by fbAuthUid only
const UserAuthCache = Cache.for(Entities.UserAuth).ttl('1h').build();
// UserAuth is at global scope (only fbAuthUid)
```

When `User` is invalidated, how do we clear `UserAuthCache`? They're at different scopes with different params.

### Solution: Tags

Tags create a secondary invalidation path that crosses scope boundaries.

#### 1. Define Entity with invalidationTags

```typescript
const Entities = defineEntities({
	User: {
		name: 'User',
		scope: Scope.Account,
		param: 'fbAuthUid',
		// When User is invalidated, also invalidate this tag
		invalidationTags: (params) => [`user:${params.fbAuthUid}`]
	},
	UserAuth: {
		name: 'UserAuth',
		scope: Scope.Global,
		param: 'fbAuthUid'
	}
});
```

#### 2. Configure Cache with .tags()

```typescript
// UserAuth cache is tagged - will be cleared when matching tag is invalidated
const UserAuthCache = Cache.for(Entities.UserAuth)
	.ttl('1h')
	.tags((params) => [`user:${params.fbAuthUid}`])
	.build();

// User cache can also be tagged for consistency
const UserCache = Cache.for(Entities.User)
	.ttl('1h')
	.tags((params) => [`user:${params.fbAuthUid}`])
	.build();
```

#### 3. Invalidation Cascades via Tags

```typescript
// When User is invalidated...
await cacheService.invalidate('User', { accountUuid: 'abc', fbAuthUid: 'user-123' });

// This happens:
// 1. User cache entry is cleared (normal invalidation)
// 2. Tag `user:user-123` is invalidated (from entity's invalidationTags)
// 3. UserAuth cache entry is cleared (because it's tagged with `user:user-123`)
```

### Complete Example: Two-Step Auth Caching

```typescript
// Repository with two-step caching for auth
class UserRepositoryService {
	private readonly UserCache: CacheConfig<UserCacheParams>;
	private readonly UserAuthCache: CacheConfig<UserAuthCacheParams>;

	constructor(cacheRegistry: CacheRegistry) {
		// Full user cache (account-scoped)
		this.UserCache = cacheRegistry.builder
			.for(Entities.User)
			.ttl('1h')
			.tags((params) => [`user:${params.fbAuthUid}`])
			.build();

		// Auth lookup cache (global, keyed by fbAuthUid only)
		this.UserAuthCache = cacheRegistry.builder
			.for(Entities.UserAuth)
			.ttl('1h')
			.tags((params) => [`user:${params.fbAuthUid}`])
			.build();
	}

	// Called by auth guard (only has fbAuthUid from token)
	async getUserForAuth(fbUid: string): Promise<UserWithRoles | undefined> {
		// Step 1: Get accountUuid from UserAuth cache
		const userAuth = await this.cacheService.getOrSet(
			this.UserAuthCache,
			{ fbAuthUid: fbUid },
			async (ctx) => {
				const user = await this.db.getUserByFbUid(fbUid);
				if (!user) return ctx.skip();
				return { fbAuthUid: fbUid, accountUuid: user.accountUuid };
			}
		);

		if (!userAuth) return undefined;

		// Step 2: Get full user with complete params
		return this.getUser({
			accountUuid: userAuth.accountUuid,
			fbAuthUid: fbUid
		});
	}

	// Invalidation clears both caches via tags
	async invalidateUser(params: UserCacheParams): Promise<void> {
		await this.cacheService.invalidate(Entities.User.name, params);
		// UserAuth is automatically cleared via tag `user:${params.fbAuthUid}`
	}
}
```

### Tag Best Practices

1. **Use consistent tag formats**: `entity:identifier` (e.g., `user:abc123`)
2. **Tags are for cross-scope only**: Use normal dependencies for same-scope relationships
3. **Keep tags simple**: One or two tags per entity, not complex combinations
4. **Tags are additive**: An entity can have both `invalidationTags` and normal `dependsOn`

### How Tags Work Internally

```
When setting cache entry with tags:
1. Generate tag meta keys: cache:tag:{hash(tag)}
2. Add cache key to tag's meta set (same as dependency meta keys)

When invalidating entity with invalidationTags:
1. Normal cascade invalidation via dependency meta keys
2. Get invalidationTags from entity definition
3. Delete all cache keys in each tag's meta set
```

---

## Cache Patterns

### Read-Through (Default)

The `getOrSet` pattern - check cache, compute on miss:

```typescript
async getUser(id: string): Promise<User | undefined> {
  return await this.cache.getOrSet(UserCache, { id }, () => this.db.getUser(id));
}
```

### Write-Through

Update cache immediately on write:

```typescript
async updateUser(id: string, data: UpdateDto): Promise<User> {
  const user = await this.db.updateUser(id, data);

  // Option 1: Invalidate (safer - next read gets fresh data)
  await this.cache.invalidate('User', { id });

  // Option 2: Update directly (faster but consistency risk)
  // await this.cache.set(UserCache, { id }, user);

  return user;
}
```

### Write-Behind (Async Invalidation)

For high-throughput writes where slight staleness is acceptable:

```typescript
async updateUser(id: string, data: UpdateDto): Promise<User> {
  const user = await this.db.updateUser(id, data);

  // Non-blocking invalidation
  this.cache.invalidate('User', { id }).catch(err => {
    this.logger.warn('Cache invalidation failed', { id, error: err });
  });

  return user;
}
```

### Cache-Aside with Prefetch

Prefetch related data in parallel:

```typescript
async getProjectWithMonitors(projectId: string): Promise<ProjectWithMonitors> {
  const [project, monitors] = await Promise.all([
    this.cache.getOrSet(ProjectCache, { projectId }, () => this.db.getProject(projectId)),
    this.cache.getOrSet(MonitorListCache, { projectId }, () => this.db.listMonitors(projectId)),
  ]);

  return { ...project, monitors };
}
```

### Computed Cache (Derived Values)

Cache expensive computations that depend on multiple sources:

```typescript
const ProjectStatsCache = Cache.for(Entities.ProjectStats)
  .ttl('1m')
  .dependsOn(Entities.Monitor)  // Invalidate when monitors change
  .dependsOn(Entities.Check)    // Invalidate when checks change
  .build();

async getProjectStats(projectId: string): Promise<ProjectStats> {
  return await this.cache.getOrSet(
    ProjectStatsCache,
    { projectId },
    async () => {
      // Expensive aggregation
      const monitors = await this.db.listMonitors(projectId);
      const recentChecks = await this.db.getRecentChecks(projectId, 1000);
      return computeStats(monitors, recentChecks);
    }
  );
}
```

---

## Direct Cache Operations

For cases where you need direct cache control:

```typescript
// Get without factory (returns undefined if miss)
const user = await cacheService.get<User>(UserCache, { userId });

// Set directly
await cacheService.set(UserCache, { userId }, userData);

// Delete specific entry
const deleted = await cacheService.delete(UserCache, { userId });
```

---

## Best Practices

### 1. Cache at the Right Level

```typescript
// GOOD - cache business entities
const UserCache = Cache.for(Entities.User).ttl('10m').build();

// BAD - caching raw SQL results
const SqlCache = Cache.for({ name: 'sql-results' }).ttl('5m').build();
```

### 2. Choose Appropriate TTLs

| Data Type      | Recommended TTL | Grace |
| -------------- | --------------- | ----- |
| Static config  | 1h - 24h        | 5m    |
| User profiles  | 5m - 15m        | 1m    |
| Lists/indexes  | 1m - 5m         | 30s   |
| Real-time data | 10s - 30s       | 10s   |

### 3. Always Invalidate on Mutations

```typescript
// GOOD - explicit invalidation
async updateUser(id: string, data: UpdateDto): Promise<User> {
  const user = await this.db.updateUser(id, data);
  await this.cache.invalidate('User', { id });
  return user;
}

// BAD - relying only on TTL expiration
async updateUser(id: string, data: UpdateDto): Promise<User> {
  return await this.db.updateUser(id, data);
  // Cache serves stale data until TTL expires!
}
```

### 4. Use Dependencies Correctly

```typescript
// Configure dependency tree properly
const ProjectCache = Cache.for(Entities.Project).ttl('10m').build();
const MonitorCache = Cache.for(Entities.Monitor).ttl('5m').build(); // Auto-depends on Project
const CheckCache = Cache.for(Entities.Check).ttl('30s').dependsOn(Entities.Monitor).build();

// Now: invalidating Project cascades to Monitor and Check
```

### 5. Handle Cache Failures Gracefully

```typescript
async getUser(id: string): Promise<User | undefined> {
  try {
    return await this.cache.getOrSet(UserCache, { id }, async (ctx) => {
      return await this.db.getUser(id);
    });
  } catch (error) {
    // Cache or DB failure - decide on fallback behavior
    this.logger.error('Failed to get user', { id, error });

    // Option: Return undefined and let caller handle
    return undefined;

    // Option: Rethrow for caller to handle
    // throw error;
  }
}
```

### 6. Avoid Cache Key Collisions

```typescript
// GOOD - all params specified
await this.cache.getOrSet(UserCache, { accountUuid, userUuid }, factory);

// BAD - missing required param throws error
await this.cache.getOrSet(UserCache, { userUuid }, factory); // Error!

// The builder enforces this - all declared params must be provided
```

### 7. Use cacheNull() Sparingly

```typescript
// Only cache null when it's a valid, cacheable state
const UserPreferencesCache = Cache.for(Entities.UserPreferences)
	.ttl('5m')
	.cacheNull() // User might not have preferences yet - that's valid
	.build();

// Don't cache null for "not found" - use ctx.skip() instead
async (ctx) => {
	const user = await this.db.findUser(id);
	if (!user) return ctx.skip(); // Don't cache missing users
	return user;
};
```

---

## Production Considerations

### Redis Provider Configuration

```typescript
const provider = new RedisCacheProvider({
	connection: {
		host: process.env.REDIS_HOST,
		port: parseInt(process.env.REDIS_PORT || '6379')
	},
	logger: appLogger,
	connectTimeout: 2000 // Fail fast on connection issues
});
```

### Graceful Shutdown

```typescript
async function shutdown() {
	await cacheProvider.stop(); // Close Redis connection
}
```

### Monitoring Cache Hit Rates

```typescript
// Log cache misses for monitoring
async (ctx) => {
	this.logger.debug('Cache miss', {
		entity: 'User',
		params: { accountUuid, userUuid },
		hasStale: ctx.staleValue !== undefined,
		staleAge: ctx.staleAge
	});

	return await this.db.getUser(userUuid);
};
```

### High-Throughput Batch Operations

```typescript
// Batch get with parallel singleflights
async getUsers(accountUuid: string, userUuids: string[]): Promise<User[]> {
  const results = await Promise.all(
    userUuids.map(userUuid =>
      this.cache.getOrSet(
        UserCache,
        { accountUuid, userUuid },
        () => this.db.getUser(userUuid)
      )
    )
  );

  return results.filter((u): u is User => u !== undefined);
}
```

---

## Testing Cache Behavior

### Unit Testing with InMemory Provider

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { CacheService, InMemoryCacheProvider } from '@orijs/cache';

describe('UserService caching', () => {
	let cacheService: CacheService;
	let provider: InMemoryCacheProvider;
	let db: { getUser: ReturnType<typeof mock> };
	let userService: UserService;

	beforeEach(() => {
		provider = new InMemoryCacheProvider();
		cacheService = new CacheService(provider);
		db = {
			getUser: mock(() => Promise.resolve({ id: '1', name: 'Alice' }))
		};
		userService = new UserService(cacheService, db as any);
	});

	it('should cache user on first fetch', async () => {
		const user = await userService.getUser('account-1', 'user-1');
		expect(user?.name).toBe('Alice');
		expect(db.getUser).toHaveBeenCalledTimes(1);

		// Second call should hit cache
		await userService.getUser('account-1', 'user-1');
		expect(db.getUser).toHaveBeenCalledTimes(1); // Still 1
	});

	it('should invalidate cache on update', async () => {
		// Prime the cache
		await userService.getUser('account-1', 'user-1');
		expect(db.getUser).toHaveBeenCalledTimes(1);

		// Update triggers invalidation
		await userService.updateUser('account-1', 'user-1', { name: 'Bob' });

		// Should fetch fresh data
		await userService.getUser('account-1', 'user-1');
		expect(db.getUser).toHaveBeenCalledTimes(2);
	});

	it('should return undefined and not cache when skip() called', async () => {
		db.getUser = mock(() => Promise.resolve(null));

		const user = await userService.getUser('account-1', 'user-1');
		expect(user).toBeUndefined();

		// Call again - should still try DB because nothing was cached
		await userService.getUser('account-1', 'user-1');
		expect(db.getUser).toHaveBeenCalledTimes(2);
	});
});
```

### Testing Singleflight

```typescript
describe('singleflight behavior', () => {
	it('should deduplicate concurrent requests', async () => {
		let callCount = 0;
		db.getUser = mock(async () => {
			callCount++;
			await new Promise((r) => setTimeout(r, 50)); // Slow DB
			return { id: '1', name: 'Alice' };
		});

		// Three concurrent requests
		const [r1, r2, r3] = await Promise.all([
			userService.getUser('account-1', 'user-1'),
			userService.getUser('account-1', 'user-1'),
			userService.getUser('account-1', 'user-1')
		]);

		// Only one DB call
		expect(callCount).toBe(1);

		// All get same result
		expect(r1).toEqual(r2);
		expect(r2).toEqual(r3);
	});
});
```

### Testing Grace Period Fallback

```typescript
describe('grace period', () => {
	it('should return stale value on factory timeout', async () => {
		// Configure cache with grace period
		const cache = Cache.for(Entities.User)
			.ttl('1s')
			.grace('10s')
			.timeout('100ms') // Short timeout
			.build();

		// Prime cache
		await cacheService.set(cache, { userId: '1' }, { name: 'Original' });

		// Wait for TTL to expire (now in grace period)
		await new Promise((r) => setTimeout(r, 1100));

		// Factory times out
		db.getUser = mock(async () => {
			await new Promise((r) => setTimeout(r, 500)); // Longer than timeout
			return { name: 'New' };
		});

		// Should return stale value
		const user = await cacheService.getOrSet(cache, { userId: '1' }, async () => {
			return await db.getUser();
		});

		expect(user.name).toBe('Original'); // Stale value returned
	});
});
```

### Functional Testing with Redis

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createRedisTestHelper } from '@orijs/test-utils';
import { RedisCacheProvider, CacheService } from '@orijs/cache-redis';

describe('Cache with Redis', () => {
	let redisHelper: RedisTestHelper;
	let cacheService: CacheService;

	beforeAll(async () => {
		redisHelper = createRedisTestHelper('cache-tests');
		if (!redisHelper.isReady()) {
			throw new Error('Redis not ready');
		}

		const provider = new RedisCacheProvider({
			connection: redisHelper.getConnectionConfig()
		});
		cacheService = new CacheService(provider);
	});

	afterAll(async () => {
		await cacheService.stop();
	});

	it('should cascade invalidation through dependencies', async () => {
		// Set up dependent caches
		await cacheService.set(ProjectCache, { projectId: 'p1' }, { name: 'Project 1' });
		await cacheService.set(MonitorCache, { projectId: 'p1', monitorId: 'm1' }, { name: 'Monitor 1' });

		// Invalidate project (should cascade to monitor)
		await cacheService.invalidate('Project', { projectId: 'p1' });

		// Both should be cleared
		const project = await cacheService.get(ProjectCache, { projectId: 'p1' });
		const monitor = await cacheService.get(MonitorCache, { projectId: 'p1', monitorId: 'm1' });

		expect(project).toBeNull();
		expect(monitor).toBeNull();
	});
});
```

---

## Next Steps

- [Configuration](./configuration.md) - Configure cache connections and providers
- [Testing](./testing.md) - Test infrastructure and patterns
- [Events](./events.md) - Invalidate caches on domain events
