# Core Concepts

This guide explains the foundational concepts of OriJS: the Application, dependency injection Container, AppContext, and lifecycle management.

> **Quick start**: For a minimal working example, see the [README Quick Start](../README.md#quick-start).
> **Related**: [HTTP Routing](./http-routing.md) | [Testing](./testing.md) | [API Reference](./api-reference.md)

---

## Application

The `Application` class is the heart of OriJS. It provides a fluent builder API for configuring all aspects of your application.

### Creating an Application

```typescript
import { Ori } from '@orijs/core';

const app = Ori.create();
```

The `Ori.create()` factory is the recommended way to create applications. It returns a new `Application` instance.

### Fluent Configuration

All configuration methods return `this`, enabling method chaining:

```typescript
Ori.create()
	.logger({ level: 'debug' })
	.config(configProvider)
	.guard(AuthGuard)
	.intercept(LoggingInterceptor)
	.provider(DatabaseService)
	.provider(UserService, [DatabaseService])
	.events(EventRegistry)
	.workflows(WorkflowRegistry)
	.controller('/api/users', UserController, [UserService])
	.listen(3000);
```

### Key Configuration Methods

| Method                  | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `.config()`             | Set configuration provider               |
| `.logger()`             | Configure logging                        |
| `.guard()`              | Add global guard                         |
| `.intercept()`          | Add global interceptor                   |
| `.provider()`           | Register a service                       |
| `.providerInstance()`   | Register a pre-created instance          |
| `.providerWithTokens()` | Register service with token dependencies |
| `.cache()`              | Configure cache system                   |
| `.use()`                | Apply extension function                 |
| `.events()`             | Configure event system                   |
| `.onEvent()`            | Register inline event handler            |
| `.eventHandler()`       | Register event handler class             |
| `.workflows()`          | Configure workflow system                |
| `.controller()`         | Register a controller                    |
| `.listen()`             | Start the server                         |

### Application Context Access

The application context is available immediately after `Ori.create()`:

```typescript
const app = Ori.create();

// Register lifecycle hooks during setup (before listen)
app.context.onShutdown(async () => {
	await cleanupResources();
});

// Use .use() for cleaner registration
Ori.create()
	.use((app) => {
		app.context.onShutdown(() => cleanup());
		return app;
	})
	.listen(3000);
```

---

## Dependency Injection

OriJS uses explicit dependency injection without decorators or reflection. This approach is:

- **Type-safe**: TypeScript enforces correct dependency types at compile time
- **Transparent**: Dependencies are visible in the registration code
- **Testable**: Easy to substitute mock dependencies
- **Fast**: No runtime reflection overhead

### The Container

The `Container` manages service registration and instantiation:

```typescript
import { Container } from '@orijs/core';

const container = new Container();
container.register(DatabaseService);
container.register(UserService, [DatabaseService]);

const userService = container.resolve(UserService);
```

### Registering Services

Services are registered with their dependency list as an array:

```typescript
// Service with no dependencies
.provider(LogService)

// Service with one dependency
.provider(UserService, [LogService])

// Service with multiple dependencies
.provider(OrderService, [UserService, ProductService, LogService])
```

**Key Points:**

- Dependencies are listed in constructor parameter order
- TypeScript enforces correct types via `ConstructorDeps<T>`
- All dependencies must be registered before the dependent service

### How Dependency Resolution Works

When resolving a service, the container:

1. Checks if an instance already exists (singleton behavior)
2. Looks up the registered dependencies for the service
3. Recursively resolves each dependency
4. Instantiates the service with resolved dependencies
5. Caches the instance for future requests

```typescript
// Registration order doesn't matter - resolution is on-demand
.provider(OrderService, [UserService, ProductService])  // OrderService depends on UserService
.provider(UserService, [DatabaseService])                // UserService depends on DatabaseService
.provider(ProductService, [DatabaseService])
.provider(DatabaseService)

// When OrderService is resolved:
// 1. Resolve UserService → Resolve DatabaseService → Create DatabaseService → Create UserService
// 2. Resolve ProductService → DatabaseService already cached → Create ProductService
// 3. Create OrderService with (UserService, ProductService)
```

### Using Injection Tokens

For non-class dependencies (like database connections), use tokens:

```typescript
import postgres from 'postgres';

const sql = postgres('postgresql://...');

Ori.create()
	.providerInstance('SQL', sql) // Register with string token
	.provider(UserService, ['SQL']); // Reference by token
```

You can also use symbols for private tokens:

```typescript
const SQL_TOKEN = Symbol('SQL');

Ori.create().providerInstance(SQL_TOKEN, sql).provider(UserService, [SQL_TOKEN]);
```

### Typed Injection Tokens

Use `createToken<T>()` for type-safe tokens:

```typescript
import { createToken } from '@orijs/core';

// Create typed token
const SqlToken = createToken<ReturnType<typeof postgres>>('SQL');

// TypeScript knows the type when resolving
const sql = container.resolve(SqlToken); // type: ReturnType<typeof postgres>
```

### Named Providers (Multiple Instances)

When you need multiple instances of the same service type (e.g., multiple cache backends, multiple database connections), use `createToken()`:

```typescript
import { Ori, createToken } from '@orijs/core';

// Create typed tokens for each named instance
const HotCache = createToken<CacheService>('HotCache');
const ColdCache = createToken<CacheService>('ColdCache');

// Create different instances
const hotCacheInstance = new CacheService(inMemoryProvider);
const coldCacheInstance = new CacheService(redisProvider);

Ori.create()
	// Register each instance with its token
	.providerInstance(HotCache, hotCacheInstance)
	.providerInstance(ColdCache, coldCacheInstance)

	// Use providerWithTokens when dependencies include tokens
	.providerWithTokens(HotDataService, [HotCache])
	.providerWithTokens(ColdDataService, [ColdCache])

	.controller('/api', DataController, [HotDataService, ColdDataService])
	.listen(3000);
```

**Why `providerWithTokens()`?**

The standard `.provider()` method uses TypeScript's `ConstructorDeps<T>` to enforce that dependency types match constructor parameters. Since tokens are symbols (not classes), use `.providerWithTokens()` when your dependency array includes tokens.

```typescript
// Service with mixed dependencies (class + token)
class ApiService {
	constructor(
		private logger: LoggerService, // Class dependency
		private config: AppConfig // Token dependency
	) {}
}

const ConfigToken = createToken<AppConfig>('Config');

Ori.create()
	.provider(LoggerService)
	.providerInstance(ConfigToken, { apiKey: 'secret' })
	// Mix class and token in deps array
	.providerWithTokens(ApiService, [LoggerService, ConfigToken]);
```

**Token Utilities:**

| Function               | Purpose                        |
| ---------------------- | ------------------------------ |
| `createToken<T>(name)` | Create a typed injection token |
| `isToken(value)`       | Check if a value is a token    |

### Strong Typing with Named Providers

A powerful feature of OriJS DI: **constructor parameter types are independent of the DI system**. The container just injects whatever instance is registered - TypeScript handles the types at compile time.

This means you can type to a **specific implementation**, not just an interface:

```typescript
// A provider with methods beyond the generic interface
export class RedisKVProvider implements CacheProvider {
	// CacheProvider interface methods
	get<T>(key: string): Promise<T | null> {
		/* ... */
	}
	set<T>(key: string, value: T, ttl: number): Promise<void> {
		/* ... */
	}
	del(key: string): Promise<number> {
		/* ... */
	}

	// Implementation-specific methods (not on CacheProvider)
	incr(key: string): Promise<number> {
		/* ... */
	}
	scan(pattern: string): Promise<string[]> {
		/* ... */
	}
	setNX(key: string, value: unknown, ttl: number): Promise<boolean> {
		/* ... */
	}
}

// Register with a token
const KVCache = createToken<RedisKVProvider>('KVCache');
const kvProvider = new RedisKVProvider(redis);

Ori.create().providerInstance(KVCache, kvProvider).providerWithTokens(PresenceService, [KVCache]);
```

```typescript
// Service gets full type - not limited to interface
class PresenceService {
	constructor(private kv: RedisKVProvider) {}

	async getAccountPresence(accountUuid: string) {
		// Full autocomplete for scan() - not on generic CacheProvider!
		const keys = await this.kv.scan(`presence:${accountUuid}:*`);
		return Promise.all(keys.map((k) => this.kv.get(k)));
	}

	async atomicIncrement(key: string) {
		// incr() also available
		return this.kv.incr(key);
	}
}
```

**Why this matters:**

- Full IDE autocomplete for implementation-specific methods
- TypeScript catches type errors at compile time
- No runtime overhead - DI just wires instances
- Flexibility to use interfaces OR concrete types as needed

**When to use each approach:**

| Approach                          | Use When                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| Interface type (`CacheProvider`)  | Multiple implementations possible, only need common methods |
| Concrete type (`RedisKVProvider`) | Single implementation, need implementation-specific methods |

This is similar to NestJS but without decorators or reflection magic - just plain TypeScript.

### Lazy vs Eager Providers

By default, services are instantiated lazily (on first use):

```typescript
// Lazy (default) - created when first resolved
.provider(UserService, [DatabaseService])

// Eager - created at startup
.provider(QueueListener, [Redis], { eager: true })
```

Use eager loading for services that need to start background tasks at application startup:

```typescript
class MetricsCollector {
  constructor(private ctx: AppContext) {
    // Start collecting immediately (eager)
    this.startCollecting();

    // Clean up on shutdown
    ctx.onShutdown(() => this.stop());
  }

  private interval: Timer | null = null;

  private startCollecting() {
    this.interval = setInterval(() => this.collect(), 10000);
  }

  public stop() {
    if (this.interval) clearInterval(this.interval);
  }
}

// Eager registration ensures collector starts immediately
.provider(MetricsCollector, [AppContext], { eager: true })
```

### Constructor Dependencies

Write constructors normally - dependencies come in order:

```typescript
class OrderService {
  constructor(
    private userService: UserService,
    private productService: ProductService,
    private logService: LogService
  ) {}
}

// Registration matches constructor order
.provider(OrderService, [UserService, ProductService, LogService])
```

### Async Service Resolution

Some services may have async initialization. OriJS supports this via `resolveAsync()`:

```typescript
// Pattern 1: Use startup hooks (RECOMMENDED)
class DatabaseService {
	private pool!: Pool;

	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			this.pool = await createPool(config);
			ctx.log.info('Database pool connected');
		});
	}
}

// Pattern 2: Pre-create and register instance
const pool = await createPool(config);
Ori.create().providerInstance(Pool, pool).provider(DatabaseService, [Pool]);
```

**Important**: Constructors should be synchronous. Move async work to lifecycle hooks.

### External Package Dependencies

When a service depends on npm packages that might not be installed (peer dependencies), use `registerWithExternal()`:

```typescript
// Container validates that 'ioredis' is installed at startup
container.registerWithExternal(CacheService, [ConfigService], ['ioredis']);

// Validation happens during .listen() or explicit .validate() call
container.validate(); // Throws if 'ioredis' not installed
```

This helps catch missing peer dependencies early rather than at runtime.

---

## AppContext

`AppContext` is the application-level context that services inject to access shared resources.

### What AppContext Provides

| Property/Method      | Purpose                             |
| -------------------- | ----------------------------------- |
| `ctx.log`            | Logger instance                     |
| `ctx.config`         | Configuration provider              |
| `ctx.event`          | Event system (if configured)        |
| `ctx.workflows`      | Workflow executor (if configured)   |
| `ctx.hasWorkflows`   | Check if workflows configured       |
| `ctx.phase`          | Current lifecycle phase             |
| `ctx.resolve()`      | Resolve services manually           |
| `ctx.resolveAsync()` | Resolve services with async support |
| `ctx.onStartup()`    | Register startup hook               |
| `ctx.onReady()`      | Register ready hook                 |
| `ctx.onShutdown()`   | Register shutdown hook              |

### Using AppContext in Services

```typescript
import { AppContext } from '@orijs/core';

class UserService {
	constructor(
		private ctx: AppContext,
		private db: DatabaseService
	) {
		// Register lifecycle hooks in constructor
		ctx.onStartup(async () => {
			ctx.log.info('UserService initializing');
		});

		ctx.onShutdown(async () => {
			ctx.log.info('UserService shutting down');
		});
	}

	async createUser(data: CreateUserDto) {
		const user = await this.db.insertUser(data);

		// Access event system
		this.ctx.event?.emit('user.created', { userId: user.id });

		// Access workflows
		if (this.ctx.hasWorkflows) {
			await this.ctx.workflows.start('WelcomeWorkflow', { userId: user.id });
		}

		return user;
	}

	async getConfig() {
		// Access configuration
		return await this.ctx.config.get('FEATURE_FLAG');
	}
}
```

### Registration with AppContext

`AppContext` is automatically available - just add it to your dependency list:

```typescript
.provider(UserService, [AppContext, DatabaseService])
```

### Security: Config Protection

AppContext protects configuration from accidental serialization:

```typescript
// Config values are NOT included in JSON serialization
JSON.stringify(ctx); // { "phase": "ready" } - no config!

// Config is non-enumerable
Object.keys(ctx); // Does not include 'config'

// Custom inspect redacts config
console.log(ctx); // AppContext { phase: 'ready', config: [REDACTED] }
```

This prevents accidental config leakage in logs or API responses.

---

## Lifecycle

OriJS applications go through defined lifecycle phases:

```
created → bootstrapped → starting → ready → stopping → stopped
```

### Lifecycle Phases

| Phase          | Description                                    |
| -------------- | ---------------------------------------------- |
| `created`      | Application instance created                   |
| `bootstrapped` | DI container configured, services registered   |
| `starting`     | Startup hooks executing, event system starting |
| `ready`        | Server listening, ready hooks executed         |
| `stopping`     | Shutdown initiated, shutdown hooks executing   |
| `stopped`      | Server stopped, all resources released         |

### Lifecycle Hooks

Register hooks via `AppContext`:

```typescript
class DatabaseService {
	constructor(private ctx: AppContext) {
		// onStartup: Before server starts listening
		// Use for: migrations, subscriptions, cache warming
		ctx.onStartup(async () => {
			await this.runMigrations();
			ctx.log.info('Migrations complete');
		});

		// onReady: After server starts listening
		// Use for: background jobs, health checks, "ready" signals
		ctx.onReady(async () => {
			await this.warmCache();
			ctx.log.info('Database ready');
		});

		// onShutdown: On graceful shutdown (SIGTERM/SIGINT)
		// Use for: closing connections, flushing buffers
		// Note: Executes in LIFO order (last registered runs first)
		ctx.onShutdown(async () => {
			await this.connection.close();
			ctx.log.info('Database connection closed');
		});
	}
}
```

### Hook Execution Order

**Startup and Ready Hooks**: Execute in FIFO order (first registered runs first)

```typescript
ctx.onStartup(() => console.log('First')); // Runs 1st
ctx.onStartup(() => console.log('Second')); // Runs 2nd
ctx.onStartup(() => console.log('Third')); // Runs 3rd
```

**Shutdown Hooks**: Execute in LIFO order (last registered runs first)

```typescript
ctx.onShutdown(() => console.log('First')); // Runs 3rd
ctx.onShutdown(() => console.log('Second')); // Runs 2nd
ctx.onShutdown(() => console.log('Third')); // Runs 1st
```

This LIFO order ensures resources are cleaned up in the reverse order they were created.

### Error Handling in Hooks

**Startup/Ready hooks**: Errors fail fast (stop execution)

```typescript
ctx.onStartup(async () => {
	throw new Error('Migration failed'); // Stops application startup
});
```

**Shutdown hooks**: Errors are logged but don't stop other hooks

```typescript
ctx.onShutdown(async () => {
	throw new Error('Connection close failed');
	// Error logged, but other shutdown hooks still run
});
```

### Startup Sequence

When you call `.listen()`:

1. **Bootstrap** - Register all providers, validate DI graph
2. **Start Event System** - If configured
3. **Start Workflow System** - If configured
4. **Run Startup Hooks** - In registration order
5. **Start HTTP Server** - Begin accepting requests
6. **Run Ready Hooks** - In registration order

### Shutdown Sequence

When the application stops (SIGTERM, SIGINT, or manual `.stop()`):

1. **Run Shutdown Hooks** - In LIFO order
2. **Stop Event System** - If configured
3. **Stop Workflow System** - If configured
4. **Stop HTTP Server** - Stop accepting requests

### Graceful Shutdown Timeout

Configure a timeout for graceful shutdown:

```typescript
Ori.create()
	.setShutdownTimeout(30000) // 30 seconds (default: 10s)
	.listen(3000);
```

If shutdown hooks take longer than the timeout, the server force-stops.

### Disabling Signal Handling

For tests, disable automatic signal handling:

```typescript
const app = Ori.create()
  .disableSignalHandling()  // Don't handle SIGTERM/SIGINT
  .provider(...)
  .listen(3000);

// Manual stop
await app.stop();
```

---

## Extension Functions

Organize related providers into reusable extension functions:

```typescript
// providers/database.ts
import { Application } from '@orijs/core';
import type { SQL } from 'postgres';

export function addDatabase(app: Application, sql: SQL): Application {
	return app
		.providerInstance('SQL', sql)
		.provider(UserMapper)
		.provider(ProjectMapper)
		.provider(DbUserService, ['SQL', UserMapper])
		.provider(DbProjectService, ['SQL', ProjectMapper]);
}

// providers/events.ts
export function addEvents(app: Application): Application {
	return app
		.events(EventRegistry)
		.provider(EmailService)
		.eventHandler(UserEventHandler, [EmailService])
		.eventHandler(ProjectEventHandler, [ProjectService]);
}

// providers/repositories.ts
export function addRepositories(app: Application): Application {
	return app
		.provider(UserRepository, [DbUserService, CacheService])
		.provider(ProjectRepository, [DbProjectService, CacheService]);
}

// app.ts
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

Ori.create()
	.use((app) => addDatabase(app, sql))
	.use(addEvents)
	.use(addRepositories)
	.use(addControllers)
	.listen(3000);
```

### Benefits of Extension Functions

- **Modular, testable code organization** - Group related providers
- **Reusable across applications** - Share common setups
- **Clear dependency groupings** - Easy to understand what each module provides
- **Easier to test individual modules** - Isolate for testing
- **Parameterized** - Pass configuration to extensions

### Extension Function Patterns

**Pattern 1: Simple grouping**

```typescript
function addUserModule(app: Application): Application {
	return app
		.provider(UserService, [DatabaseService])
		.provider(UserMapper)
		.controller('/users', UserController, [UserService]);
}
```

**Pattern 2: Parameterized**

```typescript
function addCache(app: Application, options: CacheOptions): Application {
  const provider = options.redis
    ? new RedisCacheProvider(options.redis)
    : new InMemoryCacheProvider();

  return app.cache(provider);
}

// Usage
.use(app => addCache(app, { redis: redisClient }))
```

**Pattern 3: Conditional**

```typescript
function addMonitoring(app: Application, enabled: boolean): Application {
  if (!enabled) return app;

  return app
    .provider(MetricsService)
    .intercept(MetricsInterceptor);
}

// Usage
.use(app => addMonitoring(app, process.env.ENABLE_METRICS === 'true'))
```

---

## Container Validation

The container validates the dependency graph at startup:

```typescript
// This will throw during .listen() if UserService isn't registered
Ori.create()
	.controller('/api', UserController, [UserService]) // UserService not registered!
	.listen(3000);
```

**Error message:**

```
Service UserService is not registered.

Fix: Register the service as a provider:
  .provider(UserService, [/* dependencies */])

Or if it's pre-instantiated:
  .providerInstance(UserService, instance)
```

### What Validation Catches

1. **Missing service registrations**

   ```
   Service UserService is not registered.
   ```

2. **Constructor parameter count mismatches**

   ```
   Service UserService has 2 constructor parameters but 1 dependencies declared
   ```

3. **Circular dependencies**

   ```
   Circular dependency detected: ServiceA -> ServiceB -> ServiceA
   ```

4. **Missing external npm packages**
   ```
   Missing npm package 'ioredis' required by CacheService
   ```

### Manual Validation

Force early validation:

```typescript
const app = Ori.create().provider(UserService).controller('/api', UserController, [UserService]);

app.getContainer().validate(); // Throws if invalid
```

### Resolving Circular Dependencies

If you encounter a circular dependency, refactor to break the cycle:

**Option 1: Extract shared logic**

```typescript
// BEFORE (circular)
class ServiceA {
	constructor(private b: ServiceB) {}
	methodA() {
		this.b.methodB();
	}
}
class ServiceB {
	constructor(private a: ServiceA) {}
	methodB() {
		this.a.methodA();
	}
}

// AFTER (no cycle)
class SharedService {
	// Shared logic here
}
class ServiceA {
	constructor(private shared: SharedService) {}
}
class ServiceB {
	constructor(private shared: SharedService) {}
}
```

**Option 2: Use events**

```typescript
// Instead of direct dependency
class OrderService {
	constructor(private ctx: AppContext) {}

	async complete(orderId: string) {
		// Emit event instead of calling InventoryService directly
		this.ctx.event?.emit('order.completed', { orderId });
	}
}

class InventoryService {
	constructor(private ctx: AppContext) {}

	configure(e: EventBuilder) {
		e.on('order.completed', this.handleOrderCompleted);
	}
}
```

---

## Debugging

### Inspect Registered Services

```typescript
const app = Ori.create().provider(UserService).provider(OrderService, [UserService]);

const container = app.getContainer();
console.log(container.getRegisteredNames());
// ['UserService', 'OrderService']

console.log(container.getRegisteredCount());
// 2
```

### Inspect Routes

```typescript
const app = Ori.create()
	.controller('/api/users', UserController, [UserService])
	.controller('/api/orders', OrderController, [OrderService]);

console.log(app.getRoutes());
// [{ method: 'GET', path: '/api/users/list', ... }, ...]
```

### Resolution Timeout Warning

The container warns if service resolution takes over 5 seconds:

```
[WARN] Slow service resolution for UserService (5123ms)
```

This helps identify blocking operations in constructors.

Configure the threshold:

```typescript
const container = new Container();
container.setResolutionTimeout(10000); // 10 seconds
```

### Lifecycle Hook Counts

```typescript
const ctx = app.context;
console.log(ctx.getHookCounts());
// { startup: 3, ready: 2, shutdown: 5 }
```

---

## Best Practices

### 1. Keep Constructors Synchronous

Move async initialization to startup hooks:

```typescript
// BAD - async work in constructor
class CacheService {
	constructor(private ctx: AppContext) {
		await this.warmCache(); // Won't work!
	}
}

// GOOD - use startup hook
class CacheService {
	constructor(private ctx: AppContext) {
		ctx.onStartup(async () => {
			await this.warmCache();
		});
	}
}
```

### 2. Use AppContext for Cross-Cutting Concerns

```typescript
class OrderService {
	constructor(private ctx: AppContext) {}

	async create(data: CreateOrderDto) {
		// Use ctx for events, workflows, config, logging
		this.ctx.log.info('Creating order', { data });
		this.ctx.event?.emit('order.created', { orderId: order.id });
	}
}
```

### 3. Order Dependencies Logically

```typescript
// Register in dependency order for readability
Ori.create()
	// Infrastructure first
	.providerInstance('SQL', sql)
	.provider(CacheService)

	// Then mappers
	.provider(UserMapper)

	// Then services (with their deps)
	.provider(UserService, ['SQL', UserMapper, CacheService])

	// Then controllers
	.controller('/api/users', UserController, [UserService]);
```

### 4. Use Extension Functions for Modularity

Group related providers into reusable functions (see Extension Functions section above).

### 5. Register Shutdown Hooks for Resources

```typescript
class ConnectionPool {
	constructor(private ctx: AppContext) {
		ctx.onShutdown(async () => {
			await this.pool.end();
			ctx.log.info('Connection pool closed');
		});
	}
}
```

### 6. Validate Early in Development

```typescript
// Add explicit validation during development
const app = Ori.create().provider(UserService);

if (process.env.NODE_ENV === 'development') {
	app.getContainer().validate();
}
```

---

## Next Steps

- [HTTP & Routing](./http-routing.md) - Create controllers with guards and interceptors
- [Validation](./validation.md) - TypeBox schema validation
- [Events](./events.md) - Decouple services with pub/sub
- [Configuration](./configuration.md) - Environment-based configuration
