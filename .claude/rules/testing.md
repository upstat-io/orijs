# Testing Rules

## Use Bun Test

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
```

## Three Test Layers

| Layer      | Purpose                | Mock What               |
|------------|------------------------|-------------------------|
| Unit       | Class logic            | All dependencies        |
| Functional | Component interactions | Outermost boundary only |
| E2E        | Complete flows         | Only external APIs      |

## Test Naming

```typescript
describe('UserService', () => {
  test('should return user when found by id', async () => {});
  test('should throw NotFoundError when user does not exist', async () => {});
  test('should create user with hashed password', async () => {});
});
```

Pattern: `should [behavior] when [condition]`

## Strong Assertions

```typescript
// WRONG - Weak
expect(result).toBeDefined();
expect(users.length).toBeGreaterThan(0);

// CORRECT - Strong
expect(result).toEqual({ id: '123', email: 'test@example.com' });
expect(users).toHaveLength(2);
expect(users[0].email).toBe('admin@example.com');
```

## Descriptive Variables

```typescript
// WRONG
const user1 = createUser();
const user2 = createUser();

// CORRECT
const adminUser = createUser({ role: 'admin' });
const regularUser = createUser({ role: 'user' });
```

## Mocking with Bun

```typescript
import { mock } from 'bun:test';

const mockUserRepo = {
  findById: mock(() => Promise.resolve(testUser)),
  create: mock(() => Promise.resolve(testUser))
};

const service = new UserService(mockUserRepo);
```

## Testing Async Code

```typescript
test('should handle async operations', async () => {
  const result = await service.processAsync();
  expect(result.status).toBe('completed');
});

test('should reject with error', async () => {
  await expect(service.failingOp()).rejects.toThrow('Expected error');
});
```

## Redis/Container Tests

Use `@orijs/test-utils` for container management:

```typescript
import { createRedisTestHelper } from '@orijs/test-utils';

describe('CacheService', () => {
  const redis = createRedisTestHelper();

  beforeAll(async () => {
    await redis.start();
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    await redis.flush();
  });
});
```

## Never Modify Tests to Pass

If a test fails:
1. Understand WHY it fails
2. Fix the code, not the test
3. Only modify test if the expected behavior changed

## Promise Cleanup (CRITICAL)

Always chain `.catch()` before `.finally()`:

```typescript
// WRONG - Creates unhandled rejection
promise.catch(() => {});
promise.finally(() => cleanup());

// CORRECT - Single chain
promise.catch(() => {}).finally(() => cleanup());
```

## Test File Location

```
packages/core/
├── src/
│   └── application.ts
└── __tests__/
    └── application.test.ts
```
