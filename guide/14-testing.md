# Chapter 14: Testing

OriJS is designed for testability. Because there are no decorators, no reflect-metadata, and no module system, your classes are plain TypeScript — easy to instantiate, mock, and verify.

## Testing Philosophy

OriJS recommends a **three-layer testing strategy**:

| Layer | What It Tests | Speed | Isolation |
|-------|--------------|-------|-----------|
| **Unit** | Individual classes/functions | Fast (ms) | Full (mocked deps) |
| **Functional** | Component interactions | Medium (ms-sec) | Partial (real deps, mocked infra) |
| **E2E** | Full request/response cycle | Slow (sec) | None (real everything) |

**Unit tests** verify that a single class does what it should. Dependencies are mocked.

**Functional tests** verify that connected components work together. If Service A calls Service B, a functional test uses real instances of both but may mock the database.

**E2E tests** verify the entire stack from HTTP request to database query. They use real databases (via Testcontainers or local instances) and real Redis.

### How Much of Each?

The classic "testing pyramid" suggests mostly unit tests, some integration, and few E2E. OriJS modifies this slightly:

```
     /\
    /E2E\         Few — critical paths only
   /──────\
  /Functional\    Many — most business logic tested here
 /────────────\
/  Unit Tests  \  Many — for complex logic and edge cases
────────────────
```

Functional tests are especially valuable in OriJS because the DI system makes it easy to create real service instances with controlled dependencies.

## Test Setup

### Bun Test Runner

OriJS uses Bun's built-in test runner:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';

describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
    service = new UserService(mockUserRepository);
  });

  it('should create a user', async () => {
    const user = await service.create({ name: 'Alice', email: 'alice@test.com' });
    expect(user.name).toBe('Alice');
  });
});
```

### Preload File

Create a `tests/preload.ts` file for test-wide setup:

```typescript
// tests/preload.ts
import { disableSignalHandling } from '@orijs/test-utils';

// Prevent OriJS from registering SIGINT/SIGTERM handlers in tests
// (which would interfere with the test runner)
disableSignalHandling();
```

Configure it in `bunfig.toml`:

```toml
[test]
preload = ["./tests/preload.ts"]
```

The `disableSignalHandling()` call is important — without it, OriJS registers signal handlers that can prevent the test runner from shutting down cleanly.

### Running Tests

```bash
# Run all tests
bun test

# Run a specific file
bun test tests/user.service.spec.ts

# Run tests matching a pattern
bun test --grep "should create"

# Run with coverage
bun test --coverage
```

## Unit Testing

### Testing Services

Services are the easiest to test because they're plain classes:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';

describe('MonitorService', () => {
  let service: MonitorService;
  let mockRepo: MonitorRepository;

  beforeEach(() => {
    mockRepo = {
      findById: mock(async (id: string) => ({
        uuid: id,
        name: 'Test Monitor',
        url: 'https://example.com',
        isActive: true,
      })),
      update: mock(async (id: string, data: any) => ({
        uuid: id,
        ...data,
      })),
    } as unknown as MonitorRepository;

    service = new MonitorService(mockRepo);
  });

  it('should return a monitor by id', async () => {
    const monitor = await service.getById('mon-123');

    expect(monitor).toBeDefined();
    expect(monitor.uuid).toBe('mon-123');
    expect(mockRepo.findById).toHaveBeenCalledWith('mon-123');
  });

  it('should throw when monitor not found', async () => {
    mockRepo.findById = mock(async () => null);

    await expect(service.getById('nonexistent'))
      .rejects.toThrow('Monitor not found');
  });
});
```

Because OriJS uses constructor injection without decorators, creating service instances in tests is just a `new` call with mock dependencies.

### Testing Guards

```typescript
import { createMockRequestContext } from '@orijs/test-utils';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let mockAuthService: AuthService;

  beforeEach(() => {
    mockAuthService = {
      verifyToken: mock(async (token: string) => {
        if (token === 'valid') return { id: 'user-1', role: 'admin' };
        return null;
      }),
    } as unknown as AuthService;

    guard = new AuthGuard(mockAuthService);
  });

  it('should allow valid tokens', async () => {
    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer valid' },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(ctx.state.user).toEqual({ id: 'user-1', role: 'admin' });
  });

  it('should reject missing authorization header', async () => {
    const ctx = createMockRequestContext();
    expect(await guard.canActivate(ctx)).toBe(false);
  });

  it('should reject invalid tokens', async () => {
    const ctx = createMockRequestContext({
      headers: { authorization: 'Bearer invalid' },
    });
    expect(await guard.canActivate(ctx)).toBe(false);
  });
});
```

### Testing Interceptors

```typescript
describe('TimingInterceptor', () => {
  it('should log request duration', async () => {
    const interceptor = new TimingInterceptor();
    const ctx = createMockRequestContext();
    const logSpy = mock();
    ctx.log.info = logSpy;

    const next = async () => Response.json({ ok: true });

    const response = await interceptor.intercept(ctx, next);

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it('should pass through errors', async () => {
    const interceptor = new TimingInterceptor();
    const ctx = createMockRequestContext();

    const next = async () => {
      throw new Error('Handler failed');
    };

    await expect(interceptor.intercept(ctx, next)).rejects.toThrow('Handler failed');
  });
});
```

## Mock Factories

OriJS provides mock factories for common context objects:

### createMockRequestContext

```typescript
import { createMockRequestContext } from '@orijs/test-utils';

// Basic usage
const ctx = createMockRequestContext();

// With headers
const ctx = createMockRequestContext({
  headers: { authorization: 'Bearer token123' },
});

// With params
const ctx = createMockRequestContext({
  params: { id: 'user-123' },
});

// With body
const ctx = createMockRequestContext({
  body: { name: 'Alice', email: 'alice@test.com' },
});

// With state (from guards)
const ctx = createMockRequestContext({
  state: { user: { id: 'user-1', role: 'admin' } },
});

// Full request context
const ctx = createMockRequestContext({
  method: 'POST',
  url: 'http://localhost:3000/api/users',
  headers: { 'content-type': 'application/json' },
  body: { name: 'Alice' },
  params: {},
  query: { page: '1' },
});
```

### createMockAppContext

```typescript
import { createMockAppContext } from '@orijs/test-utils';

const ctx = createMockAppContext();

// Access mock logger
ctx.log.info('test message');

// Access mock event emitter
await ctx.events.emit(SomeEvent, { data: 'test' });
```

### createMockEventContext

```typescript
import { createMockEventContext } from '@orijs/test-utils';

const ctx = createMockEventContext(UserRegistered, {
  userId: 'user-123',
  email: 'alice@test.com',
  name: 'Alice',
  registeredAt: new Date().toISOString(),
});

// ctx.data is typed as the UserRegistered payload
// ctx.log is a mock logger
// ctx.traceId is a mock trace ID
```

### createMockWorkflowContext

```typescript
import { createMockWorkflowContext } from '@orijs/test-utils';

const ctx = createMockWorkflowContext(ProcessOrderWorkflow, 'validateOrder', {
  orderId: 'order-123',
  customerId: 'cust-456',
  amount: 99.99,
  items: [{ productId: 'prod-1', quantity: 2 }],
});
```

## Functional Testing

Functional tests use real class instances with controlled dependencies:

```typescript
describe('User Registration Flow', () => {
  let userService: UserService;
  let userRepo: UserRepository;
  let emailService: MockEmailService;

  beforeEach(() => {
    // Real repository with mock database
    const mockDb = createMockDatabase();
    userRepo = new UserRepository(mockDb);

    // Mock external service
    emailService = new MockEmailService();

    // Real service with real repo and mock email
    userService = new UserService(userRepo, emailService);
  });

  it('should create user and send welcome email', async () => {
    const user = await userService.register({
      name: 'Alice',
      email: 'alice@test.com',
    });

    expect(user.uuid).toBeDefined();
    expect(user.name).toBe('Alice');

    // Verify the repo stored the user
    const stored = await userRepo.findById(user.uuid);
    expect(stored).toEqual(user);

    // Verify the email was sent
    expect(emailService.sentEmails).toHaveLength(1);
    expect(emailService.sentEmails[0].to).toBe('alice@test.com');
  });
});
```

### Testing with the DI Container

For more complex functional tests, use the actual DI container:

```typescript
describe('Monitor CRUD', () => {
  let app: OriApplication;
  let monitorService: MonitorService;

  beforeEach(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .provider(MockDatabaseService)
      .provider(MonitorRepository, [MockDatabaseService])
      .provider(MonitorService, [MonitorRepository]);

    // Don't listen — just bootstrap
    await app.listen(0);

    monitorService = app.getContainer().resolve(MonitorService);
  });

  afterEach(async () => {
    await app.stop();
  });

  it('should create and retrieve a monitor', async () => {
    const created = await monitorService.create({
      name: 'Test Monitor',
      url: 'https://example.com',
      interval: 60,
    });

    const retrieved = await monitorService.getById(created.uuid);
    expect(retrieved).toEqual(created);
  });
});
```

## E2E Testing

E2E tests make real HTTP requests to a running server:

```typescript
describe('User API E2E', () => {
  let app: OriApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .use(useDatabase)
      .use(useAuth)
      .use(useUsers);

    const server = await app.listen(0);  // Random port
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('should create a user via POST /api/users', async () => {
    const response = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@test.com',
      }),
    });

    expect(response.status).toBe(201);
    const user = await response.json();
    expect(user.name).toBe('Alice');
    expect(user.uuid).toBeDefined();
  });

  it('should return 400 for invalid input', async () => {
    const response = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({
        name: '',  // Too short
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should return 401 without auth', async () => {
    const response = await fetch(`${baseUrl}/api/users`);
    expect(response.status).toBe(401);
  });
});
```

### Testing with Testcontainers

For tests that need a real database:

```typescript
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

describe('Monitor Repository (integration)', () => {
  let container: StartedTestContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:15')
      .withEnvironment({ POSTGRES_DB: 'test', POSTGRES_PASSWORD: 'test' })
      .withExposedPorts(5432)
      .start();

    databaseUrl = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    // Run migrations
    await runMigrations(databaseUrl);
  }, 30000);

  afterAll(async () => {
    await container.stop();
  });

  it('should persist and retrieve monitors', async () => {
    const db = new DatabaseService(databaseUrl);
    const repo = new MonitorRepository(db);

    const monitor = await repo.create({
      name: 'Test',
      url: 'https://example.com',
      projectId: 'proj-123',
    });

    const found = await repo.findById(monitor.uuid);
    expect(found).toEqual(monitor);
  });
});
```

## Testing Events

### Unit Testing Consumers

```typescript
describe('WelcomeEmailConsumer', () => {
  it('should send welcome email on UserRegistered', async () => {
    const emailService = { sendWelcome: mock(async () => {}) };
    const consumer = new WelcomeEmailConsumer(emailService as EmailService);

    const ctx = createMockEventContext(UserRegistered, {
      userId: 'user-123',
      email: 'alice@test.com',
      name: 'Alice',
      registeredAt: new Date().toISOString(),
    });

    await consumer.handle(ctx);

    expect(emailService.sendWelcome).toHaveBeenCalledWith('alice@test.com', 'Alice');
  });

  it('should handle email service errors gracefully', async () => {
    const emailService = {
      sendWelcome: mock(async () => { throw new Error('SMTP error'); }),
    };
    const consumer = new WelcomeEmailConsumer(emailService as EmailService);

    const ctx = createMockEventContext(UserRegistered, {
      userId: 'user-123',
      email: 'alice@test.com',
      name: 'Alice',
      registeredAt: new Date().toISOString(),
    });

    // Consumer should throw (BullMQ will retry)
    await expect(consumer.handle(ctx)).rejects.toThrow('SMTP error');
  });
});
```

### Testing Event Emission

Verify that services emit the right events:

```typescript
describe('UserService', () => {
  it('should emit UserRegistered event on signup', async () => {
    const emitted: Array<{ event: unknown; data: unknown }> = [];
    const mockAppContext = createMockAppContext({
      events: {
        emit: mock(async (event, data) => {
          emitted.push({ event, data });
        }),
      },
    });

    const service = new UserService(mockRepo, mockAppContext);
    await service.register({ name: 'Alice', email: 'alice@test.com' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe(UserRegistered);
    expect(emitted[0].data).toMatchObject({
      email: 'alice@test.com',
      name: 'Alice',
    });
  });
});
```

## Testing WebSockets

```typescript
describe('WebSocket Presence', () => {
  let app: OriApplication;
  let wsUrl: string;

  beforeAll(async () => {
    app = Ori.create()
      .disableSignalHandling()
      .websocket()
      .socketRouter(PresenceRouter, [PresenceService])
      .listen(0);

    const port = app.server!.port;
    wsUrl = `ws://localhost:${port}/ws`;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('should respond to heartbeat', async () => {
    const ws = new WebSocket(`${wsUrl}?token=test-token`);

    const response = await new Promise<unknown>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'presence.heartbeat',
          correlationId: 'test-1',
        }));
      };
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data));
      };
    });

    expect(response).toMatchObject({
      type: 'presence.heartbeat',
      data: { ok: true },
      correlationId: 'test-1',
    });

    ws.close();
  });
});
```

## Test Naming Conventions

OriJS recommends the `should {expected behavior} when {condition}` pattern:

```typescript
it('should return 404 when user does not exist');
it('should create user when input is valid');
it('should reject connection when token is expired');
it('should retry failed jobs with exponential backoff');
it('should invalidate cache when entity is updated');
```

This naming style:
- Starts with the expected behavior (what should happen)
- Ends with the condition (when it should happen)
- Reads like a specification

## Summary

OriJS testing provides:

1. **Three-layer strategy** — unit, functional, and E2E tests for comprehensive coverage
2. **Plain class testability** — no framework bootstrapping needed for unit tests
3. **Mock factories** for `RequestContext`, `AppContext`, `EventContext`, and `WorkflowContext`
4. **Signal handling control** — disable for tests to prevent test runner interference
5. **DI container access** — `app.getContainer().resolve()` for functional tests
6. **Port 0 binding** — random port for parallel test execution

The key advantage of OriJS's testing story is that your classes are just classes. No decorators, no metadata, no module bootstrapping. Mock the dependencies, call the methods, assert the results.

[Previous: Caching ←](./13-caching.md) | [Next: Advanced Patterns →](./15-advanced-patterns.md)
