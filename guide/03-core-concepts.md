# Chapter 3: Core Concepts

This chapter covers the foundational concepts that everything else in OriJS builds on: the application lifecycle, dependency injection, AppContext, extension functions, and lifecycle hooks. Understanding these concepts deeply will make every subsequent chapter easier to follow.

## The Application Lifecycle

When you call `Ori.create()`, several things happen in sequence. Understanding this sequence helps you reason about when your code runs and why certain things are available at certain times.

### Phase 1: Creation

```typescript
const app = Ori.create();
```

This creates:
- A **DI Container** — the dependency injection container that manages all your services
- An **AppContext** — the application-wide context that provides logging, config, events, and other cross-cutting concerns
- Coordinator factories for routing, events, workflows, and WebSockets

At this point, nothing is instantiated. The container is empty, and no services exist yet.

### Phase 2: Configuration

```typescript
app
  .use(addInfrastructure)
  .use(addUsers)
  .use(addPosts)
  .guard(AuthGuard)
  .intercept(LoggingInterceptor);
```

During configuration, you register providers, controllers, guards, interceptors, and extension functions. Each `.provider()` call adds a registration to the container. Each `.controller()` call adds both a registration and a route definition.

**Nothing is instantiated during this phase.** The container only records *how* to create each service — what class, what dependencies, what options. Actual instantiation happens lazily or during bootstrap.

This is different from NestJS, where module initialization can trigger provider instantiation during the configuration phase. OriJS's lazy approach means configuration is fast — you're just building a recipe, not cooking the meal.

### Phase 3: Bootstrap (inside `listen()`)

```typescript
app.listen(3000);
```

When you call `listen()`, the framework bootstraps the application:

1. **Container validation** — Checks that all registered dependencies exist and there are no circular dependencies. If something is missing, you get a clear error message listing exactly which dependency is unresolved and which service needs it.

2. **Eager provider instantiation** — Services registered with `{ eager: true }` are instantiated immediately. This is useful for services that need to initialize connections (like database pools) before the server accepts requests.

3. **Controller instantiation** — All controllers are instantiated, and their `configure()` methods are called. This builds the route table.

4. **Route compilation** — Routes are compiled into Bun's optimized `Bun.serve({ routes })` format. Bun uses a radix tree internally, so route matching is O(log n) regardless of how many routes you have.

5. **Event/Workflow provider startup** — If you've configured events or workflows, their providers are started (connecting to Redis/BullMQ, registering consumers).

6. **Startup hooks** — All `onStartup` hooks execute in FIFO order. These run before the server accepts connections.

7. **Server start** — Bun's HTTP server starts listening on the specified port.

8. **Ready hooks** — All `onReady` hooks execute in FIFO order. These run after the server is accepting connections.

### Phase 4: Running

The application is now serving requests. Each request flows through:

```
Request → CORS → Global Guards → Controller Guards → Route Guards
        → Global Interceptors (pre) → Controller Interceptors (pre) → Route Interceptors (pre)
        → Validation (params, query, body)
        → Handler
        → Route Interceptors (post) → Controller Interceptors (post) → Global Interceptors (post)
        → Response
```

### Phase 5: Shutdown

When the process receives SIGTERM or SIGINT (or you call `app.stop()`):

1. **Server stops accepting new connections**
2. **Shutdown hooks execute** in LIFO (last-in, first-out) order — this ensures that dependencies are cleaned up before the services that depend on them
3. **Event/Workflow providers stop** — gracefully draining queues and closing connections
4. **WebSocket connections close**
5. **Process exits**

The shutdown timeout (default: 10 seconds) ensures the process doesn't hang indefinitely. Configure it with `app.setShutdownTimeout(30_000)` for applications that need more time to drain.

## Dependency Injection

Dependency injection is how OriJS manages the creation and wiring of your services. If you've used NestJS, Spring, or .NET Core, the concept is familiar — but the implementation is deliberately different.

### The Problem DI Solves

Without DI, services create their own dependencies:

```typescript
// Without DI — tight coupling
class UserService {
  private repo = new UserRepository(new DatabaseConnection('postgres://...'));
  private cache = new RedisCache('redis://...');

  async getUser(id: string) {
    // How do you test this? You can't swap the real DB for a fake one.
    // How do you share the DB connection? Each service creates its own.
  }
}
```

With DI, services *receive* their dependencies:

```typescript
// With DI — loose coupling
class UserService {
  constructor(
    private repo: UserRepository,
    private cache: CacheProvider,
  ) {}

  async getUser(id: string) {
    // In tests, inject a FakeUserRepository and InMemoryCacheProvider.
    // In production, inject the real ones. UserService doesn't know or care.
  }
}
```

### How OriJS DI Works

OriJS uses explicit registration — you tell the container what each service needs:

```typescript
app
  .provider(DatabaseConnection)                           // No deps
  .provider(UserRepository, [DatabaseConnection])         // One dep
  .provider(UserService, [UserRepository, CacheProvider]) // Two deps
```

When the container needs to create a `UserService`, it:

1. Looks up `UserRepository` — if it already exists (singleton), use it; otherwise, create it first
2. Looks up `CacheProvider` — same logic
3. Calls `new UserService(userRepository, cacheProvider)`
4. Caches the instance (all providers are singletons)

### Why Explicit Registration?

NestJS uses TypeScript's `reflect-metadata` to automatically read constructor parameter types at runtime:

```typescript
// NestJS — implicit DI
@Injectable()
export class UserService {
  constructor(private repo: UserRepository) {} // NestJS reads "UserRepository" from metadata
}
```

This looks cleaner, but has significant downsides:

**1. Metadata requires `emitDecoratorMetadata`.**
This TypeScript compiler option generates extra code for every decorated class. In a large application with hundreds of services, this adds measurable startup overhead (5-15% in benchmarks) and increases bundle size.

**2. Metadata only works with concrete classes.**
If your constructor takes an interface or abstract class, NestJS can't resolve it from metadata alone — you need `@Inject()` tokens anyway. OriJS's explicit approach works the same for concrete classes and abstract types.

**3. Refactoring can silently break DI.**
Change a constructor parameter type, and NestJS might resolve the wrong service if metadata isn't regenerated. With OriJS, the deps array is type-checked — a mismatch is a compile error.

**4. Tree-shaking.**
Decorator metadata creates runtime references that bundlers can't safely remove. Without metadata, dead code elimination works correctly.

The trade-off is a small amount of duplication: you list dependencies in both the constructor and the registration. But this duplication is *checked by the compiler*:

```typescript
class UserService {
  constructor(
    private repo: UserRepository,
    private cache: CacheProvider,
  ) {}
}

// Type error! Constructor expects [UserRepository, CacheProvider]
// but you provided [UserRepository]
app.provider(UserService, [UserRepository]);
```

### Singleton Scope

All providers in OriJS are singletons. When the container creates a `UserRepository`, that same instance is shared everywhere it's injected.

**Why singleton-only?** NestJS supports request-scoped providers — a new instance per HTTP request. This sounds useful but creates serious problems:

- **Performance.** Creating new instances per request means allocating memory, running constructors, and setting up state — for every single request. For high-throughput APIs, this is a measurable cost.
- **Complexity.** Request-scoped providers "bubble up" — if a request-scoped provider is injected into a singleton, the singleton also becomes request-scoped, or you get stale data. This is a common source of bugs in NestJS applications.
- **Testing difficulty.** Request-scoped providers make unit testing harder because you need to simulate the request scope.

OriJS uses `RequestContext` instead. Per-request state lives in the context object that flows through guards, interceptors, and handlers:

```typescript
class AuthGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = await this.authService.verify(ctx.request);
    ctx.set('user', user); // Per-request state
    return true;
  }
}

// Later in a handler:
const user = ctx.get('user'); // Access per-request state
```

This is simpler, faster, and more explicit. You always know where per-request state comes from — it's on the context, not hidden in a scoped injection.

### Provider Tokens

Sometimes you need to inject an interface or a value that isn't a class. OriJS supports several token types:

**Class tokens** (most common):

```typescript
app.provider(UserRepository);
app.provider(UserService, [UserRepository]);
```

**Instance tokens** (pre-created values):

```typescript
import { SQL } from 'bun:sql';

const sql = new SQL({ url: Bun.env.DATABASE_URL });
app.providerInstance(SQL, sql);
```

**Named tokens** (for interfaces or multiple implementations):

```typescript
import { Token } from '@orijs/core';

const CacheToken = new Token<CacheProvider>('cache');
app.providerInstance(CacheToken, new RedisCacheProvider(redisUrl));
app.providerWithTokens(UserService, [UserRepository, CacheToken]);
```

### Eager vs Lazy Instantiation

By default, providers are created lazily — only when first requested. For services that need to initialize early (like database connections), use eager instantiation:

```typescript
app.provider(DatabasePool, [], { eager: true });
```

Eager providers are instantiated during bootstrap, before the server accepts requests. This ensures that slow initialization (connecting to databases, warming caches) doesn't affect the first request.

### Container Validation

During bootstrap, the container validates the entire dependency graph:

```typescript
// This will throw during listen() with a clear error:
// "Missing dependency: UserRepository is required by UserService but not registered"
app.provider(UserService, [UserRepository]);
// Oops — forgot to register UserRepository!

app.listen(3000);
```

The validator catches:
- **Missing dependencies** — a service needs something that isn't registered
- **Circular dependencies** — A needs B needs A
- **Constructor arity mismatches** — the deps array length doesn't match the constructor
- **Missing peer dependencies** — npm packages that need to be installed

This fail-fast validation means you find wiring errors at startup, not at runtime when a request happens to need the broken service.

## AppContext

AppContext is the application-wide context that provides cross-cutting concerns to your services. Think of it as the "application bag" — it holds things that any part of your application might need.

### What's in AppContext

```typescript
class AppContext {
  readonly log: Logger;              // Application logger
  readonly config: ConfigProvider;   // Configuration
  readonly event?: EventSystem;      // Event emitter (if configured)
  readonly workflows: WorkflowExecutor; // Workflow executor (if configured)
  readonly socket: SocketEmitter;    // WebSocket emitter (if configured)
  readonly phase: LifecyclePhase;    // Current lifecycle phase
}
```

### Accessing AppContext

AppContext is available everywhere through `RequestContext`:

```typescript
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.get('/', this.list);
  }

  private list = async (ctx: RequestContext) => {
    ctx.app.log.info('Listing users');           // Application logger
    const dbUrl = ctx.app.config.get('DB_URL');  // Configuration
    ctx.app.event?.emit(UserListedEvent, {});    // Events
    // ...
  };
}
```

It's also available in lifecycle hooks:

```typescript
app.context.onStartup(async () => {
  app.context.log.info('Running migrations...');
  const db = app.context.resolve(DatabaseService);
  await db.migrate();
});
```

### Lifecycle Phase

AppContext tracks which phase the application is in:

```typescript
type LifecyclePhase =
  | 'created'       // After Ori.create()
  | 'bootstrapped'  // After container validation
  | 'starting'      // During startup hooks
  | 'ready'         // Server is accepting requests
  | 'stopping'      // During shutdown
  | 'stopped';      // After shutdown complete
```

This is useful for guards or interceptors that need to behave differently during shutdown (like rejecting new requests with 503 Service Unavailable).

## Extension Functions

Extension functions are OriJS's replacement for NestJS modules. They're the primary way to organize provider registrations into reusable, composable units.

### Basic Extension Function

```typescript
// src/providers/users.ts
import type { Application } from '@orijs/orijs';
import { UserRepository } from '../users/user.repository';
import { UserService } from '../users/user.service';
import { UserController } from '../users/user.controller';

export function addUsers(app: Application): Application {
  return app
    .provider(UserRepository)
    .provider(UserService, [UserRepository])
    .controller('/users', UserController, [UserService]);
}
```

### Parameterized Extension Functions

Extension functions can accept parameters for configuration:

```typescript
function addCors(origins: string[]) {
  return (app: Application): Application => {
    return app.cors({
      origin: origins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true,
    });
  };
}

// Usage
app.use(addCors(['https://myapp.com', 'https://admin.myapp.com']));
```

### Conditional Composition

Since extension functions are just functions, you can conditionally apply them:

```typescript
const app = Ori.create();

app.use(addUsers);
app.use(addPosts);

if (Bun.env.NODE_ENV === 'development') {
  app.use(addDevTools);    // Debug endpoints, mock data
  app.use(addSwaggerDocs); // API documentation
}

if (Bun.env.ENABLE_ADMIN === 'true') {
  app.use(addAdmin);       // Admin panel
}

app.listen(3000);
```

Try doing this with NestJS modules. You'd need `DynamicModule.forRootAsync()`, conditional `imports` arrays, and careful management of module metadata. With extension functions, it's an `if` statement.

### Composing Extension Functions

Extension functions compose naturally:

```typescript
// Each feature has its own extension function
function addUsers(app: Application) { /* ... */ }
function addPosts(app: Application) { /* ... */ }
function addComments(app: Application) { /* ... */ }
function addNotifications(app: Application) { /* ... */ }

// A higher-level extension combines related features
function addSocialFeatures(app: Application): Application {
  return app
    .use(addPosts)
    .use(addComments)
    .use(addNotifications);
}

// The app just uses the high-level extensions
Ori.create()
  .use(addUsers)
  .use(addSocialFeatures)
  .listen(3000);
```

### Extension Functions vs NestJS Modules: A Detailed Comparison

NestJS modules:

```typescript
// NestJS — lots of ceremony
@Module({
  imports: [DatabaseModule, CacheModule.register({ ttl: 300 })],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService], // Must export for other modules to use
})
export class UserModule {}

@Module({
  imports: [UserModule], // Must import to use UserService
  controllers: [PostController],
  providers: [PostService],
})
export class PostModule {}
```

OriJS extension functions:

```typescript
// OriJS — plain functions, no ceremony
function addUsers(app: Application) {
  return app
    .provider(UserRepository)
    .provider(UserService, [UserRepository])
    .controller('/users', UserController, [UserService]);
}

function addPosts(app: Application) {
  return app
    .provider(PostService, [UserService]) // Just use it — no import/export needed
    .controller('/posts', PostController, [PostService]);
}
```

Key differences:

| Aspect | NestJS Modules | OriJS Extension Functions |
|--------|---------------|--------------------------|
| Syntax | Decorator + metadata object | Plain function |
| Visibility | Explicit `imports`/`exports` | Global container — all providers available |
| Circular deps | Common problem with cross-module references | Not possible — functions can't circularly import |
| Dynamic modules | `forRoot()`, `forRootAsync()`, `register()` | Function parameters |
| Conditional | Complex `DynamicModule` logic | `if` statement |
| Testing | Requires `Test.createTestingModule()` | Create container, register providers, done |
| Type safety | Limited (metadata is loosely typed) | Full (deps array is type-checked) |

The NestJS `imports`/`exports` system exists to control visibility — which modules can see which providers. OriJS intentionally uses a flat global container. The argument for module isolation is that it prevents accidental coupling. The counter-argument is that it creates a different class of bugs — forgetting to export or import a provider is one of the most common NestJS errors, and the error messages are cryptic.

## Lifecycle Hooks

Lifecycle hooks let you run code at specific points in the application's lifecycle.

### onStartup

Runs after bootstrap, before the server accepts connections. Use this for initialization that must complete before handling requests:

```typescript
app.context.onStartup(async () => {
  // Run database migrations
  const db = app.context.resolve(DatabasePool);
  await db.migrate();

  // Warm caches
  const cache = app.context.resolve(CacheService);
  await cache.warmup();

  app.context.log.info('Startup complete');
});
```

Startup hooks execute in FIFO (first-in, first-out) order. If any hook throws, the application fails to start — this is intentional. If your database migrations fail, you don't want the server accepting requests.

### onReady

Runs after the server starts listening. Use this for actions that should happen after the server is available:

```typescript
app.context.onReady(async () => {
  app.context.log.info('Server accepting connections on port 3000');

  // Register with service discovery
  await serviceRegistry.register({
    name: 'user-api',
    port: 3000,
    health: '/health',
  });
});
```

Ready hooks also execute in FIFO order and fail fast.

### onShutdown

Runs when the application is shutting down (SIGTERM, SIGINT, or `app.stop()`). Use this for cleanup:

```typescript
app.context.onShutdown(async () => {
  app.context.log.info('Shutting down...');

  // Close database connections
  const db = app.context.resolve(DatabasePool);
  await db.close();

  // Deregister from service discovery
  await serviceRegistry.deregister('user-api');
});
```

**Shutdown hooks execute in LIFO (last-in, first-out) order.** This is critical for correct cleanup. Consider:

```typescript
app.context.onShutdown(async () => {
  await database.close(); // Registered first — runs last
});

app.context.onShutdown(async () => {
  await cache.flush();    // Registered second — runs first
});
```

The cache flush runs before the database close. If the cache needs to write through to the database during flush, the database connection is still available. LIFO order ensures that dependencies are cleaned up after the services that depend on them.

Shutdown hooks continue executing even if one throws an error (the error is logged). This ensures that a failure in one cleanup step doesn't prevent others from running.

### Lifecycle Hook Best Practices

1. **Keep hooks focused.** Each hook should do one thing. Register multiple hooks rather than one large hook.

2. **Handle timeouts.** If your shutdown hook talks to an external service that might be unavailable, set a timeout:

```typescript
app.context.onShutdown(async () => {
  const timeout = setTimeout(() => {
    app.context.log.warn('Service deregistration timed out');
  }, 5000);

  try {
    await serviceRegistry.deregister('user-api');
  } finally {
    clearTimeout(timeout);
  }
});
```

3. **Set shutdown timeout appropriately.** The default is 10 seconds. If your shutdown hooks need more time (draining long-running requests, flushing large caches), increase it:

```typescript
app.setShutdownTimeout(30_000); // 30 seconds
```

4. **Use `disableSignalHandling()` in tests.** When running tests, you don't want SIGTERM handlers interfering with the test runner:

```typescript
const app = Ori.create();
app.disableSignalHandling();
// ... run tests ...
await app.stop(); // Explicit shutdown
```

## RequestContext Deep Dive

`RequestContext` is created fresh for every incoming request and flows through the entire request pipeline: guards, interceptors, validation, and your handler.

### What's Available

```typescript
interface RequestContext<TState = {}> {
  // Application context
  readonly app: AppContext;

  // Request data
  readonly request: Request;              // Native Request object
  readonly params: Record<string, string>; // Path parameters
  readonly query: Record<string, string | string[]>; // Query string (lazy)

  // Validated body (available after validation)
  readonly body: TBody;

  // Request metadata
  readonly correlationId: string;         // Request ID (lazy)
  readonly log: Logger;                   // Request logger (lazy)
  readonly signal: AbortSignal;           // Cancellation signal

  // State management
  get<K extends keyof TState>(key: K): TState[K];
  set<K extends keyof TState>(key: K, value: TState[K]): void;

  // Body parsing
  json<T>(): Promise<T>;
  text(): Promise<string>;

  // Param validation
  getValidatedParam(key: string): string;  // Alphanumeric + - _
  getValidatedUUID(key: string): string;   // UUID v4 format

  // Request-scoped services
  readonly events: EventEmitter;           // Request-bound events (lazy)
  readonly workflows: WorkflowExecutor;    // Request-bound workflows (lazy)
  readonly socket: SocketEmitter;          // Request-bound WebSocket (lazy)
}
```

### Performance: Lazy Evaluation

Notice the `(lazy)` annotations. OriJS avoids work until it's needed:

- **Query parsing** — The URL's query string isn't parsed until you access `ctx.query`. Most API endpoints use path parameters, not query strings, so parsing is skipped entirely for those requests.
- **Correlation ID** — Generated only when accessed. If your handler doesn't log or emit events, the UUID is never created.
- **Logger** — The request logger (which includes the correlation ID as context) is created on first access.
- **State object** — Allocated on first `set()` call.

This lazy approach means a simple "health check" endpoint (`GET /health` → `new Response('OK')`) allocates almost nothing beyond the context object itself.

### Correlation ID

Every request gets a correlation ID for tracing. OriJS checks for an incoming `X-Correlation-Id` header first — if present, it reuses that ID. Otherwise, it generates a new UUID v4.

This means if your API is called by another service that includes a correlation ID, the same ID flows through your logs, events, and downstream calls. This is essential for distributed tracing.

```typescript
private createUser = async (ctx: RequestContext) => {
  ctx.log.info('Creating user'); // Logs include { correlationId: "abc-123-..." }

  // Events carry the correlation ID automatically
  ctx.events.emit(UserCreatedEvent, { userId: user.id });
  // The event consumer sees the same correlation ID
};
```

### State: Passing Data Between Pipeline Stages

State is how guards pass data to handlers:

```typescript
// Guard sets state
class AuthGuard implements Guard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = await this.authService.verify(ctx.request);
    if (!user) return false;
    ctx.set('user', user);
    ctx.set('permissions', user.permissions);
    return true;
  }
}

// Handler reads state
private createPost = async (ctx: RequestContext) => {
  const user = ctx.get('user');
  const permissions = ctx.get('permissions');
  // ...
};
```

State is type-safe when you define the state shape:

```typescript
interface AppState {
  user: AuthenticatedUser;
  permissions: string[];
}

// The guard and handler both use RequestContext<AppState>
// TypeScript enforces that only valid keys are used
```

## What's Next

Now that you understand the core concepts — lifecycle, DI, AppContext, extension functions, and RequestContext — you're ready to learn about the architecture that makes OriJS unique: the provider system. The next chapter explains how every infrastructure component in OriJS is a swappable provider, and how to write your own.

[Next: The Provider Architecture →](./04-the-provider-architecture.md)
