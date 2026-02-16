# @orijs/core Technical Reference

Technical specification for the `@orijs/core` package. Covers internal architecture, public APIs, and behavioral contracts for each subsystem.

Source: `packages/core/src/`

---

## 1. Application (`application.ts`)

`OriApplication<TSocket>` is the top-level entry point. It provides a fluent builder API for configuring the entire application, then bootstraps and starts the HTTP server.

### Factory

```ts
const Ori = {
  create(options?: ApplicationOptions): OriApplication
};
```

`ApplicationOptions` accepts factory overrides for all internal coordinators (used for testing):

| Field | Type | Default |
|-------|------|---------|
| `container` | `Container` | `new Container()` |
| `responseFactory` | `ResponseFactory` | `new ResponseFactory()` |
| `routingCoordinatorFactory` | `(container, responseFactory, logger) => RoutingCoordinator` | direct construction |
| `eventCoordinatorFactory` | `(container, logger) => EventCoordinator` | direct construction |
| `workflowCoordinatorFactory` | `(logger, container) => WorkflowCoordinator` | direct construction |
| `lifecycleManagerFactory` | `(options) => LifecycleManager` | direct construction |
| `providerCoordinatorFactory` | `(container, logger) => ProviderCoordinator` | direct construction |
| `socketRoutingCoordinatorFactory` | `(container, logger) => SocketRoutingCoordinator` | direct construction |

### Fluent Builder Methods

All builder methods return `this` for chaining unless noted otherwise.

| Method | Signature | Description |
|--------|-----------|-------------|
| `config` | `(factoryOrProvider: ConfigProvider \| ((app) => Promise<void>)) => this` | Sets config provider, or an async factory that defers extensions via `deferredExtensions`. |
| `cors` | `(config: CorsConfig) => this` | Sets CORS configuration. Headers are pre-computed at startup in `buildStaticCorsHeaders()`. |
| `logger` | `(options: AppLoggerOptions) => this` | Configures global logger. Calls `Logger.configure()` to flush buffered logs. Recreates `RequestPipeline` with new logger. |
| `guard` | `(guard: GuardClass) => this` | Adds a global guard applied to all routes. |
| `intercept` | `(interceptor: InterceptorClass) => this` | Adds a global interceptor applied to all routes. |
| `provider` | Overloaded: `(service) => this` or `(service, deps, options?) => this` | Registers a provider. `ProviderOptions.eager` triggers immediate instantiation at bootstrap. |
| `providerInstance` | `(token: InjectionToken<T>, instance: T) => this` | Registers a pre-instantiated value. Works with class constructors, `Token<T>` symbols, and strings. |
| `providerWithTokens` | `(service, deps: InjectionToken[], options?) => this` | Registers a provider with mixed constructor/token deps. Trades compile-time checking for flexibility. |
| `use` | `(extension: (app) => app) => this` | Applies an extension function. If `pendingAsyncConfig` is set, the extension is deferred until config resolves. |
| `event` | `(definition: EventDefinition<P, R>) => EventRegistration<P, R>` | Registers an event definition. Returns a Proxy. |
| `workflow` | `(definition: WorkflowDefinition<D, R>) => WorkflowRegistration<D, R>` | Registers a workflow definition. Returns a Proxy. |
| `eventProvider` | `(provider: EventProvider) => this` | Sets a custom event provider (e.g., BullMQ). |
| `workflowProvider` | `(provider: WorkflowProvider) => this` | Sets a custom workflow provider. |
| `cache` | `(provider?: CacheProvider) => this` | Configures caching. Default: `InMemoryCacheProvider`. Registers `CacheService` as a provider instance. |
| `websocket` | `(provider?, options?) => OriApplication<TEmitter>` | Configures WebSocket support. Returns app with upgraded `TEmitter` type. Default provider: `InProcWsProvider`. |
| `onWebSocket` | `(handlers: WebSocketHandlers<TData>) => this` | Registers WebSocket lifecycle handlers (open, message, close, ping, pong, drain). |
| `controller` | Overloaded: `(path, controller)` or `(path, controller, deps)` | Registers an HTTP controller at a base path. |
| `socketRouter` | Overloaded: `(router)` or `(router, deps)` | Registers a WebSocket message router. |
| `listen` | `(port: number, callback?) => Promise<BunServer>` | Starts the server. Async. Returns Bun server instance. |
| `stop` | `() => Promise<void>` | Graceful shutdown. Safe to call multiple times. |
| `setShutdownTimeout` | `(timeoutMs: number) => this` | Default: 10000ms. |
| `disableSignalHandling` | `() => this` | Must be called before `listen()`. Used in tests. |
| `getRoutes` | `() => CompiledRoute[]` | Returns all compiled routes for debugging. |
| `getContainer` | `() => Container` | Exposes DI container for testing. |
| `getEventProvider` | `() => EventProvider \| null` | Returns event provider if configured. |
| `getWorkflowProvider` | `() => WorkflowProvider \| null` | Returns workflow provider if configured. |
| `getCacheService` | `() => CacheService \| null` | Returns cache service if configured. |
| `getWebSocketCoordinator` | `() => SocketCoordinator \| null` | Returns WS coordinator if configured. |
| `getWebSocketProvider` | `() => WebSocketProvider \| null` | Returns WS provider if configured. |
| `getSocketEmitter` | `<TEmitter>() => TEmitter` | Gets or creates the socket emitter instance. Throws if WS not configured. |
| `context` | `get context(): AppContext<TSocket>` | Always available. Created in constructor. |

### Proxy Pattern for `.event()` and `.workflow()`

Both methods return a `Proxy` that intercepts property access. If the caller accesses `.consumer()`, the proxy returns a function that registers the consumer class. For any other property, the proxy delegates to the original `OriApplication` instance via `Reflect.get()`. This enables the fluent pattern:

```ts
.event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
```

If `.consumer()` is never called, the event/workflow is registered for emission only.

The `EventRegistration<TPayload, TResponse>` and `WorkflowRegistration<TData, TResult>` interfaces extend `OriApplication`, making all builder methods available on the proxy.

### Bootstrap Sequence

`listen()` executes the following in order:

1. Await `pendingAsyncConfig` (if config was set via async factory)
2. Apply `pendingConfig` to `AppContext`
3. Run `deferredExtensions` (extensions deferred because config was async)
4. `bootstrap()`:
   - Set phase to `'bootstrapped'`
   - Set config provider on `AppContext`
   - Set event/workflow coordinators on `AppContext`
   - Set socket emitter getter on `AppContext` (if WS configured)
   - Register `AppContext` as a provider instance in the container
   - `providerCoordinator.registerProviders()` -- register all collected providers
   - `container.validate()` -- DFS cycle detection, missing deps, external packages
   - `providerCoordinator.instantiateEagerProviders()` -- resolve eager providers
   - `routingCoordinator.registerGlobalMiddleware()` -- register guards/interceptors in container
   - `routingCoordinator.registerControllers()` -- resolve controllers, build routes
   - `socketRoutingCoordinator.registerRouters()` -- resolve socket routers, compile routes
   - `eventCoordinator.registerConsumers()` -- instantiate event consumers via DI
   - `workflowCoordinator.registerConsumers()` -- instantiate workflow consumers via DI
   - Set workflow executor on `AppContext`
5. Initialize socket routing coordinator (if routers registered)
6. `startSystems()`:
   - Execute startup hooks (FIFO)
   - Start event provider
   - Start workflow provider
   - Start WebSocket provider
7. Log summary (provider count, route count, duration)
8. Pre-compute static CORS headers
9. Generate Bun native routes via `routingCoordinator.generateBunRoutes()`
10. `Bun.serve()` with routes and optional WebSocket handlers
11. Set server reference on WebSocket provider
12. `finalizeStartup()`:
    - Execute ready hooks (FIFO)
    - Register signal handlers (SIGTERM, SIGINT)
    - Invoke callback

### WebSocket Upgrade Handler

When a request arrives at the configured WebSocket path (default `/ws`) with `Upgrade: websocket` header:

1. Generate a correlation ID (UUID) for the upgrade attempt
2. If an upgrade handler is configured, race it against a 5-second timeout (`UPGRADE_TIMEOUT_MS = 5000`)
3. If the upgrade handler returns `null`, respond with 401
4. Generate a socket ID (UUID) and construct `SocketData` with `socketId`, `data`, and empty `topics` Set
5. Call `server.upgrade(request, { data: socketData })`
6. If upgrade fails, respond with 500

### CORS Pre-computation

At startup, `buildStaticCorsHeaders()` computes a `Record<string, string>` with:
- `Access-Control-Allow-Methods` (default: GET, POST, PUT, PATCH, DELETE, OPTIONS)
- `Access-Control-Allow-Headers` (default: Content-Type, Authorization, X-Firebase-AppCheck)
- `Access-Control-Max-Age` (default: 86400)
- `Access-Control-Allow-Credentials` (unless `credentials: false`)
- `Access-Control-Expose-Headers` (if configured)
- `Access-Control-Allow-Origin` (if origin is a string, not array)

For array origins, origin is computed per-request by checking the `Origin` header against the allowlist.

### Static Route Zero-Allocation Dispatch

When a handler is a `Response` object (not a function), it is passed directly to `Bun.serve()` routes. Bun handles these with zero-allocation dispatch since no handler function is invoked.

### Shutdown Sequence

`stop()`:
1. Guard: no-op if already in shutdown or no server
2. Execute shutdown hooks (LIFO, errors logged but do not halt)
3. Stop event coordinator
4. Stop workflow coordinator
5. Drain WebSocket connections (send close frame 1001 "Going Away", 100ms delay)
6. Stop WebSocket provider
7. `server.stop()`
8. Set `server = null`

---

## 2. DI Container (`container.ts`)

Simple DI container with explicit registration. No decorators or reflect-metadata.

### Data Structures

| Field | Type | Purpose |
|-------|------|---------|
| `registry` | `Map<InjectionToken, Constructor[]>` | Maps tokens to their dependency lists |
| `instances` | `Map<InjectionToken, unknown>` | Singleton cache |
| `resolving` | `Set<InjectionToken>` | Currently resolving tokens (for cycle detection at resolution time) |
| `externalDeps` | `Map<Constructor, string[]>` | npm packages required by services |
| `resolutionStartTime` | `number \| null` | Monotonic clock start for timeout tracking |
| `resolutionTimeoutMs` | `number` | Default: 5000ms |
| `validator` | `DependencyValidator` | Handles graph validation |

### Token Types

`InjectionToken<T> = Constructor<T> | Token<T> | string`

- **Constructor**: Class reference (most common). Used as both the key and the factory.
- **Token<T>**: Typed symbol created via `createToken<T>(name)`. Must be pre-instantiated via `registerInstance()`.
- **string**: Plain string key. Must be pre-instantiated via `registerInstance()`.

### Resolution Flow

**Synchronous (`resolve<T>(token)`)**:

1. Track if this is the top-level resolution call (for timeout tracking)
2. `resolveInternalSync()`:
   - Check resolution timeout (warns after 5s, once per top-level call)
   - Return cached instance if exists
   - `prepareResolution()`: validate token type, check for cycles, get deps from registry
   - Add to `resolving` set
   - Recursively resolve all dependencies
   - Construct instance via `new service(...resolvedDeps)`
   - If instance is a Promise, throw async constructor error
   - Cache instance
   - Remove from `resolving` set

**Asynchronous (`resolveAsync<T>(token)`)**:

Same flow but:
- Dependencies resolved via `Promise.all()` (parallel)
- Supports async constructors (constructor returning Promise)
- Awaits the constructor result if it is a Promise

### 5-Second Resolution Timeout Warning

When a top-level `resolve()` or `resolveAsync()` call exceeds `resolutionTimeoutMs` (default 5000ms), a single warning is logged with:
- Elapsed time
- Service name being resolved
- Current resolution chain
- Hint: "Check for blocking operations in service constructors"

This is a warning only; resolution continues.

### Public Methods

| Method | Description |
|--------|-------------|
| `register(service, deps?)` | Registers a class with its dependency list |
| `registerWithExternal(service, deps, external)` | Registers with external npm package requirements |
| `registerInstance(token, instance)` | Registers a pre-created instance (adds to both `registry` and `instances`) |
| `registerWithTokenDeps(service, deps: InjectionToken[])` | Registers with mixed constructor/token deps |
| `resolve(token)` | Synchronous singleton resolution |
| `resolveAsync(token)` | Async resolution supporting async constructors |
| `has(token)` | Checks if a token is registered |
| `validate()` | Validates the entire dependency graph (delegates to `DependencyValidator`) |
| `setLogger(logger)` | Sets logger for timeout warnings |
| `setResolutionTimeout(ms)` | Configures timeout threshold |
| `clearInstances()` | Clears singleton cache, keeps registrations |
| `clear()` | Clears everything |
| `getRegisteredCount()` | Returns `registry.size` |
| `getRegisteredNames()` | Returns human-readable names of all registered tokens |
| `getPackageCacheSize()` | Returns validator's package resolution cache size |

### Error Messages

All errors include fix suggestions with code examples:
- **Token not registered**: suggests `registerInstance()` or `.providerInstance()`
- **Circular dependency**: shows the dependency chain (e.g., `A -> B -> C -> A`)
- **Service not registered**: suggests `.provider()` or `.providerInstance()`
- **Async constructor**: suggests using `resolveAsync()` instead of `resolve()`

---

## 3. Dependency Validator (`dependency-validator.ts`)

Validates the dependency graph at startup before any instantiation.

### Validation Checks

Executed by `validate(registry, instances, externalDeps)`:

1. **Missing dependencies**: For each registered service, checks that all declared deps exist in the registry. Token-based deps (symbols/strings) get a different error message suggesting `providerInstance()`.

2. **Constructor parameter count mismatch**: Uses `service.length` (Function.length = number of formal parameters) to check if declared deps are fewer than constructor params. Extracts constructor parameter names via `toString()` parsing for error messages.

3. **Circular dependency detection**: DFS algorithm with O(V+E) complexity.

4. **External npm package validation**: Uses `Bun.resolveSync(packageName, process.cwd())`. Results cached in `packageCache` Map to avoid repeated resolution.

### DFS Cycle Detection Algorithm

```
detectCycles(registry):
  visited = Set<Constructor>
  recursionStack = Set<Constructor>
  path = Constructor[]

  for each Constructor token in registry:
    if not visited:
      detectCycleFrom(token)

  detectCycleFrom(service):
    if service in recursionStack:
      extract cycle from path[indexOf(service)..] + service
      return
    if service in visited: return
    visited.add(service)
    recursionStack.add(service)
    path.push(service)
    for each dep (Constructor only, skip symbols/strings):
      if dep is registered: detectCycleFrom(dep)
    path.pop()
    recursionStack.delete(service)
```

### Constructor Parameter Extraction

Parses `service.toString()` with regex `/constructor\s*\(([^)]*)\)/`. Strips `private|public|protected|readonly` prefixes and extracts parameter names before type annotations. Falls back to `param1, param2, ...` if parsing fails.

Limitation: If code is minified, parameter names will be shortened. This only affects error message quality, not functionality.

### Error Message Format

Errors are numbered and include fix suggestions:

```
Dependency injection validation failed:

  1. UserService depends on DbService, but DbService is not registered as a provider.

     Fix: Register DbService as a provider:
       .provider(DbService, [/* dependencies */])

  2. Circular dependency detected: A -> B -> C -> A

     Fix options:
       1. Extract shared logic into a new service
       2. Use an event/callback pattern
       3. Inject one service lazily via a factory function
```

---

## 4. AppContext (`app-context.ts`)

Application-scoped context. Created once in the `OriApplication` constructor. Available to services via DI injection.

### Type Parameter

`AppContext<TSocket extends SocketEmitter = SocketEmitter>` -- generic over the socket emitter type for typed `ctx.socket` access.

### Lifecycle Phase Tracking

```ts
type LifecyclePhase = 'created' | 'bootstrapped' | 'starting' | 'ready' | 'stopping' | 'stopped';
```

Phase transitions: `created` -> `bootstrapped` (in `bootstrap()`) -> `starting` (in `executeStartupHooks()`) -> `ready` (after `executeReadyHooks()`) -> `stopping` (in `executeShutdownHooks()`) -> `stopped`.

### Hook Registration and Execution

| Hook Type | Registration | Execution Order | Error Handling |
|-----------|-------------|-----------------|----------------|
| Startup | `onStartup(hook)` | FIFO (sequential, awaited) | Fail fast (throws) |
| Ready | `onReady(hook)` | FIFO (sequential, awaited) | Fail fast (throws) |
| Shutdown | `onShutdown(hook)` | LIFO (reversed, sequential, awaited) | Errors logged, continues |

Late registration warnings: If a hook is registered after its phase has passed, a warning is logged.

### Config Access

The `configProvider` property is non-enumerable (set via `Object.defineProperty` in constructor). This prevents accidental serialization via `JSON.stringify` or `for...in`.

When no config is set, `NullConfigProvider` is used. It throws with "Config not configured. Call .config(provider)" for all methods (`get`, `getRequired`, `loadKeys`).

`toJSON()` returns `{ phase: currentPhase }` (config excluded).

Custom `[Symbol.for('nodejs.util.inspect.custom')]` returns `AppContext { phase: '...', config: [REDACTED] }`.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `log` | `Logger` (readonly) | Application logger |
| `config` | `ConfigProvider` (getter) | Config provider |
| `event` | `EventSystem \| undefined` (getter) | Legacy event system |
| `workflows` | `WorkflowExecutor` (getter) | Throws if not configured |
| `hasWorkflows` | `boolean` (getter) | Check without throwing |
| `socket` | `TSocket` (getter) | Throws if not configured |
| `hasWebSocket` | `boolean` (getter) | Check without throwing |
| `phase` | `LifecyclePhase` (getter) | Current phase |
| `eventCoordinator` | `EventCoordinator \| undefined` (getter) | For request-bound emitters |
| `workflowCoordinator` | `WorkflowCoordinator \| undefined` (getter) | For request-bound emitters |

### DI Resolution

`resolve<T>(service)` and `resolveAsync<T>(service)` delegate to the container. Intended for lifecycle hooks only, not request-time code.

---

## 5. Lifecycle Manager (`lifecycle-manager.ts`)

Manages OS signal handling and graceful shutdown with timeout.

### Configuration

```ts
interface LifecycleOptions {
  logger: Logger;
  shutdownTimeoutMs?: number;      // default: 10000
  enableSignalHandling?: boolean;   // default: true
}
```

### Signal Handling

`registerSignalHandlers(onShutdown)`:
- Registers handlers for `SIGTERM` and `SIGINT`
- Named handler functions stored for later cleanup
- No-op if `enableSignalHandling` is false or handlers already registered
- Signal handlers call `onShutdown()` then `process.exit(0)`

`cleanupSignalHandlers()`: Removes all registered handlers via stored cleanup functions. Called automatically during shutdown.

### Graceful Shutdown

`executeGracefulShutdown(shutdownWork)`:
1. Guard against multiple calls (`isShuttingDown` flag)
2. Race `shutdownWork()` against timeout promise
3. If timeout fires, log warning and continue
4. Clear timeout
5. Clean up signal handlers
6. Reset `isShuttingDown` to false

`isInShutdown()` returns the current shutdown state.

---

## 6. Request Pipeline (`controllers/request-pipeline.ts`)

Handles the full HTTP request processing pipeline.

### Fast Path Optimization

When a route has no guards, no interceptors, no schema validation, and no param validators, the pipeline uses a minimal handler:

1. Create `RequestContext` via pre-allocated `RequestContextFactory`
2. Extract trace context (W3C traceparent)
3. Extract correlation ID (`x-correlation-id` > `x-request-id` > `crypto.randomUUID()`)
4. Call handler directly (no async/await -- uses `Promise.resolve().then().catch()` for ~23% improvement)
5. Wrap with `runWithContext()` for AsyncLocalStorage correlation propagation

### Full Path

Processing order:
1. Create `RequestContext`
2. Extract trace context and correlation ID
3. `runWithContext()` wraps entire execution
4. **Guards**: Pre-resolved at route registration time (singleton instances from container). Sequential. If any returns `false`, respond 403.
5. **Log request** (after guards, so `ctx.log` includes guard-set metadata)
6. **Param validators**: Pre-instantiated at route registration time. Validate each path param.
7. **Schema validation**: Validate `params`, `query`, and `body` against TypeBox schemas. Body validation only for POST/PUT/PATCH.
8. **Interceptors**: Pre-resolved at route registration time. Chain built in reverse order (onion model). Each interceptor receives `ctx` and `next()`.
9. **Handler**: Invoked with `RequestContext`.
10. **CORS headers**: Applied via `finalizeResponse` if configured.

### Guard Resolution at Compile Time

Guards and interceptors are resolved once when `createHandler()` is called during route generation, not per-request. The container's singleton caching ensures the same instance is reused across all requests.

### W3C Traceparent Extraction

Supports three header formats:
- `traceparent`: W3C format `version-trace_id-parent_id-flags`, extracts `trace_id` and `parent_id`
- `x-trace-id` + `x-span-id`: Custom headers
- Auto-generated if none present

### Interceptor Chain Construction

Built in reverse order. For interceptors `[A, B, C]`:

```
chain = () => C.intercept(ctx, () => B.intercept(ctx, () => A.intercept(ctx, handler)))
```

Each interceptor wraps the next, forming a linked function chain (onion model).

---

## 7. Request Context (`controllers/request-context.ts`)

Per-request context created by `RequestContextFactory`.

### Lazy Initialization

The following are lazily initialized on first access to minimize per-request allocation:

| Property | Trigger | Implementation |
|----------|---------|----------------|
| `query` | first access | Parses query string from URL (fast path: avoids `new URL()` by finding `?` index and slicing) |
| `log` | first access | Creates `Logger` with `correlationId`, wires `onSetMeta` to AsyncLocalStorage |
| `correlationId` | first access | Reads `x-request-id` header, falls back to `crypto.randomUUID()` |
| `state` | first access | Initializes empty `TState` object |
| `events` | first access | Creates `RequestBoundEventEmitter` |
| `workflows` | first access | Creates `RequestBoundWorkflowExecutor` |
| `socket` | first access | Creates `RequestBoundSocketEmitter` |

Pre-allocated constants: `EMPTY_QUERY` is a frozen empty object reused when no query string exists.

### Safe JSON Parsing

`json<T>()` uses `Json.parse()` (from `@orijs/validation`) for prototype pollution prevention. The native `request.json()` is not used because it does not sanitize `__proto__`.

Body can only be parsed once per request (either as JSON or text, not both).

### Parameter Validation

`getValidatedParam(key)`:
- Max length: 256 characters (`MAX_PARAM_LENGTH`)
- Allowlist: `a-z`, `A-Z`, `0-9`, `-`, `_` (validated via char codes for performance)
- Throws on missing, too long, or invalid characters

`getValidatedUUID(key)`:
- Fixed length: 36 characters
- Validates dash positions at indices 8, 13, 18, 23
- Validates hex characters at all other positions
- O(1) complexity (fixed-size input)

### AbortSignal

`signal` getter returns `this.request.signal`, which fires when the client disconnects. Can be passed to database queries or checked in loops.

### Type-Safe State

`set<K extends keyof TState>(key, value)` and `get<K extends keyof TState>(key)` provide compile-time type checking. Guards set state; handlers read it.

---

## 8. Response Factory (`controllers/response.ts`)

Creates standardized HTTP responses with pre-computed static values.

### Pre-computed Statics

```ts
private static readonly JSON_404 = '{"error":"Not Found"}';
private static readonly JSON_403 = '{"error":"Forbidden"}';
private static readonly JSON_405 = '{"error":"Method Not Allowed"}';
private static readonly JSON_HEADERS = { 'Content-Type': 'application/json' };
```

### Methods

| Method | Status | Description |
|--------|--------|-------------|
| `json(data, status)` | any | JSON.stringify response |
| `toResponse(result)` | 200 | Returns Response as-is, or wraps as JSON |
| `notFound()` | 404 | Pre-computed body |
| `forbidden()` | 403 | Pre-computed body |
| `methodNotAllowed()` | 405 | Pre-computed body |
| `error(error, options?)` | 500 | In production: generic message. In dev: includes error details. Optional `correlationId`. |
| `validationError(errors, options?)` | 422 | RFC 7807 style. Array of `{ path, message }`. |
| `stream(readable, contentType?, status?)` | 200 | ReadableStream with no-cache headers |
| `sseStream(source, options?)` | 200 | Server-Sent Events |

### SSE Stream Implementation

`sseStream()` accepts an `AsyncIterable<SseEvent>` or a factory function returning one.

Keep-alive: Sends `:keep-alive\n\n` comment at configurable interval (default 15s, `keepAliveMs`). Cleared on stream close or cancel.

Event format (per SSE specification):
```
event: <type>\n
id: <id>\n
retry: <ms>\n
data: <json-or-string>\n
\n
```

Multi-line data is split and each line prefixed with `data: `. Uses `Json.stringify` for objects.

Error handling: If the async iterable throws, an error event is sent before closing.

Headers include `X-Accel-Buffering: no` to disable nginx buffering.

---

## 9. Routing Coordinator (`routing-coordinator.ts`)

Manages HTTP controller registration, route compilation, and Bun native route generation.

### Path Normalization and Security

`normalizePath(input)`:
- Maximum path length: 2048 characters (`MAX_PATH_LENGTH`)
- Blocks path traversal: rejects paths containing `..`
- Blocks null bytes: rejects paths containing `\0`
- Ensures leading slash, removes trailing slash, collapses duplicate slashes

### Route Compilation

For each controller:
1. Register controller class with container
2. Resolve controller instance
3. Create `RouteBuilder` with global guards and interceptors
4. Call `controller.configure(builder)`
5. Register route middleware (guards, interceptors) with container if missing
6. Compile routes: combine controller path with route path, normalize

### Bun Route Generation

`generateBunRoutes()` produces a `Record<string, BunRouteHandler | MethodHandlers | Response>`:

1. Group compiled routes by path
2. For single-method paths:
   - Static `Response` handlers: passed directly (zero-allocation dispatch)
   - Function handlers: wrapped via `pipeline.createHandler()`, placed in method handlers object
3. For multi-method paths: method handlers object with per-method handlers
4. If CORS configured: add OPTIONS handler to all paths (pre-creates 204 response with cached headers)

### Global Middleware Registration

Guards and interceptors are registered with the container as zero-dependency services (constructor takes no arguments by convention). `registerIfMissing()` only registers if not already present.

---

## 10. Socket Pipeline (`sockets/`)

### Two-Phase Model

**Phase 1: Connection Guards** (once per WebSocket connection)
- `SocketPipeline.runConnectionGuards(ws, connectionGuards)` creates a `SocketContext` with message type `'__connection__'`
- Guards are pre-resolved from the container
- If any guard returns false or throws, returns null (connection rejected)
- If all pass, returns the context with populated state

**Phase 2: Message Routing** (per message)
- `SocketPipeline.handleMessage(ws, route, messageType, messageData, correlationId, connectionState)`
- Creates a new `SocketContext` per message
- Copies connection state (from Phase 1) to message context
- Runs per-message guards
- Validates message data against TypeBox schema (if configured)
- Executes handler
- Sends JSON response: `{ type, data, correlationId?, error? }`

### Connection State Persistence

`SocketRoutingCoordinator` maintains a `connectionStates` Map keyed by `socketId`. Each entry stores:
- `state`: key-value pairs set by connection guards
- `initialized`: boolean flag

State is cleaned up in `handleDisconnection(socketId)`.

### SocketContext vs RequestContext

| Aspect | SocketContext | RequestContext |
|--------|--------------|----------------|
| Scope | Per WebSocket message | Per HTTP request |
| Created by | `SocketContextFactory` | `RequestContextFactory` |
| State persistence | Connection state copied from guards per message | State per request only |
| Body access | `data` property (already parsed) | `json()` / `text()` methods |
| Additional fields | `ws`, `socketId`, `userData`, `messageType` | `request`, `params`, `query`, `signal` |
| Shared | `events`, `workflows`, `socket`, `log`, `app` | Same |

### SocketRouteBuilder Fluent API

```ts
class SocketRouteBuilder<TState, TSocket> {
  connectionGuard(guard: SocketGuardClass): this;
  guard(guard: SocketGuardClass): this;   // Router-level or route-level
  guards(guards: SocketGuardClass[]): this; // Replace all
  clearGuards(): this;
  on<TResponse>(messageType: string, handler: SocketHandler, schema?: Schema): this;
  getConnectionGuards(): readonly SocketGuardClass[];
  getRoutes(): readonly SocketRouteDefinition[];
}
```

Guard scoping: `guard()` called before any `on()` applies to all routes. Called after `on()` applies only to the current route (via `routeGuardsOverride`).

### SocketRoutingCoordinator

Manages router registration and message routing:
- `addRouter(config)`: Collects router configs
- `registerRouters()`: Registers with container, builds routes via `SocketRouteBuilder`, collects connection guards
- `initialize(appContext, loggerOptions)`: Creates `SocketPipeline`, re-compiles routes
- `handleConnection(ws)`: Runs connection guards, stores state
- `handleMessage(ws, type, data, correlationId)`: Looks up compiled route by message type, dispatches to pipeline
- `handleDisconnection(socketId)`: Cleans up state

Duplicate message types throw at registration time.

---

## 11. Event/Workflow Coordinators

### EventCoordinator (`event-coordinator.ts`)

Manages event definition registration, consumer instantiation, and provider lifecycle.

**Registration flow**:
1. `registerEventDefinition(definition)`: Stores in `eventDefinitions` Map. Throws on duplicate names.
2. `addEventConsumer(definition, consumerClass, deps)`: Stores in `pendingConsumers` array.
3. `registerConsumers()` (called during bootstrap):
   - If no provider set, creates `InProcessEventProvider` (only if events are configured)
   - For each pending consumer: register class with container, resolve instance, create validated handler, subscribe to provider
   - Tracks consumer events in `registeredConsumerEvents` Set

**Validated handler wrapper**:
- Validates payload against `definition.dataSchema` using `Value.Check()` / `Value.Errors()`
- Creates `EventContext` with `eventId`, `data`, `log`, `eventName`, `timestamp`, `correlationId`, `causationId`, `emit`
- `emit` in the context propagates correlation/causation IDs for event chains
- Calls `consumer.onEvent(ctx)`
- Validates response against `definition.resultSchema`
- Calls `consumer.onSuccess()` on success, `consumer.onError()` on failure

### WorkflowCoordinator (`workflow-coordinator.ts`)

Manages workflow definition registration, consumer instantiation, step execution, and provider lifecycle.

**Registration flow**:
1. `registerWorkflowDefinition(definition)`: Stores in `workflowDefinitions` Map.
2. `addWorkflowConsumer(definition, consumerClass, deps)`: Stores in `pendingConsumers` array.
3. `registerConsumers()` (called during bootstrap):
   - Creates `InProcessWorkflowProvider` if no provider set
   - Instantiates consumers via DI
   - Validates consumer configuration: detects `configure()` without steps, or steps without handlers
   - Registers with provider via `registerDefinitionConsumer()` (if provider supports it)
   - Registers emitter-only workflows via `registerEmitterWorkflow()`

**Consumer validation** (during `registerConsumers()`):
- `hasConfigure && !hasStepsOnDefinition`: Error -- consumer has configure() but definition has no steps
- `hasStepsOnDefinition && !hasStepsProperty`: Error -- definition has steps but consumer has no handlers

**`createExecutor()` returns a `WorkflowExecutor`**:

The `execute()` method:
1. Validates workflow is a `WorkflowDefinition` (not class-based)
2. If no consumer: delegates to provider (emitter-only mode)
3. Validates input data against `definition.dataSchema`
4. Generates flow ID (`wf-<uuid>`)
5. Captures propagation metadata from AsyncLocalStorage
6. Executes step groups if defined:
   - **Sequential steps**: Execute one at a time, validate output, accumulate results, track for rollback
   - **Parallel steps**: Execute via `Promise.all()`, validate all outputs, accumulate results
   - **Rollback on failure**: Execute rollbacks in reverse order of completed steps. Log rollback failures but continue. Re-throw original error.
7. Creates `WorkflowContext` with accumulated step results
8. Calls `consumer.onComplete(ctx)`
9. Validates result against `definition.resultSchema`
10. Returns `FlowHandle` (already completed at this point for direct invocation)

---

## 12. Request-Bound Emitters (`controllers/request-bound-emitters.ts`)

### RequestBoundEventEmitter

Implements `EventEmitter`. Wraps `EventCoordinator` with request binding.

`emit(event, payload)`:
1. Gets provider from coordinator (throws if none)
2. Checks event is registered (throws if not)
3. Validates payload against TypeBox schema
4. Creates `PropagationMeta` with `correlationId` as both `correlationId` and `causationId`
5. Emits via underlying provider

### RequestBoundWorkflowExecutor

Implements `WorkflowExecutor`. Wraps `WorkflowCoordinator` with request binding.

`execute(workflow, data, options?)`:
1. Looks up consumer in coordinator
2. If no consumer but definition exists: returns `NullWorkflowHandle` (status: `'failed'`, result throws)
3. If no definition: throws
4. Validates data against TypeBox schema
5. Creates `DirectInvocationHandle` for tracking
6. Fires async consumer execution (does not await -- returns handle immediately)
7. Consumer errors are captured in the handle

### DirectInvocationHandle

In-memory workflow handle for direct consumer invocation:
- States: `'running'` | `'completed'` | `'failed'`
- `result()`: Returns immediately if completed, or creates a Promise that resolves/rejects when `_complete()`/`_fail()` is called
- `cancel()`: Always returns `false` (not supported for direct invocation)

### NullWorkflowHandle

Returned when a workflow is defined but has no consumer:
- `id`: `null-{workflowName}-{timestamp}`
- `status()`: Returns `'failed'`
- `result()`: Throws "no workflow provider configured"
- `cancel()`: Returns `false`

### RequestBoundSocketEmitter

Implements `SocketEmitter`. Wraps the underlying emitter, exposes `correlationId` for optional inclusion in message payloads.

Delegates all calls (`publish`, `send`, `broadcast`, `emit`) to the wrapped emitter.

---

## 13. Types

All public type exports from `packages/core/src/types/`.

### Core DI Types (`context.ts`)

| Type | Definition |
|------|-----------|
| `Constructor<T>` | `new (...args: any[]) => T` |
| `InjectionToken<T>` | `Constructor<T> \| Token<T> \| string` |
| `ConstructorDeps<T>` | Maps constructor parameter types to their constructor types. Enforces correct types AND order. |
| `LifecycleHook` | `() => void \| Promise<void>` |
| `LifecyclePhase` | `'created' \| 'bootstrapped' \| 'starting' \| 'ready' \| 'stopping' \| 'stopped'` |
| `Handler` | `(ctx: RequestContext) => Response \| Promise<Response>` |
| `HandlerInput` | `Handler \| Response` |

### HTTP Types (`http.ts`)

```ts
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
```

### Controller Types (`controller.ts`)

| Type | Description |
|------|-------------|
| `OriController<TState, TParams>` | Interface with `configure(route: RouteBuilder<TState, TParams>): void` |
| `ControllerClass` | Constructor producing `OriController` |
| `RouteDefinition` | Internal: method, path, handler, guards, interceptors, pipes, schema, paramValidators |
| `RouteSchemaOptions` | `{ params?, query?, body? }` -- TypeBox schemas |
| `RouteBuilder<TState, TParams>` | Fluent API interface with `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `guard`, `guards`, `clearGuards`, `intercept`, `interceptors`, `clearInterceptors`, `pipe`, `clear`, `param` (accumulates `TParams`), `getRoutes` |
| `ContextHandler<TState, TParams>` | `(ctx: RequestContext<TState, SocketEmitter, TParams>) => Response \| Promise<Response>` |
| `ContextHandlerInput<TState, TParams>` | `ContextHandler<TState, TParams> \| Response` |

### Middleware Types (`middleware.ts`)

| Type | Definition |
|------|-----------|
| `Guard` | `{ canActivate(ctx: RequestContext): boolean \| Response \| Promise<boolean \| Response> }` |
| `GuardClass` | Constructor producing `Guard` |
| `Interceptor` | `{ intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> }` |
| `InterceptorClass` | Constructor producing `Interceptor` |
| `Pipe<TInput, TOutput>` | `{ transform(value: TInput, metadata?: PipeMetadata): TOutput \| Promise<TOutput> }` |
| `PipeMetadata` | `{ type: 'body' \| 'param' \| 'query'; key?: string }` |
| `PipeClass` | Constructor producing `Pipe` |

### Event Definition Types (`event-definition.ts`)

| Type | Description |
|------|-------------|
| `EventConfig<TData, TResult>` | `{ name: string; data: TData; result: TResult }` |
| `EventDefinition<TData, TResult>` | `{ name, dataSchema, resultSchema, _data: TData, _result: TResult }` -- `_data` and `_result` are type carriers (undefined at runtime) |
| `EventContext<TPayload>` | `{ eventId, data, log, eventName, timestamp, correlationId, causationId?, emit }` |
| `Event` | Factory: `Event.define(config)` returns frozen `EventDefinition` |

### Workflow Definition Types (`workflow-definition.ts`)

| Type | Description |
|------|-------------|
| `WorkflowConfig<TData, TResult>` | `{ name: string; data: TData; result: TResult }` |
| `WorkflowDefinition<TData, TResult, TSteps>` | `{ name, dataSchema, resultSchema, stepGroups, _data, _result, _steps }` |
| `WorkflowDefinitionBuilder<TData, TResult>` | Extends `WorkflowDefinition` with `.steps()` method |
| `StepDefinition<TName, TOutput>` | `{ name: TName; outputSchema: TSchema; _output: TOutput }` |
| `StepGroup` | `{ type: 'sequential' \| 'parallel'; definitions: readonly StepDefinition[] }` |
| `StepBuilder<TSteps>` | Fluent builder: `step()`, `sequential()`, `parallel()` |
| `StepContext<TData, TResults>` | `{ flowId, data, results, log, meta, stepName, providerId? }` |
| `WorkflowContext<TData, TSteps>` | `{ flowId, data, results: TSteps, log, meta, correlationId, providerId? }` |
| `Workflow` | Factory: `Workflow.define(config)` returns `WorkflowDefinitionBuilder` |
| `isWorkflowDefinition(value)` | Type guard checking for `name`, `dataSchema`, `resultSchema`, `stepGroups` |
| `hasSteps(definition)` | Returns `stepGroups.length > 0` |

### Consumer Interfaces (`consumer.ts`)

| Type | Description |
|------|-------------|
| `IEventConsumer<TData, TResult>` | `{ onEvent: (ctx) => TResult; onSuccess?: (ctx, result) => void; onError?: (ctx, error) => void }` |
| `IWorkflowConsumer<TData, TResult, TSteps>` | `{ steps?: { [K in keyof TSteps]?: StepHandler }; onComplete: (ctx) => TResult; onError?: (ctx, error) => void }` |
| `StepHandler<TData, TOutput, TResults>` | `{ execute: (ctx: StepContext<TData, TResults>) => TOutput; rollback?: (ctx) => void }` |

All handler properties must be arrow function properties (not methods) to preserve `this` binding when detached by the framework.

### Emitter Interfaces (`emitter.ts`)

| Type | Description |
|------|-------------|
| `EventEmitter` | `{ emit<TPayload, TResponse>(event, payload): Promise<TResponse> }` |
| `WorkflowExecutor` | `{ execute<TData, TResult>(workflow, data, options?): Promise<WorkflowHandle<TResult>> }` |
| `WorkflowExecuteOptions` | `{ id?: string; priority?: number; delay?: number }` |
| `WorkflowHandle<TResult>` | `{ id: string; status(): Promise<WorkflowStatus>; result(): Promise<TResult>; cancel(): Promise<boolean> }` |
| `WorkflowStatus` | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'cancelled'` |
| `SocketEmitter` | Re-exported from `@orijs/websocket`. `{ publish, send, broadcast, emit }` |

### Socket Router Types (`socket-router.ts`)

| Type | Description |
|------|-------------|
| `SocketGuard` | `{ canActivate(ctx: SocketContextLike): boolean \| Promise<boolean> }` |
| `SocketGuardClass` | Constructor producing `SocketGuard` |
| `OriSocketRouter<TState, TSocket>` | `{ configure(route: SocketRouteBuilder<TState, TSocket>): void }` |
| `SocketRouterClass` | Constructor producing `OriSocketRouter` |
| `SocketHandler<TState, TSocket, TResponse>` | `(ctx: any) => TResponse \| Promise<TResponse>` |
| `SocketRouteDefinition` | `{ messageType, handler, guards, schema? }` |
| `SocketRouteBuilder<TState, TSocket>` | Interface with `connectionGuard`, `guard`, `guards`, `clearGuards`, `on`, `getConnectionGuards`, `getRoutes` |
| `SocketRouterConfig` | `{ router: SocketRouterClass; deps: Constructor[] }` |
| `SocketMessage<TData>` | `{ type: string; data?: TData; correlationId?: string }` |
| `SocketResponse<TData>` | `{ type: string; data: TData; correlationId?: string; error?: string }` |
| `SocketCtx<TState, TSocket>` | Alias for `SocketContextLike<TState, TSocket>` |

### Socket Message Definition Types (`socket-message-definition.ts`)

| Type | Description |
|------|-------------|
| `SocketMessageConfig<TData>` | `{ name: string; data: TData }` |
| `SocketMessageDefinition<TData>` | `{ name, dataSchema, _data: TData }` |
| `SocketMessage` | Factory: `SocketMessage.define(config)` returns frozen `SocketMessageDefinition` |

### Utility Types (`utility.ts`, `type-extractors.ts`)

| Type | Description |
|------|-------------|
| `Data<T>` | Extracts `_data` type from `EventDefinition` or `WorkflowDefinition` |
| `Result<T>` | Extracts `_result` type from `EventDefinition` or `WorkflowDefinition` |
| `MessageData<T>` | Extracts `_data` type from `SocketMessageDefinition` |
| `EventConsumer<T>` | Maps `EventDefinition` to `IEventConsumer<Data, Result>` |
| `EventCtx<T>` | Maps `EventDefinition` to `EventContext<Data>` |
| `WorkflowConsumer<T>` | Maps `WorkflowDefinition` to `IWorkflowConsumer<Data, Result, Steps>` (typed step results) |
| `WorkflowCtx<T>` | Maps `WorkflowDefinition` to `WorkflowContext<Data, Steps>` |

### Application Types (`application.ts`)

| Type | Description |
|------|-------------|
| `ControllerConfig` | `{ path, controller, deps }` |
| `ProviderConfig` | `{ service, deps, eager? }` |
| `ProviderOptions` | `{ eager?: boolean }` |
| `AppLoggerOptions` | `{ level?, transports?, clearConsole?, traceFields? }` |
| `CorsConfig` | `{ origin, methods?, allowedHeaders?, exposedHeaders?, credentials?, maxAge? }` |

---

## 14. Provider Coordinator (`provider-coordinator.ts`)

Collects provider configurations during the builder phase and batch-registers them during bootstrap.

| Method | Description |
|--------|-------------|
| `addProvider(service, deps, eager?)` | Stores in `providers` array |
| `registerInstance(token, instance)` | Delegates to `container.registerInstance()` |
| `registerProviders()` | Batch registers all collected providers with container |
| `instantiateEagerProviders()` | Resolves providers with `eager: true` |
| `getProviderCount()` | Returns number of collected providers |
