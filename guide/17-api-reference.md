# Chapter 17: API Reference

Quick reference for all OriJS packages, classes, and methods.

## @orijs/orijs

The main framework package.

### Ori

```typescript
import { Ori } from '@orijs/orijs';

const app = Ori.create(options?: ApplicationOptions);
```

### OriApplication

The main application class returned by `Ori.create()`.

| Method | Description |
|--------|-------------|
| `.provider(Class, deps?)` | Register a DI provider |
| `.providerWithToken(token, config)` | Register a provider with an injection token |
| `.controller(Class, deps?)` | Register an HTTP controller |
| `.globalGuard(Guard, deps?)` | Register a global guard |
| `.globalInterceptor(Interceptor, deps?)` | Register a global interceptor |
| `.consumer(Consumer, deps?)` | Register an event consumer |
| `.workflowConsumer(Consumer, deps?)` | Register a workflow step consumer |
| `.socketRouter(Router, deps?)` | Register a WebSocket socket router |
| `.use(extensionFn)` | Apply an extension function |
| `.useDeferred(extensionFn)` | Apply an extension function after config is ready |
| `.logger(options)` | Configure the logger |
| `.cors(options)` | Configure CORS |
| `.config(provider)` | Set configuration |
| `.configAsync(factory)` | Set async configuration |
| `.events(options)` | Configure the event system |
| `.workflows(options)` | Configure the workflow system |
| `.websocket(options?)` | Enable WebSocket support |
| `.listen(port, callback?)` | Start the HTTP server |
| `.stop()` | Stop the server gracefully |
| `.setShutdownTimeout(ms)` | Set graceful shutdown timeout |
| `.disableSignalHandling()` | Disable SIGINT/SIGTERM handling |
| `.getRoutes()` | Get all registered routes |
| `.getContainer()` | Get the DI container |
| `.context` | Get the AppContext |

### OriController

```typescript
interface OriController {
  configure(r: RouteBuilder): void;
}
```

### RouteBuilder

| Method | Description |
|--------|-------------|
| `.prefix(path)` | Set base path for all routes |
| `.guard(Guard)` | Add controller-level guard |
| `.interceptor(Interceptor)` | Add controller-level interceptor |
| `.get(path)` | Define a GET route |
| `.post(path)` | Define a POST route |
| `.put(path)` | Define a PUT route |
| `.patch(path)` | Define a PATCH route |
| `.delete(path)` | Define a DELETE route |

### RouteDefinition

Returned by `r.get()`, `r.post()`, etc.

| Method | Description |
|--------|-------------|
| `.guard(Guard)` | Add route-level guard |
| `.interceptor(Interceptor)` | Add route-level interceptor |
| `.validate({ body?, params?, query? })` | Add validation |
| `.handle(handler)` | Set the request handler |

### RequestContext

| Property | Type | Description |
|----------|------|-------------|
| `request` | `Request` | Raw Bun Request |
| `params` | `Record<string, string>` | Path parameters |
| `query` | `Record<string, string>` | Query parameters |
| `body` | `unknown` (typed with validation) | Parsed body |
| `headers` | `Headers` | Request headers |
| `state` | `TState` | Guard-set state |
| `log` | `Logger` | Request-scoped logger |
| `requestId` | `string` | Unique request ID |
| `response` | `ResponseFactory` | Response helpers |

### ResponseFactory

| Method | Status | Description |
|--------|--------|-------------|
| `.ok(data?)` | 200 | Success |
| `.created(data?)` | 201 | Resource created |
| `.noContent()` | 204 | No content |
| `.badRequest(message?)` | 400 | Bad request |
| `.unauthorized(message?)` | 401 | Unauthorized |
| `.forbidden(message?)` | 403 | Forbidden |
| `.notFound(message?)` | 404 | Not found |
| `.conflict(message?)` | 409 | Conflict |
| `.sse(generator)` | 200 | Server-Sent Events stream |

### OriGuard

```typescript
interface OriGuard<TState = unknown> {
  canActivate(ctx: RequestContext): Promise<boolean>;
}
```

### OriInterceptor

```typescript
interface OriInterceptor {
  intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response>;
}
```

### HttpException

```typescript
class HttpException extends Error {
  constructor(statusCode: number, message: string);
}
```

## @orijs/core

Core DI container and lifecycle.

### createToken

```typescript
function createToken<T>(name: string): InjectionToken<T>;
```

### Container

| Method | Description |
|--------|-------------|
| `.resolve(Class)` | Resolve a provider instance |
| `.validate()` | Validate the dependency graph |
| `.getRegisteredCount()` | Get number of registered providers |

### AppContext

| Property | Type | Description |
|----------|------|-------------|
| `log` | `Logger` | Application logger |
| `events` | `EventEmitter` | Event emitter |
| `workflows` | `WorkflowExecutor` | Workflow executor |
| `config` | `ConfigProvider` | Configuration |
| `sockets` | `SocketEmitter` | WebSocket publisher |

| Method | Description |
|--------|-------------|
| `.onStartup(hook)` | Register startup hook (FIFO) |
| `.onReady(hook)` | Register ready hook (FIFO) |
| `.onShutdown(hook)` | Register shutdown hook (LIFO) |

## @orijs/validation

TypeBox validation with OriJS helpers.

### Type (from TypeBox)

| Method | Creates |
|--------|---------|
| `Type.String(options?)` | String type |
| `Type.Number(options?)` | Number type |
| `Type.Integer(options?)` | Integer type |
| `Type.Boolean()` | Boolean type |
| `Type.Null()` | Null type |
| `Type.Array(schema, options?)` | Array type |
| `Type.Object(properties)` | Object type |
| `Type.Optional(schema)` | Optional property |
| `Type.Union(schemas)` | Union type |
| `Type.Literal(value)` | Literal type |
| `Type.Intersect(schemas)` | Intersection type |
| `Type.Transform(schema)` | Transform type |

### Params

| Method | Description |
|--------|-------------|
| `Params.uuid()` | UUID path parameter |

### Query

| Method | Description |
|--------|-------------|
| `Query.integer(options?)` | Integer query param (with coercion) |
| `Query.number(options?)` | Number query param (with coercion) |
| `Query.pagination()` | Page + limit params |

### Validation Functions

| Function | Description |
|----------|-------------|
| `validate(schema, data)` | Validate data, return result |
| `assertValid(schema, data)` | Validate data, throw on failure |

## @orijs/events

Type-safe event system.

### Event.define

```typescript
const MyEvent = Event.define({
  name: 'domain.action',
  schema: TypeBoxSchema,
});
```

### OriConsumer

```typescript
interface OriConsumer<TEvent> {
  event: TEvent;
  handle(ctx: EventContext<TEvent>): Promise<void>;
}
```

### EventContext

| Property | Type | Description |
|----------|------|-------------|
| `data` | `TPayload` | Event payload (typed) |
| `log` | `Logger` | Logger with event context |
| `traceId` | `string` | Distributed trace ID |
| `events` | `EventEmitter` | For emitting follow-up events |

## @orijs/workflows

Saga-pattern workflow orchestration.

### Workflow.define

```typescript
const MyWorkflow = Workflow.define({
  name: 'domain.workflow',
  input: TypeBoxSchema,
})
  .step('stepName', { schema: TypeBoxSchema })
  .parallel([
    { name: 'parallelStep1', schema: Schema1 },
    { name: 'parallelStep2', schema: Schema2 },
  ])
  .build();
```

### WorkflowStepConsumer

```typescript
interface WorkflowStepConsumer<TWorkflow, TStep> {
  workflow: TWorkflow;
  step: TStep;
  handle(ctx: WorkflowContext): Promise<TStepOutput>;
  compensate?(ctx: WorkflowContext): Promise<void>;
}
```

### WorkflowContext

| Property | Type | Description |
|----------|------|-------------|
| `input` | `TInput` | Workflow input (typed) |
| `log` | `Logger` | Logger with workflow context |
| `traceId` | `string` | Distributed trace ID |
| `stepResults` | `Map` | Results from previous steps |
| `stepResult` | `TOutput` | This step's result (in compensate) |

### WorkflowExecutor

| Method | Description |
|--------|-------------|
| `.execute(workflow, input)` | Start a workflow, returns FlowHandle |

## @orijs/cache

Entity-based caching.

### CacheEntityRegistry.create

```typescript
const registry = CacheEntityRegistry.create({
  entityName: {
    scopes: {
      scopeName: {
        ttl: number,         // TTL in seconds
        grace?: number,      // Grace period in seconds
        singleflight?: boolean,
      },
    },
  },
});
```

### CacheService

| Method | Description |
|--------|-------------|
| `.getOrSet(entity, scope, key, factory, options?)` | Get cached or compute |
| `.invalidate(entity, scope, key)` | Invalidate specific entry |
| `.invalidateEntity(entity, key)` | Invalidate all scopes for entity |
| `.invalidateByTag(tag)` | Invalidate all entries with tag |

### Factory Context

| Property/Method | Description |
|-----------------|-------------|
| `ctx.staleValue` | Previous value (in grace period) |
| `ctx.skip()` | Don't cache this result |
| `ctx.fail()` | Mark as failed, return stale if available |
| `ctx.log` | Logger |

## @orijs/websocket

WebSocket support.

### WebSocket Options

```typescript
app.websocket({
  path?: string,           // Default: '/ws'
  provider?: WebSocketProvider,
  upgrade?: (request: Request) => Promise<unknown | null>,
  handlers?: {
    open?(ws): void,
    message?(ws, data): void,
    close?(ws, code, reason): void,
    ping?(ws, data): void,
    pong?(ws, data): void,
    drain?(ws): void,
  },
});
```

### OriSocketRouter

```typescript
interface OriSocketRouter<TState> {
  configure(r: SocketRouteBuilder<TState>): void;
}
```

### SocketRouteBuilder

| Method | Description |
|--------|-------------|
| `.connectionGuard(Guard)` | Add connection-time guard |
| `.on(type, handler)` | Register message handler |

### SocketContext

| Property | Type | Description |
|----------|------|-------------|
| `state` | `TState` | Connection state (from guards) |
| `data` | `unknown` | Message payload |
| `ws` | `WebSocket` | WebSocket connection |
| `log` | `Logger` | Logger with socket context |

## @orijs/config

Configuration management.

### EnvConfig

```typescript
const config = EnvConfig.create({
  key: EnvConfig.string('ENV_VAR', { default?: string }),
  key: EnvConfig.integer('ENV_VAR', { default?: number }),
  key: EnvConfig.boolean('ENV_VAR', { default?: boolean }),
  key: EnvConfig.float('ENV_VAR', { default?: number }),
  key: EnvConfig.json('ENV_VAR', { default?: unknown }),
});
```

### ValidatedConfig

```typescript
const config = ValidatedConfig.create(TypeBoxSchema, data);
```

### NamespacedConfig

```typescript
const config = NamespacedConfig.create({
  namespace: EnvConfig.create({ ... }),
});
```

## @orijs/mapper

SQL result mapping.

### Mapper.defineTable

```typescript
const table = Mapper.defineTable('table_name', {
  property: Mapper.string('column_name'),
  property: Mapper.integer('column_name'),
  property: Mapper.float('column_name'),
  property: Mapper.boolean('column_name'),
  property: Mapper.date('column_name'),
  property: Mapper.uuid('column_name'),
  property: Mapper.json<T>('column_name'),
  property: Mapper.nullable('column_name', Mapper.string),
  property: Mapper.embedded({ ... }),
});
```

### Table Methods

| Method | Description |
|--------|-------------|
| `.createMapper()` | Create a mapper instance |

### Mapper Methods

| Method | Description |
|--------|-------------|
| `.pick(...fields)` | Select specific fields |
| `.join(name, table, options)` | Add a JOIN mapping |
| `.mapRows(rows)` | Map SQL rows to typed objects |

### MapResult

| Method | Description |
|--------|-------------|
| `.first()` | First row or null |
| `.firstOrThrow(message)` | First row or throw |
| `.isEmpty()` | Check if empty |

## @orijs/logging

Structured logging.

### Logger Options

```typescript
app.logger({
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
  transport: 'pretty' | 'json',
});
```

### Logger Methods

| Method | Level | Description |
|--------|-------|-------------|
| `.trace(msg, data?)` | 10 | Very verbose debug |
| `.debug(msg, data?)` | 20 | Debug information |
| `.info(msg, data?)` | 30 | Normal operation |
| `.warn(msg, data?)` | 40 | Warning |
| `.error(msg, data?)` | 50 | Error |
| `.fatal(msg, data?)` | 60 | Fatal error |

## @orijs/test-utils

Testing utilities.

### Mock Factories

| Function | Description |
|----------|-------------|
| `createMockRequestContext(options?)` | Create mock RequestContext |
| `createMockAppContext(options?)` | Create mock AppContext |
| `createMockEventContext(event, data)` | Create mock EventContext |
| `createMockWorkflowContext(workflow, step, input)` | Create mock WorkflowContext |

### Utilities

| Function | Description |
|----------|-------------|
| `disableSignalHandling()` | Prevent signal handler registration in tests |

## @orijs/bullmq

BullMQ providers.

### createBullMQProvider

```typescript
const provider = createBullMQProvider({
  connection: { host: string, port: number },
  defaultJobOptions?: {
    attempts?: number,
    backoff?: { type: 'exponential' | 'fixed', delay: number },
    removeOnComplete?: { age: number },
    removeOnFail?: { age: number },
  },
});
```

### createBullMQWorkflowProvider

```typescript
const provider = createBullMQWorkflowProvider({
  connection: { host: string, port: number },
});
```

[Previous: Migration from NestJS ←](./16-migration-from-nestjs.md) | [Back to Table of Contents →](./README.md)
