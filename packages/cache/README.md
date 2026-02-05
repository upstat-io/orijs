# @orijs/cache

Type-safe caching system for OriJS with entity registry, dependency tracking, and cascade invalidation.

## Installation

```bash
bun add @orijs/cache
```

## Quick Start

```typescript
import {
  defineScopes,
  defineEntities,
  EntityRegistry,
  createCacheBuilder,
  CacheService,
  InMemoryCacheProvider
} from '@orijs/cache';

// 1. Define scopes
const Scope = defineScopes({
  Global: { name: 'global' },
  Account: { name: 'account', param: 'accountId' }
});

// 2. Define entities
const Entities = defineEntities({
  User: { name: 'User', scope: Scope.Account, param: 'userId' }
});

// 3. Build registry and cache builder
const registry = EntityRegistry.create()
  .scopes(Scope)
  .entities(Entities)
  .build();

const Cache = createCacheBuilder(registry);

// 4. Define caches with TTL and grace period
const UserCache = Cache.for(Entities.User).ttl('1h').grace('5m').build();

// 5. Use cache service
const cacheService = new CacheService(new InMemoryCacheProvider());

const user = await cacheService.getOrSet(
  UserCache,
  { accountId: 'acc-123', userId: 'usr-456' },
  async (ctx) => {
    const data = await db.users.findById('usr-456');
    if (!data) return ctx.skip(); // Don't cache null
    return data;
  }
);
```

## Features

- **Entity Registry** - Define scopes and entities for hierarchical caching
- **Dependency Tracking** - Automatic dependency graph for invalidation
- **Grace Period** - Serve stale data while refreshing
- **Singleflight** - Prevent thundering herd on cache miss
- **Multiple Providers** - In-memory, Redis, or custom providers

## Cache Invalidation

```typescript
// Invalidate specific cache
await cacheService.invalidate(UserCache, { accountId: 'acc-123', userId: 'usr-456' });

// Invalidate by entity (all caches for this user)
await cacheService.invalidateEntity(Entities.User, { accountId: 'acc-123', userId: 'usr-456' });

// Invalidate by scope (all caches in account)
await cacheService.invalidateScope(Scope.Account, { accountId: 'acc-123' });
```

## Duration Format

TTL and grace periods support human-readable durations:

```typescript
Cache.for(Entities.User)
  .ttl('1h')      // 1 hour
  .grace('5m')    // 5 minutes
  .build();

// Supported units: s, m, h, d (seconds, minutes, hours, days)
```

## Documentation

See the [Caching Guide](../../docs/guides/caching.md) for more details.

## License

MIT
