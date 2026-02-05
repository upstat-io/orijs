# @orijs/cache-redis

Redis cache provider for OriJS cache system with dependency tracking via meta keys.

## Installation

```bash
bun add @orijs/cache-redis
```

## Quick Start

```typescript
import { createRedisCacheProvider } from '@orijs/cache-redis';
import { CacheService } from '@orijs/cache';

// Create Redis provider
const provider = createRedisCacheProvider({
  connection: {
    host: 'localhost',
    port: 6379
  }
});

// Use with cache service
const cacheService = new CacheService(provider);

// Get or set cache
const user = await cacheService.getOrSet(
  UserCache,
  { accountId: 'acc-123', userId: 'usr-456' },
  async () => db.users.findById('usr-456')
);
```

## Features

- **Redis-Backed Caching** - Persistent caching with Redis
- **Meta Key Tracking** - Dependency tracking for cascade invalidation
- **Connection Management** - Automatic connection handling
- **ioredis Compatible** - Uses ioredis under the hood

## Configuration Options

```typescript
const provider = createRedisCacheProvider({
  connection: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
    db: 0,
    tls: {} // For TLS connections
  },
  keyPrefix: 'myapp:' // Optional key prefix
});
```

## With Sentinel/Cluster

```typescript
import { Redis } from '@orijs/cache-redis';

// Use ioredis directly for advanced configurations
const redis = new Redis({
  sentinels: [
    { host: 'sentinel-1', port: 26379 },
    { host: 'sentinel-2', port: 26379 }
  ],
  name: 'mymaster'
});

const provider = createRedisCacheProvider({ redis });
```

## Documentation

See the [Caching Guide](../../docs/guides/caching.md) for more details.

## License

MIT
