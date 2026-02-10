# Chapter 19: API Reference

This chapter is a comprehensive reference for every package, class, method, and interface in OriJS. Use it as a lookup when you need the exact signature of a method or the shape of an interface.

## @orijs/core

The foundation package. Provides the application builder, DI container, routing, and lifecycle management.

### Ori

Static factory for creating applications.

```typescript
import { Ori } from '@orijs/core';

Ori.create(options?: ApplicationOptions): OriApplication
```

**ApplicationOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `container` | `Container` | Custom DI container (default: `new Container()`) |
| `responseFactory` | `ResponseFactory` | Custom response factory |
| `routingCoordinatorFactory` | `Function` | Factory for custom routing coordinator (testing) |
| `eventCoordinatorFactory` | `Function` | Factory for custom event coordinator (testing) |
| `workflowCoordinatorFactory` | `Function` | Factory for custom workflow coordinator (testing) |
| `lifecycleManagerFactory` | `Function` | Factory for custom lifecycle manager (testing) |
| `providerCoordinatorFactory` | `Function` | Factory for custom provider coordinator (testing) |
| `socketRoutingCoordinatorFactory` | `Function` | Factory for custom socket routing coordinator (testing) |

### OriApplication

The main application class. All methods return `this` for fluent chaining unless otherwise noted.

**Configuration Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `config` | `(provider: ConfigProvider \| AsyncFactory): this` | Sets the config provider or async config factory |
| `cors` | `(config: CorsConfig): this` | Configures CORS |
| `logger` | `(options: AppLoggerOptions): this` | Configures the application logger |

**CorsConfig:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `origin` | `string \| string[]` | — | Allowed origins |
| `methods` | `string[]` | `['GET','POST','PUT','PATCH','DELETE','OPTIONS']` | Allowed HTTP methods |
| `allowedHeaders` | `string[]` | `['Content-Type','Authorization','X-Firebase-AppCheck']` | Allowed request headers |
| `exposedHeaders` | `string[]` | `[]` | Headers exposed to the browser |
| `credentials` | `boolean` | `true` | Allow credentials |
| `maxAge` | `number` | `86400` | Preflight cache duration (seconds) |

**AppLoggerOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `level` | `LevelName` | Log level: `'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` |
| `transports` | `Transport[]` | Array of log transports |
| `traceFields` | `TraceFieldDef[]` | Custom trace field definitions |
| `clearConsole` | `boolean` | Clear console before logging starts |

**Provider Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `provider` | `(service, deps?, options?): this` | Registers a provider with constructor dependencies |
| `providerInstance` | `(token, instance): this` | Registers a pre-instantiated value |
| `providerWithTokens` | `(service, deps, options?): this` | Registers with explicit token dependencies |
| `use` | `(extension: (app) => app): this` | Applies an extension function |

**ProviderOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `eager` | `boolean` | `false` | Instantiate at startup (not on first use) |

**Middleware Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `guard` | `(guard: GuardClass): this` | Adds a global guard |
| `intercept` | `(interceptor: InterceptorClass): this` | Adds a global interceptor |

**Controller Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `controller` | `(path, controller, deps?): this` | Registers an HTTP controller |
| `socketRouter` | `(router, deps?): this` | Registers a WebSocket socket router |

**Event Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `event` | `(definition): EventRegistration` | Registers an event definition |
| `eventProvider` | `(provider: EventProvider): this` | Sets custom event provider |
| `getEventProvider` | `(): EventProvider \| null` | Returns the event provider |

**EventRegistration** (returned by `.event()`):

| Method | Signature | Description |
|--------|-----------|-------------|
| `consumer` | `(consumerClass, deps?): OriApplication` | Registers consumer for this event |

**Workflow Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `workflow` | `(definition): WorkflowRegistration` | Registers a workflow definition |
| `workflowProvider` | `(provider: WorkflowProvider): this` | Sets custom workflow provider |
| `getWorkflowProvider` | `(): WorkflowProvider \| null` | Returns the workflow provider |

**WorkflowRegistration** (returned by `.workflow()`):

| Method | Signature | Description |
|--------|-----------|-------------|
| `consumer` | `(consumerClass, deps?): OriApplication` | Registers consumer for this workflow |

**Cache Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `cache` | `(provider?: CacheProvider): this` | Configures caching (default: InMemory) |
| `getCacheService` | `(): CacheService \| null` | Returns the cache service |

**WebSocket Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `websocket` | `(provider?, options?): OriApplication<TEmitter>` | Configures WebSocket support |
| `onWebSocket` | `(handlers: WebSocketHandlers): this` | Registers WebSocket lifecycle handlers |
| `getWebSocketCoordinator` | `(): SocketCoordinator \| null` | Returns the WebSocket coordinator |
| `getWebSocketProvider` | `(): WebSocketProvider \| null` | Returns the WebSocket provider |
| `getSocketEmitter` | `(): TEmitter` | Returns the socket emitter instance |

**WebSocket options** (second parameter of `.websocket()`):

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `path` | `string` | `'/ws'` | WebSocket upgrade path |
| `emitter` | `SocketEmitterConstructor` | `null` | Custom emitter class |
| `upgrade` | `(request: Request) => TData \| null` | `null` | Upgrade handler (null rejects) |

**Lifecycle Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `listen` | `(port: number, callback?): Promise<BunServer>` | Starts the HTTP server |
| `stop` | `(): Promise<void>` | Stops the server gracefully |
| `disableSignalHandling` | `(): this` | Disables SIGINT/SIGTERM handling (for tests) |
| `setShutdownTimeout` | `(timeoutMs: number): this` | Sets graceful shutdown timeout (default: 10s) |

**Inspection Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `getRoutes` | `(): CompiledRoute[]` | Returns all registered routes |
| `getContainer` | `(): Container` | Returns the DI container |
| `context` | `AppContext` (getter) | Returns the application context |

### Container

Dependency injection container. Singletons by default.

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(service, deps?): void` | Registers a service with dependencies |
| `registerInstance` | `(token, instance): void` | Registers a pre-created instance |
| `registerWithTokenDeps` | `(service, deps): void` | Registers with token dependencies |
| `registerWithExternal` | `(service, deps, external): void` | Registers with external package checks |
| `resolve` | `(token): T` | Resolves a service synchronously |
| `resolveAsync` | `(token): Promise<T>` | Resolves with async constructor support |
| `has` | `(token): boolean` | Checks if a service is registered |
| `validate` | `(): void` | Validates the dependency graph |
| `clear` | `(): void` | Clears all registrations and instances |
| `clearInstances` | `(): void` | Clears instances, keeps registrations |
| `getRegisteredCount` | `(): number` | Returns count of registered services |
| `getRegisteredNames` | `(): string[]` | Returns names of registered services |
| `setResolutionTimeout` | `(timeoutMs): void` | Sets timeout warning threshold |
| `setLogger` | `(logger): void` | Sets logger for container warnings |

### createToken

Creates a typed injection token for named providers.

```typescript
import { createToken } from '@orijs/core';

const HotCache = createToken<CacheService>('HotCache');
const ColdCache = createToken<CacheService>('ColdCache');
```

### AppContext

Application-scoped context. Created once per application.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `log` | `Logger` | Application logger |
| `config` | `ConfigProvider` | Configuration provider |
| `phase` | `LifecyclePhase` | Current lifecycle phase |
| `socket` | `TSocket` | Socket emitter (throws if not configured) |
| `workflows` | `WorkflowExecutor` | Workflow executor (throws if not configured) |
| `hasWebSocket` | `boolean` | Whether WebSocket is configured |
| `hasWorkflows` | `boolean` | Whether workflows are configured |

**LifecyclePhase:** `'created' | 'bootstrapped' | 'starting' | 'ready' | 'stopping' | 'stopped'`

**Lifecycle Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `onStartup` | `(hook: () => Promise<void>): void` | Register startup hook |
| `onReady` | `(hook: () => Promise<void>): void` | Register ready hook |
| `onShutdown` | `(hook: () => Promise<void>): void` | Register shutdown hook |
| `resolve` | `(service): T` | Resolve service from container |
| `resolveAsync` | `(service): Promise<T>` | Resolve with async support |
| `getConfig` | `(): T` | Get typed config |

### RouteBuilder

Fluent API for defining routes within a controller.

| Method | Signature | Description |
|--------|-----------|-------------|
| `guard` | `(guard: GuardClass): this` | Adds a guard |
| `guards` | `(guards: GuardClass[]): this` | Replaces all guards |
| `clearGuards` | `(): this` | Removes all guards |
| `intercept` | `(interceptor: InterceptorClass): this` | Adds an interceptor |
| `interceptors` | `(interceptors: InterceptorClass[]): this` | Replaces all interceptors |
| `clearInterceptors` | `(): this` | Removes all interceptors |
| `pipe` | `(pipe: PipeClass, schema?): this` | Adds a validation pipe |
| `clear` | `(): this` | Removes all guards and interceptors |
| `param` | `(name, validator): this` | Declares a path parameter validator |
| `get` | `(path, handler, schema?): this` | Registers a GET route |
| `post` | `(path, handler, schema?): this` | Registers a POST route |
| `put` | `(path, handler, schema?): this` | Registers a PUT route |
| `patch` | `(path, handler, schema?): this` | Registers a PATCH route |
| `delete` | `(path, handler, schema?): this` | Registers a DELETE route |
| `head` | `(path, handler, schema?): this` | Registers a HEAD route |
| `options` | `(path, handler, schema?): this` | Registers an OPTIONS route |

**RouteSchemaOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `params` | `Schema` | Schema for URL path parameters |
| `query` | `Schema` | Schema for query string parameters |
| `body` | `Schema` | Schema for request body |

### RequestContext

Request-scoped context passed to handlers, guards, and interceptors.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `request` | `Request` | The raw Bun Request object |
| `params` | `Record<string, string>` | URL path parameters |
| `query` | `Record<string, string \| string[]>` | Parsed query string (lazy) |
| `state` | `TState` | State set by guards (lazy) |
| `correlationId` | `string` | Request ID (from header or generated) |
| `log` | `Logger` | Request-scoped logger (lazy) |
| `events` | `EventEmitter` | Type-safe event emitter (lazy) |
| `workflows` | `WorkflowExecutor` | Workflow executor (lazy) |
| `socket` | `TSocket` | Socket emitter with correlation binding (lazy) |
| `signal` | `AbortSignal` | Client disconnect signal |
| `app` | `AppContext` | Application context |

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `set` | `(key, value): void` | Set a state variable |
| `get` | `(key): TState[K]` | Get a state variable |
| `json` | `(): Promise<T>` | Parse body as JSON |
| `text` | `(): Promise<string>` | Parse body as text |
| `getValidatedParam` | `(key): string` | Get validated path parameter |
| `getValidatedUUID` | `(key): string` | Get validated UUID parameter |

### ResponseFactory

Creates standardized HTTP responses.

| Method | Signature | Description |
|--------|-----------|-------------|
| `json` | `(data, status): Response` | JSON response |
| `toResponse` | `(result): Response` | Convert any value to Response |
| `notFound` | `(): Response` | 404 Not Found |
| `forbidden` | `(): Response` | 403 Forbidden |
| `methodNotAllowed` | `(): Response` | 405 Method Not Allowed |
| `error` | `(error, options?): Response` | 500 Internal Server Error |
| `validationError` | `(errors, options?): Response` | 422 Unprocessable Entity |
| `stream` | `(readable, contentType?, status?): Response` | Streaming response |
| `sseStream` | `(source, options?): Response` | Server-Sent Events stream |

### Interfaces

**Guard:**

```typescript
interface Guard {
  canActivate(ctx: RequestContext): boolean | Promise<boolean>;
}
```

**Interceptor:**

```typescript
interface Interceptor {
  intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response>;
}
```

**Pipe:**

```typescript
interface Pipe<TInput = unknown, TOutput = unknown> {
  transform(value: TInput, metadata?: PipeMetadata): TOutput | Promise<TOutput>;
}
```

**OriController:**

```typescript
interface OriController<TState extends object = Record<string, unknown>> {
  configure(route: RouteBuilder<TState>): void;
}
```

**ParamValidator:**

```typescript
interface ParamValidator {
  validate(value: string, key: string): string; // Returns validated value or throws
}
```

**Built-in Param Validators:** `UuidParam`, `StringParam`, `NumberParam`

### HttpException

OriJS does not have a built-in `HttpException` class. Use domain error classes with an error mapping interceptor (see [Chapter 17](./17-advanced-patterns.md)).

---

## @orijs/validation

TypeBox-based validation with Standard Schema and custom validator support.

### Type

Re-exported from `@sinclair/typebox`. Defines JSON Schema-compatible types.

**Common methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `Type.Object(props)` | `TObject` | Object schema |
| `Type.String(opts?)` | `TString` | String schema |
| `Type.Number(opts?)` | `TNumber` | Number schema |
| `Type.Integer(opts?)` | `TInteger` | Integer schema |
| `Type.Boolean()` | `TBoolean` | Boolean schema |
| `Type.Array(items)` | `TArray` | Array schema |
| `Type.Null()` | `TNull` | Null schema |
| `Type.Optional(schema)` | `TOptional` | Optional wrapper |
| `Type.Union(schemas)` | `TUnion` | Union type |
| `Type.Intersect(schemas)` | `TIntersect` | Intersection type |
| `Type.Literal(value)` | `TLiteral` | Literal value |
| `Type.Enum(enumObj)` | `TEnum` | Enum schema |
| `Type.Record(key, value)` | `TRecord` | Record/map schema |
| `Type.Tuple(items)` | `TTuple` | Tuple schema |
| `Type.Any()` | `TAny` | Any type |
| `Type.Unknown()` | `TUnknown` | Unknown type |
| `Type.Void()` | `TVoid` | Void type (for fire-and-forget events) |
| `Type.Ref(schema)` | `TRef` | Reference to another schema |

**String format options:** `'email'`, `'uuid'`, `'uri'`, `'date-time'`, `'date'`, `'time'`, `'ipv4'`, `'ipv6'`

### Params

Pre-built parameter validation schemas.

```typescript
import { Params } from '@orijs/validation';

Params.uuid()        // UUID format string
Params.string(opts?) // String with optional min/max length
Params.number(opts?) // Numeric string (parsed to number)
```

### Query

Pre-built query parameter schemas.

```typescript
import { Query } from '@orijs/validation';

Query.pagination(opts?)  // { page, limit } with defaults
Query.search(opts?)      // { q } search string
Query.sort(opts?)        // { sortBy, sortOrder }
```

### validate / validateSync

```typescript
import { validate, validateSync } from '@orijs/validation';

// Async — supports TypeBox, Standard Schema, custom validators
const result = await validate(schema, data);
// result: { success: true, data: T } | { success: false, errors: ValidationError[] }

// Sync — TypeBox only
const result = validateSync(schema, data);
```

### Json

Safe JSON parsing with prototype pollution protection.

```typescript
import { Json } from '@orijs/validation';

Json.parse(text)       // Safe parse (strips __proto__, constructor)
Json.stringify(value)  // Standard stringify
Json.sanitize(data)    // Strip prototype pollution keys from object
```

---

## @orijs/events

Type-safe event system with pluggable providers.

### Event.define

Creates a type-safe event definition.

```typescript
import { Event } from '@orijs/core';
import { Type } from '@orijs/validation';

const UserCreated = Event.define({
  name: 'user.created',
  data: Type.Object({ userId: Type.String(), email: Type.String() }),
  result: Type.Object({ welcomeEmailSent: Type.Boolean() }),
});
```

**EventConfig:**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique event name (dot notation: `'entity.action'`) |
| `data` | `TSchema` | TypeBox schema for input data |
| `result` | `TSchema` | TypeBox schema for result (use `Type.Void()` for fire-and-forget) |

### IEventConsumer

Interface for event consumer classes.

```typescript
interface IEventConsumer<TData, TResult> {
  readonly onEvent: (ctx: EventContext<TData>) => Promise<TResult> | TResult;
  readonly onSuccess?: (ctx: EventContext<TData>, result: TResult) => Promise<void> | void;
  readonly onError?: (ctx: EventContext<TData>, error: Error) => Promise<void> | void;
}
```

### EventContext

Context passed to event consumers.

| Property | Type | Description |
|----------|------|-------------|
| `eventId` | `string` | Unique event instance ID |
| `data` | `TPayload` | The event payload data |
| `log` | `Logger` | Structured logger |
| `eventName` | `string` | Event name |
| `timestamp` | `number` | Emission timestamp (ms since epoch) |
| `correlationId` | `string` | Correlation ID for tracing |
| `causationId` | `string?` | Parent event ID (chain tracking) |
| `emit` | `Function` | Emit chained events |

### EventProvider Interface

```typescript
interface EventProvider extends EventEmitter, EventLifecycle {}

interface EventEmitter {
  emit(eventName, payload, meta?, options?): EventSubscription;
  subscribe(eventName, handler): void | Promise<void>;
}

interface EventLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### Utility Types

```typescript
import type { Data, Result, EventConsumer, EventCtx } from '@orijs/core';

type UserData = Data<typeof UserCreated>;      // Extract data type
type UserResult = Result<typeof UserCreated>;  // Extract result type
type Consumer = EventConsumer<typeof UserCreated>; // Consumer interface
type Ctx = EventCtx<typeof UserCreated>;       // Context type
```

---

## @orijs/workflows

Saga-pattern workflow orchestration with distributed step execution.

### Workflow.define

Creates a type-safe workflow definition with optional steps.

```typescript
import { Workflow } from '@orijs/core';
import { Type } from '@orijs/validation';

// Simple workflow (no steps)
const SendEmail = Workflow.define({
  name: 'send-email',
  data: Type.Object({ to: Type.String(), subject: Type.String() }),
  result: Type.Object({ messageId: Type.String() }),
});

// Workflow with steps
const ProcessOrder = Workflow.define({
  name: 'process-order',
  data: Type.Object({ orderId: Type.String() }),
  result: Type.Object({ processedAt: Type.Number() }),
}).steps(s => s
  .sequential(s.step('validate', Type.Object({ valid: Type.Boolean() })))
  .sequential(s.step('charge', Type.Object({ chargeId: Type.String() })))
  .parallel(
    s.step('notify', Type.Object({ sent: Type.Boolean() })),
    s.step('audit', Type.Object({ logged: Type.Boolean() }))
  )
);
```

### IWorkflowConsumer

```typescript
interface IWorkflowConsumer<TData, TResult, TSteps = Record<never, never>> {
  readonly steps?: {
    [K in keyof TSteps]?: StepHandler<TData, TSteps[K]>;
  };
  readonly onComplete: (ctx: WorkflowContext<TData>) => Promise<TResult> | TResult;
  readonly onError?: (ctx: WorkflowContext<TData>, error: Error) => Promise<void> | void;
}

interface StepHandler<TData, TOutput> {
  readonly execute: (ctx: StepContext<TData>) => Promise<TOutput> | TOutput;
  readonly rollback?: (ctx: StepContext<TData>) => Promise<void> | void;
}
```

### WorkflowContext

| Property | Type | Description |
|----------|------|-------------|
| `flowId` | `string` | Unique workflow execution ID |
| `data` | `TData` | Workflow input data |
| `results` | `Record<string, unknown>` | Accumulated step results |
| `log` | `Logger` | Structured logger |
| `meta` | `Record<string, unknown>` | Propagation metadata |
| `correlationId` | `string` | Correlation ID |

### StepContext

| Property | Type | Description |
|----------|------|-------------|
| `flowId` | `string` | Workflow execution ID |
| `data` | `TData` | Workflow input data |
| `results` | `TResults` | Accumulated step results |
| `log` | `Logger` | Structured logger |
| `meta` | `Record<string, unknown>` | Propagation metadata |
| `stepName` | `string` | Current step name |

### WorkflowExecutor (ctx.workflows)

```typescript
interface WorkflowExecutor {
  execute<TData, TResult>(
    workflow: WorkflowDefinition<TData, TResult>,
    data: TData,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowHandle<TResult>>;
}
```

**WorkflowExecuteOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `id` | `string` | UUID | Custom workflow ID (for idempotency) |
| `priority` | `number` | `0` | Priority (lower = higher) |
| `delay` | `number` | `0` | Delay before start (ms) |

**WorkflowHandle:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `id` | `string` | Workflow instance ID |
| `status` | `(): Promise<WorkflowStatus>` | Current status |
| `result` | `(): Promise<TResult>` | Wait for completion |
| `cancel` | `(): Promise<boolean>` | Cancel if running |

**WorkflowStatus:** `'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`

---

## @orijs/cache

Entity-based caching with singleflight, grace periods, and cascade invalidation.

### CacheEntityRegistry

Defines cacheable entities with scope and required parameters.

```typescript
import { CacheEntityRegistry } from '@orijs/cache';

const Entities = CacheEntityRegistry.create({
  User: { scope: 'account', requiredParams: ['accountUuid'] },
  Monitor: { scope: 'project', requiredParams: ['accountUuid', 'projectUuid'] },
});
```

### CacheService

The main caching interface. Injected as a provider.

| Method | Signature | Description |
|--------|-----------|-------------|
| `getOrSet` | `(config, params, factory): Promise<T>` | Get from cache or compute |
| `invalidate` | `(entityName, params): Promise<void>` | Invalidate entity cache |
| `invalidateAll` | `(entityName): Promise<void>` | Invalidate all entries for entity |

### CacheProvider Interface

The interface custom cache providers must implement.

```typescript
interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<number>;
  delMany(keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
```

### FactoryContext

Context passed to the factory function during cache miss.

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `skip()` | `never` | Don't cache, return undefined |
| `fail(message)` | `never` | Signal error, use stale if available |
| `staleValue` | `T \| undefined` | Stale value during grace period |
| `staleAge` | `number \| undefined` | Age of stale value (seconds) |

### InMemoryCacheProvider

Built-in in-memory cache provider. Suitable for development and testing.

```typescript
import { InMemoryCacheProvider } from '@orijs/cache';

const provider = new InMemoryCacheProvider();
```

---

## @orijs/websocket

WebSocket support with Bun's native WebSocket server and pluggable scaling providers.

### WebSocket Options

Configured via `app.websocket(provider?, options?)`.

### OriSocketRouter

Interface for WebSocket message routing.

```typescript
interface OriSocketRouter<TState, TSocket> {
  configure(route: SocketRouteBuilder<TState, TSocket>): void;
}
```

### SocketRouteBuilder

Fluent API for defining WebSocket routes.

| Method | Signature | Description |
|--------|-----------|-------------|
| `connectionGuard` | `(guard): this` | Guard that runs ONCE on upgrade |
| `guard` | `(guard): this` | Guard that runs per-message |
| `guards` | `(guards): this` | Replace all message guards |
| `clearGuards` | `(): this` | Clear message guards |
| `on` | `(messageType, handler, schema?): this` | Register message handler |

### SocketContext

Per-message context for socket handlers.

| Property | Type | Description |
|----------|------|-------------|
| `state` | `TState` | State from connection guards |
| `data` | `unknown` | Parsed message data |
| `messageType` | `string` | Message type being handled |
| `correlationId` | `string` | Correlation ID |
| `socketId` | `string` | Socket connection ID |
| `app` | `AppContext<TSocket>` | Application context with typed socket |

### SocketEmitter Interface

```typescript
interface SocketEmitter {
  publish(topic: string, message: string | ArrayBuffer): Promise<void>;
  send(socketId: string, message: string | ArrayBuffer): void;
  broadcast(message: string | ArrayBuffer): void;
  emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void>;
}
```

### WebSocketProvider Interface

Full interface for scaling providers.

```typescript
interface WebSocketProvider extends SocketEmitter, SocketLifecycle {
  subscribe(socketId: string, topic: string): void;
  unsubscribe(socketId: string, topic: string): void;
  disconnect(socketId: string): void;
  isConnected(socketId: string): boolean;
  getConnectionCount(): number;
  getTopicSubscriberCount(topic: string): number;
  setServer(server: BunServer): void;
}
```

### SocketMessage.define

Creates typed WebSocket message definitions.

```typescript
import { SocketMessage } from '@orijs/core';
import { Type } from '@orijs/validation';

const IncidentCreated = SocketMessage.define({
  name: 'incident.created',
  data: Type.Object({ uuid: Type.String(), title: Type.String() }),
});

// Usage: await socket.emit(IncidentCreated, 'account:123', { uuid: '...', title: '...' });
```

---

## @orijs/config

Environment-based configuration with validation.

### EnvConfigProvider

Reads configuration from environment variables.

```typescript
import { EnvConfigProvider } from '@orijs/config';

const config = new EnvConfigProvider();
const value = await config.get('DATABASE_URL');
const required = await config.getRequired('DATABASE_URL'); // throws if missing
```

### ValidatedConfig

Validates configuration at startup.

```typescript
import { ValidatedConfig } from '@orijs/config';

const config = new ValidatedConfig({
  DATABASE_URL: { required: true },
  PORT: { required: true, transform: Number },
  LOG_LEVEL: { required: false, default: 'info' },
});

await config.validate(); // Throws if required keys are missing
```

### NamespacedConfig / createConfigProvider

Creates namespaced configuration with type-safe access.

```typescript
import { createConfigProvider } from '@orijs/config';

const config = createConfigProvider({
  db: { url: 'DATABASE_URL', pool: { max: 'DB_POOL_MAX' } },
  redis: { host: 'REDIS_HOST', port: 'REDIS_PORT' },
});
```

---

## @orijs/mapper

SQL result to TypeScript object mapping.

### Mapper.defineTable

Defines table schemas for SQL result mapping.

```typescript
import { Mapper, field } from '@orijs/mapper';

const Tables = Mapper.defineTable({
  User: {
    tableName: 'user',
    uuid: field('uuid').string(),
    displayName: field('display_name').string().optional(),
    email: field('email').string(),
    createdAt: field('created_at').date(),
    isActive: field('is_active').boolean(),
    metadata: field('metadata').any(), // JSONB
  },
});
```

**Field types:**

| Method | Description |
|--------|-------------|
| `field(column).string()` | String field |
| `field(column).number()` | Number field |
| `field(column).boolean()` | Boolean field |
| `field(column).date()` | Date field (coerces from string/Date) |
| `field(column).any()` | Any type (JSONB, etc.) |
| `.optional()` | Makes field nullable |

### Mapper.for / .build

Creates a mapper for a specific table.

```typescript
const UserMapper = Mapper.for<User>(Tables.User).build();

// Map a single row
const user: User = UserMapper.map(row);

// Map multiple rows
const users: User[] = UserMapper.mapMany(rows);
```

**MapResult / MapOptions:**

```typescript
interface MapOptions {
  strict?: boolean; // Throw on missing columns (default: false)
}
```

---

## @orijs/logging

Pino-inspired structured logging with transports.

### Logger

```typescript
import { Logger } from '@orijs/logging';

const log = new Logger('MyService', { level: 'info', transports: [...] });
```

**Logger methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `debug` | `(msg, data?): void` | Debug level log |
| `info` | `(msg, data?): void` | Info level log |
| `warn` | `(msg, data?): void` | Warn level log |
| `error` | `(msg, data?): void` | Error level log |
| `fatal` | `(msg, data?): void` | Fatal level log |
| `child` | `(name): Logger` | Create child logger |
| `with` | `(context): Logger` | Create logger with additional context |
| `setMeta` | `(key, value): void` | Set metadata on context |

**Static methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `Logger.configure` | `(options): void` | Set global defaults |
| `Logger.reset` | `(): void` | Reset global state |
| `Logger.shutdown` | `(): Promise<void>` | Flush and close all transports |

### Transports

```typescript
import { consoleTransport, fileTransport, filterTransport, multiTransport } from '@orijs/logging';

consoleTransport(options?)   // Console output (colorize, JSON)
fileTransport(options)       // File output with rotation
filterTransport(options)     // Level-filtered transport
multiTransport(transports)   // Fan-out to multiple transports
```

---

## @orijs/test-utils

Testing utilities and infrastructure helpers.

### createBunTestPreload

Creates a Bun test preload setup function.

```typescript
import { createBunTestPreload } from '@orijs/test-utils';

const preload = createBunTestPreload({
  packageName: 'my-app',
  dependencies: ['redis'],
});

await preload();
```

### teardownBunTest

Cleans up test containers.

```typescript
import { teardownBunTest } from '@orijs/test-utils';

afterAll(() => teardownBunTest('my-app'));
```

### createRedisTestHelper

Creates a Redis test helper for Testcontainer-based testing.

```typescript
import { createRedisTestHelper } from '@orijs/test-utils';

const helper = createRedisTestHelper('my-app');
const redis = helper.createRedisClient();
```

### Async Helpers

| Function | Signature | Description |
|----------|-----------|-------------|
| `waitFor` | `(condition, options?): Promise<void>` | Poll sync condition |
| `waitForAsync` | `(condition, options?): Promise<void>` | Poll async condition |
| `withTimeout` | `(promise, timeoutMs, message?): Promise<T>` | Timeout wrapper |
| `delay` | `(ms): Promise<void>` | Simple delay |

**WaitForOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `timeout` | `number` | `5000` | Max wait time (ms) |
| `interval` | `number` | `50` | Poll interval (ms) |
| `message` | `string` | — | Custom timeout error message |

---

## @orijs/bullmq

BullMQ providers for distributed events and workflows.

### BullMQEventProvider

```typescript
import { BullMQEventProvider, Redis } from '@orijs/bullmq';

const redis = new Redis({ host: 'localhost', port: 6379 });
const provider = new BullMQEventProvider({ connection: redis });

Ori.create()
  .eventProvider(provider)
  .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
  .listen(3000);
```

### createBullMQWorkflowProvider

```typescript
import { createBullMQWorkflowProvider, Redis } from '@orijs/bullmq';

const redis = new Redis({ host: 'localhost', port: 6379 });
const provider = createBullMQWorkflowProvider({ connection: redis });

Ori.create()
  .workflowProvider(provider)
  .workflow(SendEmail).consumer(SendEmailWorkflow, [SmtpClient])
  .listen(3000);
```

---

## @orijs/cache-redis

Redis cache provider with dependency tracking.

### createRedisCacheProvider

```typescript
import { createRedisCacheProvider } from '@orijs/cache-redis';

const provider = createRedisCacheProvider({
  connection: { host: 'localhost', port: 6379 },
});

Ori.create()
  .cache(provider)
  .listen(3000);
```

**RedisCacheProviderOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `connection` | `Redis \| RedisConnectionOptions` | Redis connection or options |

---

## @orijs/websocket-redis

Redis WebSocket provider for horizontal scaling.

### createRedisWsProvider

```typescript
import { createRedisWsProvider } from '@orijs/websocket-redis';

const provider = createRedisWsProvider({
  connection: { host: 'localhost', port: 6379 },
});

Ori.create()
  .websocket(provider)
  .listen(3000);
```

**RedisWsProviderOptions:**

| Property | Type | Description |
|----------|------|-------------|
| `connection` | `RedisConnectionOptions` | Redis connection options |

---

[Previous: Migration from NestJS ←](./18-migration-from-nestjs.md) | [Back to Table of Contents →](./README.md)
