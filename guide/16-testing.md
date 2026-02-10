# Chapter 16: Testing

Testing is where OriJS's design philosophy pays its biggest dividends. Because every component is a plain TypeScript class with explicit constructor dependencies — no decorators, no metadata, no module system — testing is dramatically simpler than in decorator-based frameworks.

This chapter covers OriJS's three-layer testing strategy, the built-in mock factories, and patterns for testing every part of your application, from individual services to full HTTP request flows.

## Testing Philosophy

### The Modified Testing Pyramid

Traditional testing pyramids put unit tests at the bottom and E2E tests at the top. OriJS modifies this by emphasizing **functional tests** — tests that use real class instances with controlled dependencies — as the most valuable layer.

```
         /    E2E     \        ← Real HTTP, real Redis, Testcontainers
        /  (few, slow)  \
       /                  \
      /    Functional      \   ← Real instances, controlled deps, DI container
     /  (many, medium)      \
    /                        \
   /        Unit              \  ← Single class, all deps mocked
  /    (many, fast)            \
 /______________________________\
```

**Unit tests** verify isolated logic — a single class with all dependencies mocked. They are fast but can miss integration issues.

**Functional tests** wire together real instances with controlled dependencies. They catch interface mismatches, incorrect dependency injection, and integration bugs that unit tests miss. In OriJS, because everything is a plain class, functional tests are almost as easy to write as unit tests.

**E2E tests** send real HTTP requests to a running server. They verify the full request lifecycle — routing, guards, interceptors, validation, handlers, and responses. Use them for critical paths and complex interactions.

### Why OriJS is More Testable Than NestJS

In NestJS, testing a controller or service requires bootstrapping the NestJS testing module:

```typescript
// NestJS — the TestingModule ceremony
const module = await Test.createTestingModule({
  controllers: [UserController],
  providers: [
    { provide: UserService, useValue: mockUserService },
    { provide: AuthGuard, useValue: mockAuthGuard },
  ],
}).compile();

const controller = module.get<UserController>(UserController);
```

This is necessary because NestJS uses decorators and reflect-metadata to wire dependencies at runtime. Without the testing module, the DI system doesn't work.

In OriJS, testing is just... constructing classes:

```typescript
// OriJS — plain class instantiation
const mockUserService = { findById: mock(() => testUser) };
const controller = new UserController(mockUserService as UserService);
```

No testing module. No framework bootstrapping. No decorator metadata. Just `new` and your mocks. This is possible because OriJS services are plain TypeScript classes with explicit constructor parameters — there is nothing framework-specific about them.

## Test Setup

### Bun Test Runner

OriJS uses Bun's built-in test runner. Tests use the `bun:test` module:

```typescript
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
```

### Preload File

For tests that need infrastructure (Redis, containers), create a preload file:

```typescript
// __tests__/preload.ts
import { createBunTestPreload } from '@orijs/test-utils';
import { Logger } from '@orijs/logging';
import { afterAll } from 'bun:test';

// Enable debug mode so framework errors throw instead of exiting
process.env.ORIJS_DEBUG = 'true';

const preload = createBunTestPreload({
  packageName: 'my-app',
  dependencies: ['redis'],
});

await preload();

// Clean up Logger timer after each test file
afterAll(async () => {
  await Logger.shutdown();
});
```

Configure the preload in `bunfig.toml`:

```toml
[test]
preload = ["./__tests__/preload.ts"]
```

### Disable Signal Handling

When testing OriJS applications, always disable signal handling. Without this, your tests will intercept SIGINT/SIGTERM and interfere with the test runner:

```typescript
const app = Ori.create()
  .disableSignalHandling()
  // ... rest of configuration
  .listen(0); // Port 0 = random available port
```

## Running Tests

```bash
# Run all tests
bun test

# Run a specific test file
bun test __tests__/services/user-service.test.ts

# Run tests matching a pattern
bun test --grep "should create user"

# Run with coverage
bun test --coverage

# Run with timeout (useful for E2E tests)
bun test --timeout 30000
```

## Unit Testing

Unit tests verify a single class in isolation. All dependencies are mocked.

### Testing Services

Services are the simplest to test — they are plain classes with constructor dependencies.

```typescript
// src/services/user-service.ts
class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly emailService: EmailService
  ) {}

  public async createUser(data: CreateUserInput): Promise<User> {
    const user = await this.userRepository.create(data);
    await this.emailService.sendWelcome(user.email);
    return user;
  }

  public async findById(id: string): Promise<User | null> {
    return this.userRepository.findById(id);
  }
}
```

```typescript
// __tests__/services/user-service.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { UserService } from '../../src/services/user-service';
import type { UserRepository } from '../../src/repositories/user-repository';
import type { EmailService } from '../../src/services/email-service';

describe('UserService', () => {
  let service: UserService;
  let mockRepo: UserRepository;
  let mockEmail: EmailService;

  const testUser = {
    id: 'user-123',
    name: 'Alice',
    email: 'alice@example.com',
  };

  beforeEach(() => {
    mockRepo = {
      create: mock(() => Promise.resolve(testUser)),
      findById: mock(() => Promise.resolve(testUser)),
    } as unknown as UserRepository;

    mockEmail = {
      sendWelcome: mock(() => Promise.resolve()),
    } as unknown as EmailService;

    service = new UserService(mockRepo, mockEmail);
  });

  describe('createUser', () => {
    test('should create user and send welcome email', async () => {
      const result = await service.createUser({
        name: 'Alice',
        email: 'alice@example.com',
      });

      expect(result).toEqual(testUser);
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      expect(mockEmail.sendWelcome).toHaveBeenCalledWith('alice@example.com');
    });

    test('should propagate repository errors', async () => {
      (mockRepo.create as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      expect(
        service.createUser({ name: 'Alice', email: 'alice@example.com' })
      ).rejects.toThrow('Database connection failed');
    });
  });

  describe('findById', () => {
    test('should return user when found', async () => {
      const result = await service.findById('user-123');
      expect(result).toEqual(testUser);
    });

    test('should return null when user not found', async () => {
      (mockRepo.findById as ReturnType<typeof mock>).mockResolvedValueOnce(null);

      const result = await service.findById('nonexistent');
      expect(result).toBeNull();
    });
  });
});
```

The key insight: **there is nothing OriJS-specific about this test**. The service is a plain class, the mocks are plain objects, and the test is a standard Bun test. This is the direct benefit of OriJS's no-decorator, explicit-dependency approach.

### Testing Guards

Guards implement the `Guard` interface with a single `canActivate` method that receives a `RequestContext`:

```typescript
// src/guards/auth-guard.ts
import type { Guard } from '@orijs/orijs';
import type { RequestContext } from '@orijs/orijs';

class AuthGuard implements Guard {
  constructor(private readonly authService: AuthService) {}

  public async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('authorization');
    if (!token) return false;

    const user = await this.authService.validateToken(token);
    if (!user) return false;

    ctx.set('user', user);
    return true;
  }
}
```

To unit test a guard, you need a mock `RequestContext`. You can construct a minimal one:

```typescript
// __tests__/guards/auth-guard.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { AuthGuard } from '../../src/guards/auth-guard';
import type { AuthService } from '../../src/services/auth-service';

function createMockRequestContext(options: {
  headers?: Record<string, string>;
} = {}): any {
  const state: Record<string, unknown> = {};
  return {
    request: {
      headers: {
        get: (key: string) => options.headers?.[key] ?? null,
      },
    },
    state,
    set: (key: string, value: unknown) => { state[key] = value; },
    get: (key: string) => state[key],
  };
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let mockAuthService: AuthService;

  const testUser = { id: 'user-123', role: 'admin' };

  beforeEach(() => {
    mockAuthService = {
      validateToken: mock(() => Promise.resolve(testUser)),
    } as unknown as AuthService;

    guard = new AuthGuard(mockAuthService);
  });

  test('should allow request with valid token', async () => {
    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer valid-token' },
    });

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(ctx.state.user).toEqual(testUser);
  });

  test('should deny request without token', async () => {
    const ctx = createMockRequestContext();

    const result = await guard.canActivate(ctx);

    expect(result).toBe(false);
  });

  test('should deny request with invalid token', async () => {
    (mockAuthService.validateToken as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null);

    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer invalid' },
    });

    const result = await guard.canActivate(ctx);

    expect(result).toBe(false);
  });
});
```

### Testing Interceptors

Interceptors follow the onion model — they wrap handler execution:

```typescript
// src/interceptors/timing-interceptor.ts
import type { Interceptor, RequestContext } from '@orijs/orijs';

class TimingInterceptor implements Interceptor {
  public async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const start = performance.now();
    const response = await next();
    const duration = Math.round(performance.now() - start);

    ctx.log.info('Request completed', {
      method: ctx.request.method,
      duration,
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers),
        'X-Response-Time': `${duration}ms`,
      },
    });
  }
}
```

```typescript
// __tests__/interceptors/timing-interceptor.test.ts
import { describe, test, expect, mock } from 'bun:test';
import { TimingInterceptor } from '../../src/interceptors/timing-interceptor';

describe('TimingInterceptor', () => {
  test('should add X-Response-Time header', async () => {
    const interceptor = new TimingInterceptor();
    const mockCtx = {
      request: { method: 'GET' },
      log: { info: mock(() => {}) },
    } as any;

    const next = mock(() => Promise.resolve(
      Response.json({ ok: true })
    ));

    const response = await interceptor.intercept(mockCtx, next);

    expect(response.headers.get('X-Response-Time')).toMatch(/^\d+ms$/);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCtx.log.info).toHaveBeenCalled();
  });

  test('should propagate handler errors', async () => {
    const interceptor = new TimingInterceptor();
    const mockCtx = {
      request: { method: 'GET' },
      log: { info: mock(() => {}) },
    } as any;

    const next = mock(() => Promise.reject(new Error('Handler failed')));

    expect(
      interceptor.intercept(mockCtx, next)
    ).rejects.toThrow('Handler failed');
  });
});
```

## Mock Factories

For more realistic unit tests, you can build helper factories that create properly structured mock contexts. These are lightweight functions you keep in your test utilities:

### createMockRequestContext

```typescript
// __tests__/helpers/mock-factories.ts

export function createMockRequestContext(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
} = {}): any {
  const state: Record<string, unknown> = {};
  const {
    method = 'GET',
    url = 'http://localhost:3000/test',
    headers = {},
    params = {},
    query = {},
    body = undefined,
  } = options;

  return {
    request: new Request(url, {
      method,
      headers: new Headers(headers),
      body: body ? JSON.stringify(body) : undefined,
    }),
    params,
    query,
    state,
    set: (key: string, value: unknown) => { state[key] = value; },
    get: (key: string) => state[key],
    json: async () => body,
    text: async () => JSON.stringify(body),
    log: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    correlationId: 'test-correlation-id',
    signal: new AbortController().signal,
    app: {
      config: {},
      log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
    },
  };
}
```

### createMockAppContext

```typescript
export function createMockAppContext(options: {
  config?: Record<string, unknown>;
} = {}): any {
  return {
    config: options.config ?? {},
    log: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      child: () => ({
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      }),
    },
    onStartup: mock(() => {}),
    onReady: mock(() => {}),
    onShutdown: mock(() => {}),
    resolve: mock(() => null),
    phase: 'ready',
  };
}
```

### createMockEventContext

```typescript
export function createMockEventContext<T>(options: {
  data: T;
  eventName?: string;
  eventId?: string;
}): any {
  return {
    eventId: options.eventId ?? crypto.randomUUID(),
    eventName: options.eventName ?? 'test.event',
    data: options.data,
    timestamp: Date.now(),
    correlationId: crypto.randomUUID(),
    log: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    emit: mock(() => ({ wait: () => Promise.resolve() })),
  };
}
```

### createMockWorkflowContext

```typescript
export function createMockWorkflowContext<T>(options: {
  data: T;
  flowId?: string;
  results?: Record<string, unknown>;
}): any {
  return {
    flowId: options.flowId ?? crypto.randomUUID(),
    data: options.data,
    results: options.results ?? {},
    correlationId: crypto.randomUUID(),
    meta: {},
    log: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
  };
}
```

## Functional Testing

Functional tests use real class instances wired together with controlled dependencies. This catches integration issues that unit tests miss — incorrect dependency types, interface mismatches, and wiring errors.

### Using the DI Container

OriJS's `Container` class can be used directly in tests to wire up real dependency graphs:

```typescript
// __tests__/functional/user-flow.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Container } from '@orijs/core';
import { UserService } from '../../src/services/user-service';
import { UserRepository } from '../../src/repositories/user-repository';
import { InMemoryDatabase } from '../../src/testing/in-memory-database';

describe('User creation flow (functional)', () => {
  let container: Container;
  let userService: UserService;

  beforeEach(() => {
    container = new Container();

    // Use real implementations with controlled deps
    const db = new InMemoryDatabase();
    container.registerInstance(InMemoryDatabase, db);
    container.register(UserRepository, [InMemoryDatabase]);
    container.register(UserService, [UserRepository]);

    userService = container.resolve(UserService);
  });

  test('should create and retrieve a user', async () => {
    const created = await userService.createUser({
      name: 'Alice',
      email: 'alice@example.com',
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe('Alice');

    const found = await userService.findById(created.id);
    expect(found).toEqual(created);
  });

  test('should return null for nonexistent user', async () => {
    const found = await userService.findById('nonexistent');
    expect(found).toBeNull();
  });
});
```

### Testing with Swapped Providers

The provider architecture makes functional tests powerful. Swap Redis for InMemory, BullMQ for InProcess:

```typescript
import { CacheService, InMemoryCacheProvider } from '@orijs/cache';

describe('Cached user lookup (functional)', () => {
  let userService: UserService;
  let cacheService: CacheService;

  beforeEach(() => {
    // InMemory cache provider — no Redis needed
    cacheService = new CacheService(new InMemoryCacheProvider());

    const mockRepo = new InMemoryUserRepository();
    userService = new UserService(mockRepo, cacheService);
  });

  test('should cache user after first lookup', async () => {
    // First call — cache miss, hits repository
    const user1 = await userService.findById('user-123');

    // Second call — cache hit, does not hit repository
    const user2 = await userService.findById('user-123');

    expect(user1).toEqual(user2);
    // Verify repository was only called once (second call was cached)
  });
});
```

### Testing Controllers Functionally

You can test controllers without starting an HTTP server by instantiating them directly and calling handlers:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { UserController } from '../../src/controllers/user-controller';
import { UserService } from '../../src/services/user-service';

describe('UserController (functional)', () => {
  let controller: UserController;
  let userService: UserService;

  beforeEach(() => {
    // Use a real UserService with an in-memory repository
    const repo = new InMemoryUserRepository();
    userService = new UserService(repo);
    controller = new UserController(userService);
  });

  test('should return user by ID', async () => {
    // Seed data
    await userService.createUser({ name: 'Alice', email: 'alice@example.com' });

    const ctx = createMockRequestContext({
      params: { id: 'user-123' },
    });

    // Call the handler directly (it is a public arrow function property)
    // This tests the controller logic without HTTP overhead
  });
});
```

## E2E Testing

E2E tests start a real server, send real HTTP requests, and verify real responses. They test the entire request lifecycle.

### Basic E2E Test

```typescript
// __tests__/e2e/user-api.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Ori } from '@orijs/orijs';
import type { OriApplication } from '@orijs/orijs';
import { UserController } from '../../src/controllers/user-controller';
import { UserService } from '../../src/services/user-service';
import { InMemoryUserRepository } from '../../src/testing/in-memory-user-repository';

describe('User API (E2E)', () => {
  let app: OriApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const repo = new InMemoryUserRepository();

    app = Ori.create()
      .disableSignalHandling()     // Required for tests
      .providerInstance(InMemoryUserRepository, repo)
      .provider(UserService, [InMemoryUserRepository])
      .controller('/users', UserController, [UserService]);

    const server = await app.listen(0);  // Port 0 = random available port
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await app.stop();
  });

  test('should create a user via POST', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
      }),
    });

    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.name).toBe('Alice');
    expect(body.email).toBe('alice@example.com');
    expect(body.id).toBeDefined();
  });

  test('should get a user via GET', async () => {
    // Create first
    const createRes = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', email: 'bob@example.com' }),
    });
    const created = await createRes.json();

    // Then fetch
    const getRes = await fetch(`${baseUrl}/users/${created.id}`);
    expect(getRes.status).toBe(200);

    const fetched = await getRes.json();
    expect(fetched.name).toBe('Bob');
  });

  test('should return 404 for nonexistent user', async () => {
    const response = await fetch(`${baseUrl}/users/nonexistent-id`);
    expect(response.status).toBe(404);
  });

  test('should return 422 for invalid body', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }), // Missing required email
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe('Validation Error');
  });
});
```

### Port 0 for Random Ports

Always use port `0` in E2E tests. Bun assigns a random available port, preventing conflicts when tests run in parallel:

```typescript
const server = await app.listen(0);
const port = server.port; // Bun gives you the assigned port
const baseUrl = `http://localhost:${port}`;
```

### E2E with Testcontainers

For tests that need real Redis (cache, events, WebSockets), use Testcontainers via the `@orijs/test-utils` preload:

```typescript
// __tests__/e2e/cached-api.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Ori } from '@orijs/orijs';
import { createRedisTestHelper } from '@orijs/test-utils';
import { createRedisCacheProvider } from '@orijs/cache-redis';

describe('Cached API (E2E with Redis)', () => {
  const redisHelper = createRedisTestHelper('my-app');
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    // Redis container is started by the preload file
    const redis = redisHelper.createRedisClient();
    const cacheProvider = createRedisCacheProvider({ connection: redis });

    app = Ori.create()
      .disableSignalHandling()
      .cache(cacheProvider)
      .provider(UserService, [UserRepository, CacheService])
      .controller('/users', UserController, [UserService]);

    const server = await app.listen(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await app.stop();
  });

  test('should serve cached response on second request', async () => {
    // First request — cache miss
    const res1 = await fetch(`${baseUrl}/users/user-123`);
    expect(res1.status).toBe(200);

    // Second request — cache hit (faster)
    const res2 = await fetch(`${baseUrl}/users/user-123`);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1).toEqual(body2);
  });
});
```

## Testing Events

### Unit Testing Event Consumers

Event consumers are plain classes. Test them by creating mock event contexts:

```typescript
// src/consumers/user-created-consumer.ts
import type { EventConsumer } from '@orijs/orijs';
import type { UserCreated } from '../events/user-events';

class UserCreatedConsumer implements EventConsumer<typeof UserCreated> {
  constructor(private readonly emailService: EmailService) {}

  onEvent = async (ctx) => {
    await this.emailService.sendWelcome(ctx.data.email);
    return { welcomeEmailSent: true };
  };

  onError = async (ctx, error) => {
    ctx.log.error('Failed to process user.created', { error, userId: ctx.data.userId });
  };
}
```

```typescript
// __tests__/consumers/user-created-consumer.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { UserCreatedConsumer } from '../../src/consumers/user-created-consumer';

describe('UserCreatedConsumer', () => {
  let consumer: UserCreatedConsumer;
  let mockEmailService: any;

  beforeEach(() => {
    mockEmailService = {
      sendWelcome: mock(() => Promise.resolve()),
    };
    consumer = new UserCreatedConsumer(mockEmailService);
  });

  test('should send welcome email when user is created', async () => {
    const ctx = createMockEventContext({
      data: { userId: 'user-123', email: 'alice@example.com' },
      eventName: 'user.created',
    });

    const result = await consumer.onEvent(ctx);

    expect(result).toEqual({ welcomeEmailSent: true });
    expect(mockEmailService.sendWelcome).toHaveBeenCalledWith('alice@example.com');
  });

  test('should log error on failure', async () => {
    mockEmailService.sendWelcome.mockRejectedValueOnce(new Error('SMTP down'));

    const ctx = createMockEventContext({
      data: { userId: 'user-123', email: 'alice@example.com' },
    });

    // onError is a separate lifecycle hook
    await consumer.onError!(ctx, new Error('SMTP down'));

    expect(ctx.log.error).toHaveBeenCalled();
  });
});
```

### Testing Event Emission in E2E

To test that events are emitted correctly in an E2E scenario, use the InProcess event provider:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Ori, Event } from '@orijs/orijs';
import { Type } from '@orijs/validation';
import { waitFor } from '@orijs/test-utils';

const UserCreated = Event.define({
  name: 'user.created',
  data: Type.Object({ userId: Type.String(), email: Type.String() }),
  result: Type.Object({ welcomeEmailSent: Type.Boolean() }),
});

describe('Event emission (E2E)', () => {
  let app: any;
  let baseUrl: string;
  const processedEvents: unknown[] = [];

  class TestConsumer {
    onEvent = async (ctx: any) => {
      processedEvents.push(ctx.data);
      return { welcomeEmailSent: true };
    };
  }

  beforeAll(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .event(UserCreated).consumer(TestConsumer)
      .controller('/users', UserController, [UserService]);

    const server = await app.listen(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await app.stop();
  });

  test('should emit event when user is created', async () => {
    await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    });

    // Wait for async event processing
    await waitFor(() => processedEvents.length > 0);

    expect(processedEvents[0]).toMatchObject({
      email: 'alice@example.com',
    });
  });
});
```

## Testing WebSockets

WebSocket tests use Bun's native `WebSocket` client. Start a server on port 0 and connect:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Ori } from '@orijs/orijs';
import { waitFor } from '@orijs/test-utils';

describe('WebSocket (E2E)', () => {
  let app: any;
  let wsUrl: string;

  beforeAll(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .websocket()
      .onWebSocket({
        open: (ws) => {
          ws.subscribe('global');
        },
        message: (ws, message) => {
          // Echo back
          ws.send(`echo: ${message}`);
        },
      });

    const server = await app.listen(0);
    wsUrl = `ws://localhost:${server.port}/ws`;
  });

  afterAll(async () => {
    await app.stop();
  });

  test('should receive echo response', async () => {
    const messages: string[] = [];

    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      messages.push(event.data);
    };

    // Wait for connection
    await waitFor(() => ws.readyState === WebSocket.OPEN);

    ws.send('hello');

    // Wait for response
    await waitFor(() => messages.length > 0);

    expect(messages[0]).toBe('echo: hello');

    ws.close();
  });
});
```

### Testing Socket Routers

Socket routers with connection guards and message handlers:

```typescript
describe('Socket Router (E2E)', () => {
  let app: any;
  let wsUrl: string;

  beforeAll(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .websocket()
      .socketRouter(PresenceRouter, [PresenceService]);

    const server = await app.listen(0);
    wsUrl = `ws://localhost:${server.port}/ws`;
  });

  afterAll(async () => {
    await app.stop();
  });

  test('should handle heartbeat message', async () => {
    const messages: any[] = [];
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data));
    };

    await waitFor(() => ws.readyState === WebSocket.OPEN);

    // Send typed message
    ws.send(JSON.stringify({
      type: 'heartbeat',
      data: { timestamp: Date.now() },
      correlationId: 'test-123',
    }));

    await waitFor(() => messages.length > 0);

    expect(messages[0].type).toBe('heartbeat');
    expect(messages[0].correlationId).toBe('test-123');

    ws.close();
  });
});
```

## Test Naming Conventions

Use the pattern: **should {expected behavior} when {condition}**

```typescript
// Good
test('should return 401 when token is missing', async () => { ... });
test('should cache result when cache miss occurs', async () => { ... });
test('should retry three times when connection fails', async () => { ... });
test('should emit UserCreated event when user is created', async () => { ... });

// Bad — vague, doesn't describe behavior
test('test user creation', async () => { ... });
test('auth works', async () => { ... });
test('handles errors', async () => { ... });
```

## Async Test Helpers

The `@orijs/test-utils` package provides helpers for deterministic async testing:

### waitFor

Polls a condition until it becomes true, or times out:

```typescript
import { waitFor } from '@orijs/test-utils';

// Wait for messages to arrive
await waitFor(() => messages.length >= 2);

// Custom timeout and interval
await waitFor(() => db.isConnected(), {
  timeout: 10000,
  interval: 100,
  message: 'Database did not connect in time',
});
```

### waitForAsync

Same as `waitFor` but the condition function can be async:

```typescript
import { waitForAsync } from '@orijs/test-utils';

await waitForAsync(async () => {
  const count = await redis.llen('events');
  return count >= 3;
});
```

### withTimeout

Wraps a promise with a timeout to prevent hanging tests:

```typescript
import { withTimeout } from '@orijs/test-utils';

const result = await withTimeout(
  workflow.waitForCompletion(),
  30000,
  'Workflow did not complete in time'
);
```

### delay

Simple delay for cases where a fixed wait is actually appropriate (use sparingly):

```typescript
import { delay } from '@orijs/test-utils';

await provider.stop();
await delay(50); // Allow background cleanup
```

## Testing Best Practices

### 1. Test One Behavior Per Test

Each test should verify a single behavior. If a test has multiple unrelated assertions, split it:

```typescript
// Bad — testing multiple behaviors
test('should handle user operations', async () => {
  const user = await service.create({ name: 'Alice' });
  expect(user.name).toBe('Alice');

  const found = await service.findById(user.id);
  expect(found).toEqual(user);

  await service.delete(user.id);
  const deleted = await service.findById(user.id);
  expect(deleted).toBeNull();
});

// Good — one behavior per test
test('should create user with correct name', async () => { ... });
test('should find user by ID after creation', async () => { ... });
test('should return null after deletion', async () => { ... });
```

### 2. Prefer Specific Assertions

Use specific assertions instead of weak ones:

```typescript
// Bad — weak assertions
expect(result).toBeTruthy();
expect(result).toBeDefined();
expect(typeof result).toBe('object');

// Good — specific assertions
expect(result).toEqual({ id: 'user-123', name: 'Alice' });
expect(result.id).toBe('user-123');
expect(result.items).toHaveLength(3);
```

### 3. Use beforeEach for Isolation

Every test should start with a clean state:

```typescript
let service: UserService;

beforeEach(() => {
  // Fresh instances for every test
  const repo = new InMemoryUserRepository();
  service = new UserService(repo);
});
```

### 4. Always Clean Up

E2E tests must clean up their servers and connections:

```typescript
afterAll(async () => {
  await app.stop(); // Stop the server
});
```

### 5. No .only or .skip in Committed Code

Never commit `.only()` or `.skip()` on tests. These are debugging aids that should not reach the repository.

## Summary

OriJS's testing story is built on a simple foundation: **plain classes with explicit dependencies are inherently testable**. There is no `TestingModule` to bootstrap, no decorator metadata to configure, and no framework ceremony to satisfy. Services, guards, interceptors, and controllers are all just classes — instantiate them, pass in mocks or real implementations, and test.

The three-layer strategy — unit tests for isolated logic, functional tests for integration, E2E tests for full request flows — gives you confidence at every level. And the provider architecture means you can swap production infrastructure (Redis, BullMQ) for test-friendly alternatives (InMemory, InProcess) without changing your business logic.

---

[Previous: Logging ←](./15-logging.md) | [Next: Advanced Patterns →](./17-advanced-patterns.md)
