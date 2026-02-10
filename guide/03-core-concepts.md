# Chapter 3: Core Concepts

This chapter covers the foundational concepts of OriJS: the application lifecycle, dependency injection, and the `AppContext` that provides application-level services to your code.

## The Application

Every OriJS application starts with `Ori.create()`:

```typescript
const app = Ori.create();
```

This creates an `OriApplication` instance that serves as the central configuration point. The application is configured through a **fluent builder API** — each method returns `this`, so you can chain calls:

```typescript
Ori.create()
  .logger({ level: 'info', transport: 'pretty' })
  .provider(UserService, [UserRepository])
  .controller(UserController, [UserService])
  .globalGuard(AuthGuard, [AuthService])
  .listen(3000);
```

The order of most registration calls doesn't matter — providers, controllers, guards, and interceptors are all collected during configuration and resolved during the `listen()` bootstrap phase. The exception is `.use()` for extension functions, which executes immediately in order (so earlier extensions can set up providers that later extensions depend on).

### What Happens When You Call `.listen()`

The `listen()` method triggers a multi-phase startup:

1. **Bootstrap**: The DI container resolves all providers and validates the dependency graph. Missing dependencies, circular references, and type mismatches are caught here.

2. **Register**: Controllers are registered with the routing system. Guards, interceptors, and validators are attached to their routes.

3. **Compile**: Routes are compiled into Bun's native `Bun.serve({ routes })` format. This pre-computes route matching for optimal performance.

4. **Startup Hooks**: Any registered `onStartup` hooks run (e.g., database connection, cache warming).

5. **Server Start**: `Bun.serve()` is called and the server begins accepting requests.

6. **Ready Hooks**: Any registered `onReady` hooks run (e.g., health check registration, metric reporting).

```typescript
app.context.onStartup(async () => {
  await database.connect();
  console.log('Database connected');
});

app.context.onReady(async () => {
  console.log('Server is ready to accept requests');
});
```

## Dependency Injection

Dependency injection (DI) is the backbone of OriJS application architecture. Instead of classes creating their own dependencies, they declare what they need, and the framework provides it.

### Why Dependency Injection?

Consider this code without DI:

```typescript
// Without DI — tight coupling
class UserController {
  private service = new UserService(
    new UserRepository(new DatabaseConnection('postgres://...'))
  );
}
```

Problems:
- `UserController` knows how to construct `UserService`, `UserRepository`, and `DatabaseConnection`
- Testing requires either complex mocking or a real database
- Changing the database connection string means finding every place it's used

With DI:

```typescript
// With DI — loose coupling
class UserController {
  constructor(private service: UserService) {}
}

// Registration — dependencies declared once
app.provider(UserService, [UserRepository])
   .provider(UserRepository, [DatabaseConnection])
   .controller(UserController, [UserService]);
```

Now each class only knows about its direct dependencies. The DI container handles construction, ordering, and lifetime management.

### Registering Providers

A **provider** is any class that can be injected into other classes. Register providers with `.provider()`:

```typescript
// No dependencies
app.provider(Logger);

// With dependencies (must match constructor parameter order)
app.provider(UserRepository, [Logger, DatabaseService]);

// The above means: new UserRepository(logger, databaseService)
```

The deps array is an ordered list of constructor types. OriJS uses the concrete class as the DI token — when `UserService` declares a dependency on `UserRepository`, the container looks for a registered provider keyed by `UserRepository`.

**This is the key insight of OriJS's DI system**: the dependency array replaces the work that NestJS's `reflect-metadata` does at runtime. Instead of reading TypeScript type metadata (which requires `emitDecoratorMetadata` and the `reflect-metadata` polyfill), you explicitly list dependencies. The trade-off is a small amount of duplication (the deps array mirrors the constructor), but the benefits are significant:

- **Zero runtime overhead**: No metadata reflection
- **TypeScript catches mismatches**: If you change the constructor, the deps array type-check will fail
- **Works with any constructor**: No `@Injectable()` decorator needed

### Singleton Scope

All providers in OriJS are **singletons**. When you register `UserService`, exactly one instance is created and shared across the entire application:

```typescript
app.provider(UserService, [UserRepository]);
// Every class that depends on UserService gets the same instance
```

**Why singletons only?**

NestJS supports three scopes: singleton, request-scoped, and transient. OriJS deliberately supports only singletons:

1. **Performance**: Request-scoped providers require creating a new instance for every HTTP request, which adds garbage collection pressure and construction overhead.

2. **Simplicity**: Scope management is one of the most confusing aspects of NestJS DI. "Scope bubbling" (where a singleton depending on a request-scoped provider must also become request-scoped) causes subtle bugs.

3. **Request context solves the same problem**: If you need per-request data (like the current user), use the `RequestContext` that's passed to every handler, guard, and interceptor — not request-scoped DI.

```typescript
// NestJS way — request-scoped injection
@Injectable({ scope: Scope.REQUEST })
class RequestLogger {
  constructor(@Inject(REQUEST) private request: Request) {}
}

// OriJS way — use RequestContext
private handleRequest = async (ctx: RequestContext) => {
  ctx.log.info('Processing request', { userId: ctx.state.user.id });
};
```

### Injection Tokens

Sometimes you need to inject a value that isn't a class — a configuration object, a database connection, or a primitive value. Use **injection tokens**:

```typescript
import { createToken } from '@orijs/core';

// Create a typed token
const DATABASE_URL = createToken<string>('DATABASE_URL');
const DB_POOL = createToken<Pool>('DB_POOL');

// Register with token
app.providerWithToken(DATABASE_URL, {
  useFactory: () => process.env.DATABASE_URL ?? 'postgres://localhost:5432/mydb',
});

app.providerWithToken(DB_POOL, {
  useFactory: (url: string) => new Pool({ connectionString: url }),
  deps: [DATABASE_URL],
});

// Inject in a class using tokensFor
class UserRepository {
  constructor(private pool: Pool) {}
}

app.provider(UserRepository, [DB_POOL]);
```

Tokens give you a named, typed handle for non-class dependencies. The `createToken<T>()` function creates a token that carries its type information, so the container enforces type safety at registration and resolution time.

### Lazy vs Eager Providers

By default, providers are **lazy** — they're only instantiated when first requested by a dependent class. You can make a provider **eager** so it's instantiated during bootstrap:

```typescript
// Lazy (default) — created when first needed
app.provider(UserService, [UserRepository]);

// Eager — created at bootstrap
app.provider(CacheWarmer, [CacheService], { eager: true });
```

Use eager providers for services that need to do work at startup, like warming a cache, establishing a connection pool, or registering event listeners.

### Container Validation

During the bootstrap phase, the DI container validates the entire dependency graph:

```
Error: Missing provider: DatabaseService
  Required by: UserRepository
  Dependency chain: UserController -> UserService -> UserRepository -> DatabaseService
```

This catches:
- **Missing providers**: A class depends on something that wasn't registered
- **Circular dependencies**: A -> B -> C -> A
- **Duplicate registrations**: The same class registered twice (the second registration wins, with a warning)

Container validation happens before any provider is instantiated, so you get fast, clear error messages at startup — not cryptic runtime errors when a service is first used.

## AppContext

The `AppContext` is the application-level context object available to all services. It provides access to shared infrastructure:

```typescript
class NotificationService {
  constructor(private ctx: AppContext) {}

  public async notifyUser(userId: string, message: string) {
    this.ctx.log.info('Sending notification', { userId });

    await this.ctx.events.emit(UserNotified, {
      userId,
      message,
      timestamp: new Date(),
    });
  }
}

// Register — AppContext is automatically available
app.provider(NotificationService, [AppContext]);
```

### What's on AppContext?

| Property | Type | Description |
|----------|------|-------------|
| `log` | `Logger` | Application-level structured logger |
| `events` | `EventEmitter` | Type-safe event emitter (if events configured) |
| `workflows` | `WorkflowExecutor` | Workflow executor (if workflows configured) |
| `config` | `ConfigProvider` | Configuration values |
| `sockets` | `SocketEmitter` | WebSocket publisher (if WebSocket configured) |

`AppContext` is registered as a provider automatically — you just list it as a dependency. It's the recommended way to access cross-cutting infrastructure without tight coupling to specific implementations.

### Lifecycle Hooks

Register hooks to run code at specific points in the application lifecycle:

```typescript
// Startup hooks — run FIFO (first registered, first executed)
app.context.onStartup(async () => {
  await database.connect();
});

app.context.onStartup(async () => {
  await cache.warm();
});

// Ready hooks — run FIFO after server starts
app.context.onReady(async () => {
  healthCheck.register();
});

// Shutdown hooks — run LIFO (last registered, first executed)
app.context.onShutdown(async () => {
  await cache.flush();
});

app.context.onShutdown(async () => {
  await database.disconnect();
});
```

The lifecycle phases are:

```
created → bootstrapped → starting → ready → stopping → stopped
```

- **Startup hooks** run during `starting` (before the server accepts requests)
- **Ready hooks** run after the server is listening (during `ready`)
- **Shutdown hooks** run during `stopping` (in reverse order, so cleanup happens in the opposite order of setup)

**Why LIFO for shutdown?** If your startup sequence is: (1) connect database, (2) warm cache, then shutdown should be: (1) flush cache, (2) disconnect database. LIFO order ensures resources are cleaned up in the reverse order they were acquired, which prevents errors like trying to flush a cache after the database it reads from has been disconnected.

### Graceful Shutdown

OriJS handles `SIGINT` and `SIGTERM` signals automatically:

```typescript
const app = Ori.create()
  .setShutdownTimeout(15000)  // 15 second timeout (default: 10s)
  .listen(3000);
```

When a signal is received:
1. The server stops accepting new connections
2. Shutdown hooks execute in LIFO order
3. WebSocket connections receive a close frame (`1001 Going Away`)
4. Event consumers and workflow workers drain
5. If hooks don't complete within the timeout, the process exits forcefully

For tests, disable signal handling to prevent interference with the test runner:

```typescript
const app = Ori.create()
  .disableSignalHandling()
  .listen(0);  // Port 0 = random available port
```

## Extension Functions

Extension functions are the OriJS replacement for NestJS modules. They're plain functions that configure an application:

```typescript
import type { OriApplication } from '@orijs/orijs';

export function useMonitoring(app: OriApplication) {
  app
    .provider(MetricsCollector, [AppContext])
    .provider(HealthChecker, [MetricsCollector])
    .controller(HealthController, [HealthChecker]);

  // Can also register lifecycle hooks
  app.context.onStartup(async () => {
    const metrics = app.getContainer().resolve(MetricsCollector);
    await metrics.start();
  });
}
```

### Composing Extensions

Extensions can depend on each other. Since they operate on the same container, an extension can use providers registered by earlier extensions:

```typescript
// Database extension — registers the connection
export function useDatabase(app: OriApplication) {
  app.provider(DatabaseService);

  app.context.onStartup(async () => {
    const db = app.getContainer().resolve(DatabaseService);
    await db.connect();
  });
}

// User extension — depends on database
export function useUsers(app: OriApplication) {
  app
    .provider(UserRepository, [DatabaseService])  // Uses DatabaseService from above
    .provider(UserService, [UserRepository])
    .controller(UserController, [UserService]);
}

// Application — compose in dependency order
Ori.create()
  .use(useDatabase)  // First: sets up database
  .use(useUsers)     // Second: uses database
  .listen(3000);
```

### Conditional Extensions

Because extensions are functions, conditional composition is natural:

```typescript
const app = Ori.create()
  .use(useDatabase)
  .use(useAuth)
  .use(useUsers);

if (process.env.NODE_ENV === 'development') {
  app.use(useDevTools);
  app.use(useSwaggerDocs);
}

if (process.env.ENABLE_ADMIN === 'true') {
  app.use(useAdmin);
}

app.listen(3000);
```

### Deferred Extensions

Some extensions need access to configuration that isn't available until later. Use `.useDeferred()` for extensions that should run after `.config()` is processed:

```typescript
export function useCaching(app: OriApplication) {
  const config = app.context.config.get<CacheConfig>('cache');

  if (config.provider === 'redis') {
    app.provider(RedisCacheService, [RedisClient]);
  } else {
    app.provider(InMemoryCacheService);
  }
}

Ori.create()
  .config(configProvider)       // Config set here
  .useDeferred(useCaching)      // Runs after config is ready
  .listen(3000);
```

## Summary

The core concepts of OriJS are:

1. **Fluent builder API**: Configure everything through chained method calls on the application instance
2. **Explicit DI**: Dependencies listed as arrays, no decorators or metadata reflection
3. **Singleton scope**: One instance per provider, use `RequestContext` for per-request data
4. **AppContext**: Application-level context for cross-cutting concerns (logging, events, config)
5. **Lifecycle hooks**: Startup (FIFO), ready (FIFO), shutdown (LIFO) with graceful shutdown
6. **Extension functions**: Composable, testable, conditional application configuration

These concepts form the foundation for everything else in OriJS. The next chapter builds on them to show how controllers and routing work.

[Previous: Quick Start ←](./02-quick-start.md) | [Next: Controllers & Routing →](./04-controllers-and-routing.md)
