# @orijs/test-utils

Test infrastructure for OriJS framework with Redis testcontainer helpers and async utilities.

## Installation

```bash
bun add -d @orijs/test-utils
```

## Quick Start

### Bun Test Preload

Create a `preload.ts` file for your tests:

```typescript
import { createBunTestPreload } from '@orijs/test-utils';

const preload = createBunTestPreload({
  packageName: 'my-package',
  dependencies: ['redis']
});

await preload();
```

Configure in `bunfig.toml`:

```toml
[test]
preload = ["./preload.ts"]
```

### Redis Test Helper

```typescript
import { describe, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createRedisTestHelper } from '@orijs/test-utils';

describe('CacheService', () => {
  const redis = createRedisTestHelper('my-package');

  beforeAll(async () => {
    await redis.start();
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    await redis.flush();
  });

  test('should cache values', async () => {
    const client = redis.createRedisClient();
    await client.set('key', 'value');
    expect(await client.get('key')).toBe('value');
  });
});
```

## Features

- **Redis Testcontainers** - Automatic Redis container management
- **Async Test Helpers** - Utilities for testing async code
- **Bun Test Integration** - Seamless integration with Bun's test runner
- **Container Pooling** - Efficient container reuse across test suites

## Async Test Helpers

```typescript
import { waitFor, withTimeout, delay } from '@orijs/test-utils';

// Wait for condition with polling
await waitFor(() => queue.length > 0, { timeoutMs: 5000, intervalMs: 100 });

// Add timeout to any promise
const result = await withTimeout(slowOperation(), 5000);

// Simple delay
await delay(100);
```

## Container Management

```typescript
import {
  startRedisTestContainer,
  stopRedisTestContainer,
  stopAllRedisTestContainers
} from '@orijs/test-utils';

// Manual container control
const container = await startRedisTestContainer('test-suite');
// ... run tests
await stopRedisTestContainer('test-suite');

// Cleanup all containers
await stopAllRedisTestContainers();
```

## Documentation

See the [Testing Guide](../../docs/guides/testing.md) for more details.

## License

MIT
