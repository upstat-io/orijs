# Advanced Patterns

This guide covers advanced patterns and architectural concepts in OriJS.

---

## Overview

This document covers:

- **Injection Tokens** - Named dependencies for multiple instances
- **Async Resolution** - Services with async constructors
- **Lifecycle Hooks** - Startup, ready, and shutdown phases
- **Extension Functions** - Composing application configuration
- **Context Patterns** - Request, event, and workflow contexts
- **Error Handling** - Framework errors and custom errors
- **Fluent Builder Patterns** - Type-safe configuration APIs

---

## Injection Tokens

### The Problem

When you need multiple instances of the same type:

```typescript
// Problem: Can't distinguish between primary and replica databases
class UserRepository {
	constructor(
		private primaryDb: DatabaseService, // Which instance?
		private replicaDb: DatabaseService // Same type!
	) {}
}
```

### Solution: createToken()

Use `createToken<T>()` to create typed, named injection tokens:

```typescript
import { createToken } from '@orijs/core';

// Create typed tokens
const PrimaryDB = createToken<DatabaseService>('PrimaryDB');
const ReplicaDB = createToken<DatabaseService>('ReplicaDB');

// Register with different instances
Ori.create()
	.providerInstance(PrimaryDB, new DatabaseService(primaryConfig))
	.providerInstance(ReplicaDB, new DatabaseService(replicaConfig))
	.provider(UserRepository, [PrimaryDB, ReplicaDB]);
```

### Token Patterns

```typescript
// Configuration tokens
const AppConfig = createToken<AppConfig>('AppConfig');
const FeatureFlags = createToken<FeatureFlags>('FeatureFlags');

// Service tokens (for different implementations)
const HotCache = createToken<CacheService>('HotCache');
const ColdCache = createToken<CacheService>('ColdCache');

// External dependency tokens
const SqlClient = createToken<SQL>('SqlClient');
const RedisClient = createToken<Redis>('RedisClient');
```

### Provider Registration Methods

| Method                                 | Use Case                       | Example                                            |
| -------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `.provider(Class, [deps])`             | Class with constructor deps    | `.provider(UserService, [UserRepo])`               |
| `.providerInstance(token, value)`      | Pre-created instance or config | `.providerInstance(SqlClient, sql)`                |
| `.providerWithTokens(Class, [tokens])` | Class depends on tokens        | `.providerWithTokens(CacheService, [RedisClient])` |

---

## Async Resolution

### When Needed

Some services require async initialization:

```typescript
class DatabaseService {
	private pool: Pool;

	// Constructor returns a Promise (async initialization)
	constructor(config: DbConfig) {
		return (async () => {
			this.pool = await createPool(config);
			return this;
		})() as unknown as DatabaseService;
	}
}
```

### Using resolveAsync()

```typescript
// In AppContext or Container
const dbService = await ctx.resolveAsync(DatabaseService);

// In Application setup
Ori.create().onStartup(async (ctx) => {
	// Services with async constructors must use resolveAsync
	const db = await ctx.resolveAsync(DatabaseService);
	await db.runMigrations();
});
```

### Resolution Timeout

The container monitors resolution time and logs warnings:

```typescript
// Default timeout: 5 seconds
// If resolution takes longer, a warning is logged

const container = new Container({ logger });
container.resolve(SlowService); // Warning if > 5 seconds
```

---

## Lifecycle Hooks

### Lifecycle Phases

```
created → bootstrapped → starting → ready → stopping → stopped
   │           │            │         │         │         │
   │           │            │         │         │         └─ cleanup complete
   │           │            │         │         └─ shutdown hooks running
   │           │            │         └─ server listening, ready hooks done
   │           │            └─ startup hooks running
   │           └─ DI container ready, before server
   └─ Application created, not configured
```

### Registering Hooks

```typescript
Ori.create()
	// Runs after bootstrap, before server starts
	.onStartup(async (ctx) => {
		// Run migrations, warm caches, etc.
		await ctx.resolve(DatabaseService).runMigrations();
		await ctx.resolve(CacheService).warm();
	})

	// Runs after server starts listening
	.onReady(async (ctx) => {
		// Register with service discovery, start background jobs
		await ctx.resolve(ServiceDiscovery).register();
	})

	// Runs on shutdown (LIFO order)
	.onShutdown(async (ctx) => {
		// Close connections, flush buffers
		await ctx.resolve(CacheService).flush();
		await ctx.resolve(DatabaseService).close();
	})

	.listen(3000);
```

### Hook Execution Order

- **Startup hooks**: FIFO (first registered runs first)
- **Ready hooks**: FIFO (first registered runs first)
- **Shutdown hooks**: LIFO (last registered runs first)

This ensures proper cleanup order - resources opened last are closed first.

### Error Handling in Hooks

```typescript
// Startup/Ready: Errors are fatal (application won't start)
.onStartup(async (ctx) => {
  const result = await ctx.resolve(DatabaseService).healthCheck();
  if (!result.healthy) {
    throw new Error('Database not healthy');  // Prevents startup
  }
})

// Shutdown: Errors are logged but don't stop other hooks
.onShutdown(async (ctx) => {
  try {
    await ctx.resolve(ExternalService).disconnect();
  } catch (e) {
    // Logged, but next shutdown hook still runs
  }
})
```

### Graceful Shutdown

```typescript
Ori.create()
	.shutdownTimeout(15000) // 15 second timeout
	.onShutdown(async (ctx) => {
		// Complete in-flight requests
		await ctx.resolve(RequestTracker).waitForPendingRequests();

		// Close database connections
		await ctx.resolve(DatabaseService).close();
	})
	.listen(3000);
```

### Disabling Signal Handling

For tests or when managing signals externally:

```typescript
// Tests: Prevent interference with test runner
Ori.create().disableSignalHandling().listen(0);

// Custom signal handling
Ori.create().disableSignalHandling().listen(3000);

// Handle signals manually
process.on('SIGTERM', async () => {
	await customShutdownLogic();
	await app.stop();
	process.exit(0);
});
```

---

## Extension Functions

### The Problem

Large application configurations become unwieldy:

```typescript
// Messy: All configuration in one place
Ori.create()
	.provider(UserService, [UserRepo])
	.provider(UserRepo, [DatabaseService])
	.provider(OrderService, [OrderRepo])
	.provider(OrderRepo, [DatabaseService])
	.provider(PaymentService, [PaymentGateway])
	.provider(NotificationService, [EmailClient, SmsClient])
	// ... 50 more providers
	.controller('/api/users', UserController, [UserService])
	.controller('/api/orders', OrderController, [OrderService])
	// ... 20 more controllers
	.listen(3000);
```

### Solution: Extension Functions

Create modular configuration functions:

```typescript
// modules/users.ts
export function configureUsers(app: Application): Application {
	return app
		.provider(UserService, [UserRepo])
		.provider(UserRepo, [DatabaseService])
		.controller('/api/users', UserController, [UserService]);
}

// modules/orders.ts
export function configureOrders(app: Application): Application {
	return app
		.provider(OrderService, [OrderRepo])
		.provider(OrderRepo, [DatabaseService])
		.provider(PaymentService, [PaymentGateway])
		.controller('/api/orders', OrderController, [OrderService, PaymentService]);
}

// modules/infrastructure.ts
export function configureInfrastructure(app: Application): Application {
	return app
		.providerInstance(SqlClient, createSqlClient())
		.providerInstance(RedisClient, createRedisClient())
		.provider(DatabaseService, [SqlClient])
		.provider(CacheService, [RedisClient]);
}
```

### Composing Extension Functions

```typescript
// app.ts - Clean and modular
import { configureInfrastructure } from './modules/infrastructure';
import { configureUsers } from './modules/users';
import { configureOrders } from './modules/orders';

let app = Ori.create();

// Apply extensions in order
app = configureInfrastructure(app);
app = configureUsers(app);
app = configureOrders(app);

// Add cross-cutting concerns
app
	.onStartup(async (ctx) => {
		await ctx.resolve(DatabaseService).runMigrations();
	})
	.listen(3000);
```

### Extension Function Patterns

```typescript
// Pattern 1: Domain module
export function configureNotifications(app: Application): Application {
	return app
		.provider(EmailService, [SmtpClient])
		.provider(SmsService, [TwilioClient])
		.provider(NotificationRouter, [EmailService, SmsService])
		.eventHandler(NotificationHandler, [NotificationRouter]);
}

// Pattern 2: Infrastructure with config
export function configureCache(app: Application, options: { provider: 'redis' | 'memory' }): Application {
	if (options.provider === 'redis') {
		return app.providerInstance(RedisClient, createRedisClient()).provider(CacheService, [RedisClient]);
	}
	return app.provider(CacheService); // In-memory
}

// Pattern 3: Feature flag driven
export function configureFeatures(app: Application, features: FeatureFlags): Application {
	if (features.newPaymentFlow) {
		app = app.provider(PaymentService, [NewPaymentGateway]);
	} else {
		app = app.provider(PaymentService, [LegacyPaymentGateway]);
	}
	return app;
}
```

---

## Context Patterns

### Context Hierarchy

```
AppContext (application-scoped)
    │
    ├── RequestContext (HTTP request-scoped)
    │       └── log, request, params, query, state
    │
    ├── EventContext (event-scoped)
    │       └── log, data, emit, correlationId
    │
    └── WorkflowContext (workflow step-scoped)
            └── log, data, getResult, emit
```

### AppContext Usage

```typescript
class UserService {
	constructor(private ctx: AppContext) {}

	async createUser(data: CreateUserDto): Promise<User> {
		const user = await this.userRepo.create(data);

		// Emit event through context
		this.ctx.event?.emit('user.created', { userId: user.id });

		// Start workflow through context
		await this.ctx.workflows.start('onboarding', { userId: user.id });

		return user;
	}
}
```

### RequestContext Patterns

```typescript
class UserController implements OriController {
	configure(r: RouteBuilder) {
		r.get('/users/:id', this.getUser);
	}

	private getUser = async (ctx: RequestContext) => {
		// Access validated params
		const userId = ctx.getValidatedUUID('id');

		// Access auth state (set by guard)
		const requesterId = ctx.state.userId;

		// Access request metadata
		ctx.log.info('Fetching user', {
			userId,
			requesterId,
			requestId: ctx.requestId
		});

		const user = await this.userService.getUser(userId);
		return ctx.json(user);
	};
}
```

### State Propagation

```typescript
// Guard sets state
class AuthGuard implements OriGuard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const token = ctx.request.headers.get('Authorization');
    const payload = await this.jwt.verify(token);

    // Set state for downstream handlers
    ctx.state.userId = payload.sub;
    ctx.state.roles = payload.roles;
    ctx.state.tenantId = payload.tenantId;

    return true;
  }
}

// Handler reads state
private createOrder = async (ctx: RequestContext) => {
  const order = await this.orderService.create({
    ...await ctx.json(),
    userId: ctx.state.userId,      // From guard
    tenantId: ctx.state.tenantId,  // From guard
  });

  return ctx.json(order, 201);
};
```

---

## Error Handling

### Framework Errors

OriJS provides typed errors for common scenarios:

```typescript
import { FrameworkError } from '@orijs/core';

// FrameworkError includes structured context
throw new FrameworkError('User not found', {
	code: 'USER_NOT_FOUND',
	httpStatus: 404,
	context: { userId }
});
```

### Error Response Format

```typescript
// Default error response (RFC 7807 style)
{
  "type": "https://api.example.com/errors/user-not-found",
  "title": "User Not Found",
  "status": 404,
  "detail": "No user exists with ID: user-123",
  "requestId": "req-abc-123"
}
```

### Custom Error Classes

```typescript
// domain/errors.ts
export class UserNotFoundError extends Error {
	public readonly code = 'USER_NOT_FOUND';
	public readonly httpStatus = 404;

	constructor(public readonly userId: string) {
		super(`User not found: ${userId}`);
	}
}

export class InsufficientBalanceError extends Error {
	public readonly code = 'INSUFFICIENT_BALANCE';
	public readonly httpStatus = 422;

	constructor(
		public readonly required: number,
		public readonly available: number
	) {
		super(`Insufficient balance: required ${required}, available ${available}`);
	}
}
```

### Error Handling in Controllers

```typescript
class OrderController implements OriController {
	private createOrder = async (ctx: RequestContext) => {
		try {
			const order = await this.orderService.create(await ctx.json());
			return ctx.json(order, 201);
		} catch (error) {
			if (error instanceof InsufficientBalanceError) {
				return ctx.json(
					{
						type: 'https://api.example.com/errors/insufficient-balance',
						title: 'Insufficient Balance',
						status: 422,
						detail: error.message,
						required: error.required,
						available: error.available
					},
					422
				);
			}

			// Rethrow unknown errors (handled by global error handler)
			throw error;
		}
	};
}
```

---

## Fluent Builder Patterns

### Principles

OriJS uses fluent builders extensively. Key principles:

1. **Staged Interfaces** - Enforce method order at compile time
2. **Immutable Results** - Builder output is frozen
3. **Type-Safe Inputs** - Generics validate entity names
4. **Natural Language** - Methods read like sentences

### Staged Interfaces Example

```typescript
// Interface enforces: ttl() must come before build()
interface CacheBuilderForEntity<T> {
	ttl(duration: Duration): CacheBuilderWithTtl<T>; // Returns next stage
}

interface CacheBuilderWithTtl<T> {
	grace(duration: Duration): CacheBuilderWithTtl<T>; // Optional, returns same stage
	dependsOn(entity: EntityDef): CacheBuilderWithTtl<T>; // Optional
	build(): Readonly<CacheConfig<T>>; // Terminal, returns frozen config
}

// Usage - ttl() required before build()
const UserCache = Cache.for(Entities.User)
	.ttl('5m') // Returns CacheBuilderWithTtl
	.grace('1m') // Optional
	.build(); // Only available after ttl()

// Compile error: build() not available without ttl()
const Invalid = Cache.for(Entities.User).build(); // Error!
```

### Immutable Results

```typescript
// Builder always freezes output
public build(): Readonly<CacheConfig<TParams>> {
  return Object.freeze({
    entity: this._entityName,
    ttl: this._ttl,
    grace: this._grace,
    params: Object.freeze([...this._params]),
    dependsOn: Object.freeze(this._dependsOn),
  });
}
```

### ChainedBuilder Pattern

For builders where methods can be called in any order:

```typescript
abstract class ChainedBuilder<T> implements MapperBuilder<T> {
	protected finalized = false;

	protected abstract doFinalize(): void;

	protected finalize(): void {
		if (this.finalized) return;
		this.finalized = true;
		this.doFinalize();
	}

	// All builder methods call finalize() before switching context
	public json<J>(column: string): JsonBuilder<T, J> {
		this.finalize(); // Commit current builder state
		return this.parent.json(column);
	}

	public build(): BuiltMapper<T> {
		this.finalize();
		return this.parent.build();
	}
}
```

### Type-Safe Entity Names

```typescript
// Registry provides entity names at compile time
interface CacheBuilderFactory<TEntityNames extends string> {
	for(entity: TEntityNames | EntityDef<TEntityNames>): CacheBuilderForEntity;
}

const Cache = createCacheBuilder(registry);

// Compile-time validation of entity names
Cache.for(Entities.Monitor); // OK - EntityDef object
Cache.for('Monitor'); // OK - valid string
Cache.for('Invalid'); // Error - not in registry!
```

---

## Configuration Patterns

### Environment-Based Configuration

```typescript
import { EnvConfigProvider, createValidatedConfig } from '@orijs/config';
import { Type } from '@orijs/validation';

const AppConfigSchema = Type.Object({
	port: Type.Number({ default: 3000 }),
	databaseUrl: Type.String(),
	redisUrl: Type.String({ default: 'redis://localhost:6379' }),
	logLevel: Type.Union(
		[Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
		{ default: 'info' }
	)
});

const config = createValidatedConfig(AppConfigSchema);

Ori.create()
	.config(new EnvConfigProvider())
	.onStartup(async (ctx) => {
		const port = await config.get('port', ctx.config);
		const dbUrl = await config.get('databaseUrl', ctx.config);
	});
```

### Namespaced Configuration

```typescript
// Group related config with prefixes
const DatabaseConfig = createNamespacedConfig('DATABASE_', {
	host: Type.String({ default: 'localhost' }),
	port: Type.Number({ default: 5432 }),
	name: Type.String(),
	poolSize: Type.Number({ default: 10 })
});

// Reads DATABASE_HOST, DATABASE_PORT, etc.
const dbConfig = await DatabaseConfig.load(ctx.config);
// { host: 'localhost', port: 5432, name: 'myapp', poolSize: 10 }
```

---

## Multi-Tenancy Patterns

### Tenant Context Propagation

```typescript
// Guard extracts tenant from request
class TenantGuard implements OriGuard {
	async canActivate(ctx: RequestContext): Promise<boolean> {
		const tenantId = ctx.request.headers.get('X-Tenant-ID');
		if (!tenantId) {
			ctx.log.warn('Missing tenant header');
			return false;
		}

		// Validate tenant exists
		const tenant = await this.tenantService.findById(tenantId);
		if (!tenant || !tenant.active) {
			return false;
		}

		ctx.state.tenantId = tenantId;
		ctx.state.tenant = tenant;
		return true;
	}
}

// Service uses tenant from context
class OrderService {
	async listOrders(tenantId: string): Promise<Order[]> {
		// Repository automatically filters by tenant
		return this.orderRepo.findByTenant(tenantId);
	}
}
```

### Cache Scoping by Tenant

```typescript
// Entity registry with tenant scope
const registry = EntityRegistry.create()
	.scope('global')
	.scope('tenant', 'tenantId')
	.scope('account', 'accountId')
	.entity('User', 'tenant', 'userId')
	.entity('Order', 'account', 'orderId')
	.build();

// Caches are automatically scoped
const UserCache = Cache.for(Entities.User).ttl('5m').build();

// Different tenants have separate cache entries
await cacheService.getOrSet(UserCache, { tenantId: 'tenant-1', userId: 'u1' }, factory);
await cacheService.getOrSet(UserCache, { tenantId: 'tenant-2', userId: 'u1' }, factory);
// These are separate cache entries
```

---

## Testing Patterns

### Provider Instance Injection

```typescript
describe('OrderController', () => {
	let app: Application;
	let mockOrderService: OrderService;

	beforeEach(async () => {
		mockOrderService = {
			create: mock(() => Promise.resolve({ id: 'order-1' })),
			findById: mock(() => Promise.resolve(null))
		} as any;

		app = Ori.create()
			.disableSignalHandling()
			.providerInstance(OrderService, mockOrderService)
			.controller('/api/orders', OrderController, [OrderService]);

		await app.listen(0);
	});

	it('calls service with correct data', async () => {
		await fetch(`http://localhost:${app.port}/api/orders`, {
			method: 'POST',
			body: JSON.stringify({ items: [] })
		});

		expect(mockOrderService.create).toHaveBeenCalledWith(expect.objectContaining({ items: [] }));
	});
});
```

### Testing Lifecycle Hooks

```typescript
describe('Application Lifecycle', () => {
	it('executes hooks in correct order', async () => {
		const order: string[] = [];

		const app = Ori.create()
			.disableSignalHandling()
			.onStartup(async () => {
				order.push('startup-1');
			})
			.onStartup(async () => {
				order.push('startup-2');
			})
			.onReady(async () => {
				order.push('ready');
			})
			.onShutdown(async () => {
				order.push('shutdown-1');
			})
			.onShutdown(async () => {
				order.push('shutdown-2');
			});

		await app.listen(0);
		await app.stop();

		// Startup: FIFO, Shutdown: LIFO
		expect(order).toEqual([
			'startup-1',
			'startup-2',
			'ready',
			'shutdown-2', // Last registered, first executed
			'shutdown-1'
		]);
	});
});
```

---

## Next Steps

- [Core Concepts](./core-concepts.md) - DI container fundamentals
- [HTTP Routing](./http-routing.md) - Controllers and routes
- [Events](./events.md) - Event-driven patterns
- [Workflows](./workflows.md) - Saga and workflow patterns
- [Testing](./testing.md) - Test patterns and infrastructure
