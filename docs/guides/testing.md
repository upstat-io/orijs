# Testing

This guide covers testing patterns for OriJS applications using Bun's built-in test runner.

---

## Overview

OriJS testing follows a three-layer approach:

1. **Unit Tests** - Test individual functions/methods with mocked dependencies
2. **Functional Tests** - Test components with real dependencies (or real infrastructure)
3. **E2E Tests** - Test the full application stack

---

## Test Infrastructure

### @orijs/test-utils Package

The `@orijs/test-utils` package provides test infrastructure for OriJS:

```typescript
import {
	createBunTestPreload,
	createRedisTestHelper,
	teardownBunTest,
	type RedisTestHelper
} from '@orijs/test-utils';
```

### Setup: bunfig.toml + preload.ts

Every package with functional tests needs two files:

**bunfig.toml** (package root):

```toml
[test]
preload = ["./__tests__/preload.ts"]
```

**\_\_tests\_\_/preload.ts**:

```typescript
import { createBunTestPreload } from '@orijs/test-utils';

const preload = createBunTestPreload({
	packageName: 'my-package', // Must match helper calls in tests
	dependencies: ['redis'] // Start Redis container
});

await preload();
```

---

## File Naming Conventions

Test files must include `.test` in the filename for Bun to recognize them.

| Layer      | File Pattern           | Location         | Example                        |
| ---------- | ---------------------- | ---------------- | ------------------------------ |
| Unit       | `*.test.ts`            | `__tests__/`     | `user-service.test.ts`         |
| Functional | `*.functional.test.ts` | `__tests__/`     | `cache.functional.test.ts`     |
| E2E        | `*.test.ts`            | `__tests__/e2e/` | `event-workflow-chain.test.ts` |

### Directory Structure

```
packages/my-package/
├── src/
│   └── my-service.ts
├── __tests__/
│   ├── preload.ts                    # Container setup
│   ├── my-service.test.ts            # Unit tests
│   ├── my-service.functional.test.ts # Functional tests
│   └── e2e/
│       └── my-flow.test.ts           # E2E tests
└── bunfig.toml                       # Test configuration
```

### Naming Rules

1. **Test file names** match source file names: `user-service.ts` → `user-service.test.ts`
2. **Functional tests** add `.functional` before `.test.ts`
3. **E2E tests** go in `e2e/` subdirectory
4. **Use kebab-case** for file names: `user-service.test.ts`

---

## Test Setup

### Basic Test File

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

describe('MyService', () => {
	it('should do something', () => {
		// Test code
	});
});
```

### Test File with Setup/Teardown

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

describe('MyService', () => {
	let service: MyService;

	beforeAll(async () => {
		// One-time setup (database connections, containers)
	});

	afterAll(async () => {
		// One-time cleanup
	});

	beforeEach(() => {
		// Reset state between tests
		service = new MyService();
	});

	it('should work', () => {
		expect(service.doSomething()).toBe(true);
	});
});
```

---

## Unit Testing

### Mocking Dependencies with `mock()`

Bun provides a `mock()` function for creating mock functions:

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('UserService', () => {
	it('returns user when found', async () => {
		// Create mock function
		const findUser = mock(() => Promise.resolve({ id: '1', name: 'Alice' }));

		// Create mock dependency
		const mockDb = { findUser };

		// Inject mock into service
		const service = new UserService(mockDb as any);
		const user = await service.getUser('1');

		// Assert result
		expect(user).toEqual({ id: '1', name: 'Alice' });

		// Assert mock was called correctly
		expect(findUser).toHaveBeenCalledWith('1');
		expect(findUser).toHaveBeenCalledTimes(1);
	});

	it('returns null when user not found', async () => {
		const mockDb = {
			findUser: mock(() => Promise.resolve(null))
		};

		const service = new UserService(mockDb as any);
		const user = await service.getUser('999');

		expect(user).toBeNull();
	});
});
```

### Mock Return Values

```typescript
// Single return value
const fn = mock(() => 'result');

// Async return value
const asyncFn = mock(() => Promise.resolve('async-result'));

// Sequence of return values
const sequenceFn = mock()
	.mockReturnValueOnce('first')
	.mockReturnValueOnce('second')
	.mockReturnValue('default');

expect(sequenceFn()).toBe('first');
expect(sequenceFn()).toBe('second');
expect(sequenceFn()).toBe('default');

// Throw error
const throwingFn = mock(() => {
	throw new Error('Something went wrong');
});

// Async rejection
const rejectingFn = mock(() => Promise.reject(new Error('Async failure')));
```

### Mock Assertions

```typescript
const fn = mock();

fn('arg1', 'arg2');
fn('arg3');

// Call count
expect(fn).toHaveBeenCalled();
expect(fn).toHaveBeenCalledTimes(2);

// Specific arguments
expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
expect(fn).toHaveBeenLastCalledWith('arg3');

// Access call history
expect(fn.mock.calls).toEqual([['arg1', 'arg2'], ['arg3']]);

// Access return values
expect(fn.mock.results).toHaveLength(2);
```

### Creating Mock Objects

```typescript
// Factory function for creating mock objects
function createMockUserRepository(): UserRepository {
	return {
		findById: mock(() => Promise.resolve({ id: '1', name: 'Alice' })),
		create: mock(() => Promise.resolve({ id: '2', name: 'Bob' })),
		update: mock(() => Promise.resolve({ id: '1', name: 'Alice Updated' })),
		delete: mock(() => Promise.resolve())
	} as unknown as UserRepository;
}

describe('UserService', () => {
	let mockRepo: ReturnType<typeof createMockUserRepository>;
	let service: UserService;

	beforeEach(() => {
		mockRepo = createMockUserRepository();
		service = new UserService(mockRepo);
	});

	it('delegates to repository', async () => {
		const user = await service.findUser('1');

		expect(mockRepo.findById).toHaveBeenCalledWith('1');
		expect(user?.name).toBe('Alice');
	});
});
```

### Testing with AppContext

```typescript
describe('OrderService', () => {
	it('emits event on order creation', async () => {
		const emitMock = mock(() => Promise.resolve());

		const mockCtx = {
			log: { info: () => {}, error: () => {} },
			event: { emit: emitMock }
		};

		const service = new OrderService(mockCtx as any, mockDb as any);
		await service.createOrder({ items: [] });

		expect(emitMock).toHaveBeenCalledWith('order.created', expect.any(Object));
	});
});
```

---

## Mock Factories

### AppContext Mock Factory

```typescript
// test/mocks.ts
export function createMockAppContext(overrides: Partial<AppContext> = {}): AppContext {
	return {
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		},
		config: {
			get: () => Promise.resolve(undefined),
			getRequired: () => Promise.reject(new Error('Not configured')),
			loadKeys: () => Promise.resolve({})
		},
		event: undefined,
		workflows: {} as any,
		hasWorkflows: false,
		phase: 'ready',
		onStartup: () => {},
		onReady: () => {},
		onShutdown: () => {},
		resolve: () => {
			throw new Error('Not configured');
		},
		resolveAsync: () => Promise.reject(new Error('Not configured')),
		...overrides
	} as AppContext;
}
```

### RequestContext Mock Factory

```typescript
export function createMockRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
	return {
		request: new Request('http://localhost/test'),
		params: {},
		query: {},
		state: {},
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		},
		event: undefined,
		json: async () => ({}),
		text: async () => '',
		formData: async () => new FormData(),
		...overrides
	} as RequestContext;
}
```

### EventContext Mock Factory

```typescript
export function createMockEventContext<T = unknown>(
	eventName: string,
	data: T,
	overrides: Partial<EventContext<T>> = {}
): EventContext<T> {
	return {
		eventName,
		data,
		correlationId: crypto.randomUUID(),
		causationId: undefined,
		timestamp: Date.now(),
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		},
		emit: mock(() => {}),
		...overrides
	} as EventContext<T>;
}
```

### WorkflowContext Mock Factory

```typescript
export function createMockWorkflowContext<T = unknown>(
	data: T,
	stepResults: Record<string, unknown> = {}
): WorkflowContext<T> {
	return {
		data,
		correlationId: crypto.randomUUID(),
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		},
		getResult: (stepName: string) => stepResults[stepName],
		emit: mock(() => {})
	} as unknown as WorkflowContext<T>;
}
```

---

## Functional Testing

### Testing with Redis

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createRedisTestHelper, type RedisTestHelper } from '@orijs/test-utils';

describe('Cache Functional Tests', () => {
	let redisHelper: RedisTestHelper;

	beforeAll(() => {
		// Package name must match preload.ts
		redisHelper = createRedisTestHelper('my-package');

		if (!redisHelper.isReady()) {
			throw new Error('Redis container not ready - check preload.ts');
		}
	});

	beforeEach(async () => {
		// Clear Redis between tests
		await redisHelper.flushAll();
	});

	it('should cache values in Redis', async () => {
		const redis = redisHelper.createRedisClient();

		await redis.set('key', 'value');
		const result = await redis.get('key');

		expect(result).toBe('value');

		await redis.quit();
	});
});
```

### Testing with BullMQ Queues

```typescript
import { Worker } from 'bullmq';

describe('Queue Functional Tests', () => {
	let redisHelper: RedisTestHelper;

	beforeAll(() => {
		redisHelper = createRedisTestHelper('my-package');
		if (!redisHelper.isReady()) {
			throw new Error('Redis not ready');
		}
	});

	it('should process queue jobs', async () => {
		const queue = redisHelper.createQueue('test-queue');
		const results: any[] = [];

		// Create worker
		const worker = new Worker(
			`${redisHelper.getPackageName()}-test-queue`,
			async (job) => {
				results.push(job.data);
				return { processed: true };
			},
			{ connection: redisHelper.getConnectionConfig() }
		);

		// Add job
		await queue.add('test-job', { value: 42 });

		// Wait for completion
		const completedJob = await redisHelper.waitForJobCompletion('test-queue', 5000);

		expect(completedJob.returnvalue).toEqual({ processed: true });
		expect(results).toEqual([{ value: 42 }]);

		await worker.close();
		await queue.close();
	});
});
```

### Testing CacheService with Registry

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { createRedisTestHelper } from '@orijs/test-utils';
import { EntityRegistry, createCacheBuilder, CacheService, cacheRegistry } from '@orijs/cache';
import { RedisCacheProvider } from '@orijs/cache-redis';

describe('CacheService Functional', () => {
	let redisHelper: RedisTestHelper;
	let cacheService: CacheService;
	let provider: RedisCacheProvider;

	beforeAll(() => {
		redisHelper = createRedisTestHelper('my-package');
		if (!redisHelper.isReady()) {
			throw new Error('Redis not ready');
		}

		const config = redisHelper.getConnectionConfig();
		provider = new RedisCacheProvider({
			connection: { host: config.host, port: config.port }
		});
		cacheService = new CacheService(provider);
	});

	beforeEach(async () => {
		await redisHelper.flushAll();
		cacheRegistry.reset(); // Reset global cache registry
	});

	afterAll(async () => {
		await provider.stop();
	});

	it('should cache and retrieve values', async () => {
		const registry = EntityRegistry.create()
			.scope('global')
			.scope('account', 'accountUuid')
			.entity('User', 'account', 'userUuid')
			.build();

		const Cache = createCacheBuilder(registry);
		const UserCache = Cache.for('User').ttl('1h').build();

		let factoryCalls = 0;
		const params = { accountUuid: 'acc-1', userUuid: 'usr-1' };

		// First call - cache miss
		const result1 = await cacheService.getOrSet(UserCache, params, async () => {
			factoryCalls++;
			return { id: 'usr-1', name: 'Alice' };
		});

		// Second call - cache hit
		const result2 = await cacheService.getOrSet(UserCache, params, async () => {
			factoryCalls++;
			return { id: 'usr-1', name: 'Bob' };
		});

		expect(factoryCalls).toBe(1); // Factory only called once
		expect(result1).toEqual({ id: 'usr-1', name: 'Alice' });
		expect(result2).toEqual({ id: 'usr-1', name: 'Alice' }); // Cached value
	});
});
```

---

## Testing Controllers

### HTTP Integration Tests

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Ori, Application } from '@orijs/core';

describe('UserController', () => {
	let app: Application;
	let baseUrl: string;

	beforeEach(async () => {
		app = Ori.create()
			.disableSignalHandling() // IMPORTANT: Prevent test runner interference
			.provider(UserService)
			.controller('/api/users', UserController, [UserService]);

		const server = await app.listen(0); // Random available port
		baseUrl = `http://localhost:${server.port}`;
	});

	afterEach(async () => {
		await app.stop();
	});

	it('GET /api/users returns users list', async () => {
		const response = await fetch(`${baseUrl}/api/users`);

		expect(response.status).toBe(200);

		const users = await response.json();
		expect(Array.isArray(users)).toBe(true);
	});

	it('POST /api/users creates user', async () => {
		const response = await fetch(`${baseUrl}/api/users`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', email: 'alice@test.com' })
		});

		expect(response.status).toBe(201);

		const user = await response.json();
		expect(user.name).toBe('Alice');
		expect(user.id).toBeDefined();
	});

	it('GET /api/users/:id returns 404 for unknown user', async () => {
		const response = await fetch(`${baseUrl}/api/users/unknown-id`);

		expect(response.status).toBe(404);
	});
});
```

### Testing with Mock Service Instances

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Ori, Application, createToken } from '@orijs/core';

describe('UserController with Mocks', () => {
	let app: Application;
	let baseUrl: string;
	let mockUserService: { createUser: ReturnType<typeof mock> };

	beforeEach(async () => {
		mockUserService = {
			createUser: mock(() => Promise.resolve({ id: '1', name: 'Alice' })),
			getUser: mock(() => Promise.resolve({ id: '1', name: 'Alice' })),
			deleteUser: mock(() => Promise.resolve())
		};

		app = Ori.create()
			.disableSignalHandling()
			// Inject mock instance directly
			.providerInstance(UserService, mockUserService as any)
			.controller('/api/users', UserController, [UserService]);

		const server = await app.listen(0);
		baseUrl = `http://localhost:${server.port}`;
	});

	afterEach(async () => {
		await app.stop();
	});

	it('calls service and returns 201', async () => {
		const response = await fetch(`${baseUrl}/api/users`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Alice' })
		});

		expect(response.status).toBe(201);
		expect(mockUserService.createUser).toHaveBeenCalledTimes(1);
		expect(mockUserService.createUser).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alice' }));
	});
});
```

### Provider Registration Methods

| Method                                   | Use Case                                  |
| ---------------------------------------- | ----------------------------------------- |
| `.provider(Service, [Dep1, Dep2])`       | Real classes with class constructor deps  |
| `.providerInstance(token, instance)`     | Pre-created mock objects or config values |
| `.providerWithTokens(Service, [token1])` | Service depends on injection tokens       |

---

## Testing Guards

### Unit Testing Guards

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('AuthGuard', () => {
	it('returns true for valid token', async () => {
		const mockJwtService = {
			verify: mock(() => Promise.resolve({ sub: 'user-123' }))
		};

		const guard = new AuthGuard(mockJwtService as any);

		const ctx = {
			request: {
				headers: new Headers({ Authorization: 'Bearer valid-token' })
			},
			state: {},
			log: { warn: () => {}, error: () => {} }
		};

		const result = await guard.canActivate(ctx as any);

		expect(result).toBe(true);
		expect(ctx.state.userId).toBe('user-123');
	});

	it('returns false for missing token', async () => {
		const guard = new AuthGuard({} as any);

		const ctx = {
			request: { headers: new Headers() },
			state: {},
			log: { warn: () => {} }
		};

		const result = await guard.canActivate(ctx as any);

		expect(result).toBe(false);
	});

	it('returns false for invalid token', async () => {
		const mockJwtService = {
			verify: mock(() => Promise.reject(new Error('Invalid token')))
		};

		const guard = new AuthGuard(mockJwtService as any);

		const ctx = {
			request: {
				headers: new Headers({ Authorization: 'Bearer bad-token' })
			},
			state: {},
			log: { warn: () => {} }
		};

		const result = await guard.canActivate(ctx as any);

		expect(result).toBe(false);
	});
});
```

### Integration Testing Guards

```typescript
describe('Auth Integration', () => {
	let app: Application;
	let baseUrl: string;
	let jwtService: JwtService;

	beforeEach(async () => {
		app = Ori.create()
			.disableSignalHandling()
			.provider(JwtService)
			.guard(AuthGuard, [JwtService])
			.controller('/api', ProtectedController, []);

		const server = await app.listen(0);
		baseUrl = `http://localhost:${server.port}`;
		jwtService = app.getContainer().resolve(JwtService);
	});

	afterEach(async () => {
		await app.stop();
	});

	it('rejects requests without token', async () => {
		const response = await fetch(`${baseUrl}/api/protected`);
		expect(response.status).toBe(403);
	});

	it('accepts requests with valid token', async () => {
		const token = jwtService.sign({ sub: 'user-123' });

		const response = await fetch(`${baseUrl}/api/protected`, {
			headers: { Authorization: `Bearer ${token}` }
		});

		expect(response.status).toBe(200);
	});
});
```

---

## Testing Events

### Unit Testing Event Handlers

```typescript
describe('UserEventHandler', () => {
	it('sends welcome email on user.created', async () => {
		const sendWelcome = mock(() => Promise.resolve());

		const handler = new UserEventHandler({ sendWelcome } as any);

		const ctx = createMockEventContext('user.created', { userId: 'user-123' });

		await handler['onUserCreated'](ctx);

		expect(sendWelcome).toHaveBeenCalledWith('user-123');
	});
});
```

### Integration Testing Events

```typescript
import { EventRegistry, createEventSystem } from '@orijs/events';

describe('Event Integration', () => {
	const Events = EventRegistry.create().event('user.created').event('notification.sent').build();

	it('emits and handles events', async () => {
		const system = createEventSystem(Events);
		const received: any[] = [];

		system.onEvent<{ userId: string }>('user.created', async (ctx) => {
			received.push(ctx.data);
		});

		system.emit('user.created', { userId: 'user-123' });

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(received).toHaveLength(1);
		expect(received[0].userId).toBe('user-123');

		await system.stop();
	});

	it('supports request-response pattern', async () => {
		const system = createEventSystem(Events);

		system.onEvent<{ userId: string }, { notified: boolean }>('user.created', async () => {
			return { notified: true };
		});

		const result = await system.emit<{ notified: boolean }>('user.created', { userId: 'user-123' });

		expect(result.notified).toBe(true);

		await system.stop();
	});

	it('chains events from handlers', async () => {
		const system = createEventSystem(Events);
		const notifications: string[] = [];

		system.onEvent<{ userId: string }>('user.created', async (ctx) => {
			ctx.emit('notification.sent', { type: 'welcome', userId: ctx.data.userId });
		});

		system.onEvent<{ type: string; userId: string }>('notification.sent', async (ctx) => {
			notifications.push(`${ctx.data.type}:${ctx.data.userId}`);
		});

		system.emit('user.created', { userId: 'user-123' });

		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(notifications).toEqual(['welcome:user-123']);

		await system.stop();
	});
});
```

---

## Testing Workflows

### Unit Testing Workflow Steps

```typescript
describe('OrderWorkflow', () => {
	it('reserves inventory', async () => {
		const inventoryService = {
			reserve: mock(() => Promise.resolve('res-123'))
		};

		const workflow = new OrderWorkflow(inventoryService as any, {} as any);

		const ctx = createMockWorkflowContext({ items: [{ productId: 'p1', quantity: 2 }] });

		const result = await workflow['reserveInventory'](ctx);

		expect(result.reservationId).toBe('res-123');
		expect(inventoryService.reserve).toHaveBeenCalledWith([{ productId: 'p1', quantity: 2 }]);
	});

	it('releases inventory on rollback', async () => {
		const inventoryService = {
			release: mock(() => Promise.resolve())
		};

		const workflow = new OrderWorkflow(inventoryService as any, {} as any);

		// stepResult from the original step
		const stepResult = { reservationId: 'res-123' };

		await workflow['releaseInventory']({} as any, stepResult);

		expect(inventoryService.release).toHaveBeenCalledWith('res-123');
	});
});
```

### Integration Testing Workflows

```typescript
import { WorkflowRegistry, createWorkflowSystem, InProcessWorkflowProvider } from '@orijs/workflows';

describe('Workflow Integration', () => {
	it('executes workflow with multiple steps', async () => {
		const Workflows = WorkflowRegistry.create().workflow('order-processing').build();

		const provider = new InProcessWorkflowProvider();
		const system = createWorkflowSystem(Workflows, { provider });

		// Register workflow
		system.registerWorkflow(OrderWorkflow, [MockInventoryService, MockPaymentService]);

		await system.start();

		// Start workflow
		const handle = await system.startWorkflow('order-processing', {
			orderId: 'ord-123',
			items: [{ productId: 'p1', quantity: 1 }]
		});

		// Wait for completion
		const result = await handle.result();

		expect(result.status).toBe('completed');

		await system.stop();
	});
});
```

---

## Test Helpers

### Test App Factory

```typescript
// test/helpers.ts
import { Ori, Application } from '@orijs/core';

export async function createTestApp(configure: (app: Application) => Application): Promise<{
	app: Application;
	baseUrl: string;
	cleanup: () => Promise<void>;
}> {
	let app = Ori.create().disableSignalHandling();
	app = configure(app);

	const server = await app.listen(0);
	const baseUrl = `http://localhost:${server.port}`;

	return {
		app,
		baseUrl,
		cleanup: () => app.stop()
	};
}

// Usage
describe('API Tests', () => {
	let testApp: Awaited<ReturnType<typeof createTestApp>>;

	beforeEach(async () => {
		testApp = await createTestApp((app) =>
			app.provider(UserService).controller('/api/users', UserController, [UserService])
		);
	});

	afterEach(async () => {
		await testApp.cleanup();
	});

	it('works', async () => {
		const response = await fetch(`${testApp.baseUrl}/api/users`);
		expect(response.status).toBe(200);
	});
});
```

### Wait Utilities

```typescript
// Wait for condition to be true
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeout: number = 5000,
	interval: number = 50
): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	throw new Error(`waitFor timeout after ${timeout}ms`);
}

// Wait for array to have expected length
export async function waitForLength<T>(
	arr: T[],
	expectedLength: number,
	timeout: number = 5000
): Promise<void> {
	await waitFor(() => arr.length >= expectedLength, timeout);
}

// Usage
it('should process events', async () => {
	const received: string[] = [];

	eventSystem.onEvent('test', async (ctx) => {
		received.push(ctx.data.id);
	});

	eventSystem.emit('test', { id: '1' });
	eventSystem.emit('test', { id: '2' });

	await waitForLength(received, 2);

	expect(received).toEqual(['1', '2']);
});
```

---

## Important: disableSignalHandling()

Always use `.disableSignalHandling()` in tests:

```typescript
// CORRECT - tests won't interfere with test runner
const app = Ori.create().disableSignalHandling().controller('/api', MyController).listen(0);

// WRONG - may cause issues with test runner
const app = Ori.create().controller('/api', MyController).listen(0);
```

This prevents the application from handling SIGTERM/SIGINT, which can interfere with the test runner.

---

## Test Isolation

### Clear State Between Tests

```typescript
describe('Service Tests', () => {
	let container: Container;

	beforeEach(() => {
		container = new Container();
		container.register(UserService);
	});

	afterEach(() => {
		container.clearInstances(); // Reset singleton state
	});
});
```

### Fresh App Per Test

```typescript
describe('Integration Tests', () => {
	let app: Application;

	beforeEach(async () => {
		app = Ori.create()
			.disableSignalHandling()
			.provider(UserService)
			.controller('/api', UserController, [UserService]);

		await app.listen(0);
	});

	afterEach(async () => {
		await app.stop(); // Clean up HTTP server
	});
});
```

### Clear Redis Between Tests

```typescript
beforeEach(async () => {
	await redisHelper.flushAll(); // Clear all Redis data
});
```

---

## Best Practices

### 1. Test Each Layer

```
Service Logic       → Unit Tests (mocked deps)
Service + Deps      → Functional Tests (real infra)
Full HTTP Stack     → Integration Tests
```

### 2. Use Descriptive Test Names

```typescript
// GOOD - describes behavior and condition
it('returns 404 when user does not exist', async () => { ... });
it('emits user.created event after successful creation', async () => { ... });
it('rolls back inventory when payment fails', async () => { ... });

// BAD - vague
it('works', async () => { ... });
it('test1', async () => { ... });
```

### 3. Test Error Cases

```typescript
describe('UserService', () => {
	it('throws UserNotFoundError when user does not exist', async () => {
		const service = new UserService(mockDb);

		await expect(service.getById('unknown')).rejects.toThrow(UserNotFoundError);
	});

	it('throws ValidationError for invalid email', async () => {
		const service = new UserService(mockDb);

		await expect(service.create({ name: 'Alice', email: 'invalid' })).rejects.toThrow(ValidationError);
	});
});
```

### 4. Use Random Ports

```typescript
const server = await app.listen(0); // 0 = random available port
const baseUrl = `http://localhost:${server.port}`;
```

### 5. Clean Up Resources

```typescript
afterEach(async () => {
	await app.stop();
	container.clearInstances();
	await redisHelper.flushAll();
});
```

### 6. Use Strong Assertions

```typescript
// GOOD - specific assertions
expect(user.name).toBe('Alice');
expect(user.email).toBe('alice@example.com');
expect(response.status).toBe(201);

// BAD - weak assertions
expect(user).toBeDefined();
expect(response.status).toBeTruthy();
```

### 7. Test Cardinality

```typescript
// Verify exact counts, not just "called"
expect(mockEmail.send).toHaveBeenCalledTimes(1);
expect(results).toHaveLength(3);
```

### 8. Avoid Arbitrary Timeouts

```typescript
// BAD - arbitrary wait
await new Promise((resolve) => setTimeout(resolve, 1000));

// GOOD - wait for condition
await waitFor(() => received.length > 0);

// GOOD - use built-in helpers
await redisHelper.waitForJobCompletion('queue-name', 5000);
```

---

## Running Tests

```bash
# Run all tests
bun test

# Run specific file
bun test user-service.test.ts

# Run tests matching pattern
bun test --filter "UserService"

# Watch mode
bun test --watch

# With coverage
bun test --coverage

# With timeout
bun test --timeout 30000

# Bail on first failure
bun test --bail
```

### Environment Variables

```bash
# Disable container reuse (for CI)
TESTCONTAINERS_REUSE=false bun test

# Set test package name
TEST_PACKAGE_NAME=my-package bun test
```

---

## Debugging Tests

### Console Output

```typescript
it('should process data', async () => {
	const result = await service.process(data);

	// Debug output (visible in test runner)
	console.log('Result:', result);

	expect(result).toBeDefined();
});
```

### Inspect Mock Calls

```typescript
it('should call service correctly', async () => {
	await controller.handleRequest(mockCtx);

	// Inspect all calls
	console.log('Calls:', mockService.method.mock.calls);

	// Inspect specific call
	console.log('First call args:', mockService.method.mock.calls[0]);
});
```

### Run Single Test

```typescript
// Run only this test
it.only('should do something', async () => {
	// ...
});

// Skip this test
it.skip('broken test', async () => {
	// ...
});
```

**Note**: Remove `.only` and `.skip` before committing.

---

## Next Steps

- [API Reference](./api-reference.md) - Complete API documentation
- [Troubleshooting](./troubleshooting.md) - Common test issues
- [Caching](./caching.md) - Test cache behavior
- [Events](./events.md) - Test event systems
