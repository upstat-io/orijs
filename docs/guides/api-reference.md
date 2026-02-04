# API Reference

Complete API documentation for OriJS.

---

## Core APIs

### Ori

Static factory for creating applications.

```typescript
const app = Ori.create();
```

---

### Application

Main application class with fluent configuration API.

#### Configuration Methods

| Method                  | Signature                                                                   | Description                              |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `.config()`             | `(provider: ConfigProvider) => this`                                        | Set configuration provider               |
| `.logger()`             | `(options: AppLoggerOptions) => this`                                       | Configure logging                        |
| `.guard()`              | `(guard: GuardClass) => this`                                               | Add global guard                         |
| `.intercept()`          | `(interceptor: InterceptorClass) => this`                                   | Add global interceptor                   |
| `.provider()`           | `(service: Class, deps?: Constructor[], opts?: ProviderOptions) => this`    | Register service                         |
| `.providerInstance()`   | `(token: InjectionToken, instance: any) => this`                            | Register pre-created instance            |
| `.providerWithTokens()` | `(service: Class, deps: InjectionToken[], opts?: ProviderOptions) => this`  | Register service with token dependencies |
| `.use()`                | `(extension: (app: Application) => Application) => this`                    | Apply extension function                 |
| `.cache()`              | `(provider?: CacheProvider) => this`                                        | Configure cache system                   |
| `.events()`             | `(registry: BuiltEventRegistry, provider?: EventProvider) => this`          | Configure events                         |
| `.onEvent()`            | `(name: string, handler: EventHandler) => this`                             | Register inline event handler            |
| `.eventHandler()`       | `(handlerClass: Class, deps: Constructor[]) => this`                        | Register event handler class             |
| `.workflows()`          | `(registry: BuiltWorkflowRegistry, provider?: WorkflowProvider) => this`    | Configure workflows                      |
| `.websocket()`          | `<TEmitter, TData>(provider?, options?) => this`                            | Configure WebSocket support              |
| `.onWebSocket()`        | `<TData>(handlers: WebSocketHandlers<TData>) => this`                       | Register WebSocket event handlers        |
| `.socketRouter()`       | `(router: SocketRouterClass, deps?: Constructor[]) => this`                 | Register socket router with DI           |
| `.controller()`         | `(path: string, controller: ControllerClass, deps?: Constructor[]) => this` | Register controller                      |

#### Lifecycle Methods

| Method                     | Signature                                                     | Description                     |
| -------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `.listen()`                | `(port: number, callback?: () => void) => Promise<BunServer>` | Start server                    |
| `.stop()`                  | `() => Promise<void>`                                         | Stop server gracefully          |
| `.disableSignalHandling()` | `() => this`                                                  | Disable SIGTERM/SIGINT handlers |

#### Accessor Properties & Methods

| Property/Method              | Signature                         | Description                            |
| ---------------------------- | --------------------------------- | -------------------------------------- |
| `.context`                   | `AppContext`                      | Application context (always available) |
| `.getContainer()`            | `() => Container`                 | Get DI container                       |
| `.getAppContext()`           | `() => AppContext`                | **Deprecated**: Use `.context` instead |
| `.getCacheService()`         | `() => CacheService \| null`      | Get cache service                      |
| `.getEventSystem()`          | `() => EventSystem \| null`       | Get event system                       |
| `.getWorkflowProvider()`     | `() => WorkflowProvider \| null`  | Get workflow provider                  |
| `.getWebSocketCoordinator()` | `() => SocketCoordinator \| null` | Get WebSocket coordinator              |
| `.getWebSocketProvider()`    | `() => WebSocketProvider \| null` | Get WebSocket provider                 |
| `.getSocketEmitter()`        | `<T>() => T`                      | Get typed socket emitter               |
| `.getRoutes()`               | `() => CompiledRoute[]`           | Get all registered routes              |

The `context` property is available immediately after `Ori.create()` - you don't need to wait for `listen()`. This allows registering lifecycle hooks during setup:

```typescript
const app = Ori.create()
	.use((app) => {
		app.context.onShutdown(async () => {
			await cleanup();
		});
		return app;
	})
	.listen(3000);
```

---

### Container

Dependency injection container.

| Method                     | Signature                                                           | Description                      |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `constructor`              | `(options?: ContainerOptions) => Container`                         | Create container                 |
| `.register()`              | `(service: Class, deps?: Constructor[]) => void`                    | Register service                 |
| `.registerWithExternal()`  | `(service: Class, deps: Constructor[], external: string[]) => void` | Register with npm deps           |
| `.registerWithTokenDeps()` | `(service: Class, deps: InjectionToken[]) => void`                  | Register with token dependencies |
| `.registerInstance()`      | `(token: InjectionToken, instance: any) => void`                    | Register instance                |
| `.resolve()`               | `<T>(token: InjectionToken<T>) => T`                                | Resolve service sync             |
| `.resolveAsync()`          | `<T>(token: InjectionToken<T>) => Promise<T>`                       | Resolve service async            |
| `.validate()`              | `() => void`                                                        | Validate dependency graph        |
| `.has()`                   | `(token: InjectionToken) => boolean`                                | Check if registered              |
| `.clear()`                 | `() => void`                                                        | Clear all registrations          |
| `.clearInstances()`        | `() => void`                                                        | Clear instances only             |
| `.setResolutionTimeout()`  | `(timeoutMs: number) => void`                                       | Set timeout warning threshold    |
| `.getRegisteredCount()`    | `() => number`                                                      | Get registration count           |
| `.getRegisteredNames()`    | `() => string[]`                                                    | Get registered service names     |

---

### Injection Tokens

Utilities for creating typed injection tokens (for named providers).

#### createToken

Creates a typed injection token for registering multiple instances of the same type.

```typescript
import { createToken } from '@orijs/core';

const HotCache = createToken<CacheService>('HotCache');
const ColdCache = createToken<CacheService>('ColdCache');
```

| Parameter   | Type       | Description                                       |
| ----------- | ---------- | ------------------------------------------------- |
| `name`      | `string`   | Token name (used in error messages and debugging) |
| **Returns** | `Token<T>` | Typed symbol token                                |

#### isToken

Type guard to check if a value is an injection token.

```typescript
import { isToken } from '@orijs/core';

isToken(Symbol('test')); // true
isToken(MyService); // false (it's a constructor)
isToken('SQL'); // false (string tokens are also valid but not symbols)
```

| Parameter   | Type      | Description                     |
| ----------- | --------- | ------------------------------- |
| `value`     | `unknown` | Value to check                  |
| **Returns** | `boolean` | True if value is a symbol token |

#### Token Type

```typescript
type Token<T> = symbol & { readonly __type?: T };
```

The `Token<T>` type is a symbol with phantom type information for TypeScript inference.

---

### AppContext

Application-level context. Generic type parameter `TSocket` for typed socket access.

```typescript
class AppContext<TSocket extends SocketEmitter = SocketEmitter>
```

| Property/Method   | Type/Signature                               | Description                   |
| ----------------- | -------------------------------------------- | ----------------------------- |
| `log`             | `Logger`                                     | Logger instance               |
| `config`          | `ConfigProvider`                             | Configuration provider        |
| `event`           | `EventSystem \| undefined`                   | Event system                  |
| `workflows`       | `WorkflowExecutor`                           | Workflow executor             |
| `hasWorkflows`    | `boolean`                                    | Check if workflows configured |
| `socket`          | `TSocket`                                    | Socket emitter (typed)        |
| `hasWebSocket`    | `boolean`                                    | Check if WebSocket configured |
| `phase`           | `LifecyclePhase`                             | Current lifecycle phase       |
| `.onStartup()`    | `(hook: LifecycleHook) => void`              | Register startup hook         |
| `.onReady()`      | `(hook: LifecycleHook) => void`              | Register ready hook           |
| `.onShutdown()`   | `(hook: LifecycleHook) => void`              | Register shutdown hook        |
| `.resolve()`      | `<T>(service: Constructor<T>) => T`          | Resolve service sync          |
| `.resolveAsync()` | `<T>(service: Constructor<T>) => Promise<T>` | Resolve service async         |

---

## Controller APIs

### RouteBuilder

Fluent API for defining routes.

| Method                 | Signature                                    | Description             |
| ---------------------- | -------------------------------------------- | ----------------------- |
| `.get()`               | `(path: string, handler: Handler) => this`   | Define GET route        |
| `.post()`              | `(path: string, handler: Handler) => this`   | Define POST route       |
| `.put()`               | `(path: string, handler: Handler) => this`   | Define PUT route        |
| `.patch()`             | `(path: string, handler: Handler) => this`   | Define PATCH route      |
| `.delete()`            | `(path: string, handler: Handler) => this`   | Define DELETE route     |
| `.guard()`             | `(guard: GuardClass) => this`                | Add guard               |
| `.guards()`            | `(guards: GuardClass[]) => this`             | Replace guards          |
| `.clearGuards()`       | `() => this`                                 | Remove all guards       |
| `.intercept()`         | `(interceptor: InterceptorClass) => this`    | Add interceptor         |
| `.interceptors()`      | `(interceptors: InterceptorClass[]) => this` | Replace interceptors    |
| `.clearInterceptors()` | `() => this`                                 | Remove all interceptors |
| `.pipe()`              | `(pipe: PipeClass) => this`                  | Add pipe                |

---

### RequestContext

Per-request context. Generic type parameters for state and socket emitter.

```typescript
class RequestContext<TState extends object = Record<string, unknown>, TSocket extends SocketEmitter = SocketEmitter>
```

| Property/Method | Type/Signature                          | Description                  |
| --------------- | --------------------------------------- | ---------------------------- |
| `request`       | `Request`                               | Native Web Request           |
| `params`        | `Record<string, string>`                | Path parameters              |
| `query`         | `Record<string, string \| string[]>`    | Query parameters (lazy)      |
| `state`         | `TState`                                | Type-safe state from guards  |
| `log`           | `Logger`                                | Request-scoped logger        |
| `correlationId` | `string`                                | Request correlation ID       |
| `event`         | `EventSystem \| undefined`              | Event system (deprecated)    |
| `events`        | `EventEmitter`                          | Request-bound event emitter  |
| `workflows`     | `WorkflowExecutor`                      | Request-bound workflow exec  |
| `socket`        | `TSocket`                               | Request-bound socket emitter |
| `signal`        | `AbortSignal`                           | Request abort signal         |
| `app`           | `AppContext`                            | Parent application context   |
| `.json<T>()`    | `() => Promise<T>`                      | Parse JSON body              |
| `.text()`       | `() => Promise<string>`                 | Parse text body              |
| `.set()`        | `<K>(key: K, value: TState[K]) => void` | Set state value              |
| `.get()`        | `<K>(key: K) => TState[K]`              | Get state value              |

---

### ResponseFactory

Helper for creating HTTP responses.

| Method                   | Signature                                                    | Description               |
| ------------------------ | ------------------------------------------------------------ | ------------------------- |
| `.ok()`                  | `(data?: unknown) => Response`                               | 200 OK                    |
| `.created()`             | `(data?: unknown) => Response`                               | 201 Created               |
| `.noContent()`           | `() => Response`                                             | 204 No Content            |
| `.badRequest()`          | `(message?: string) => Response`                             | 400 Bad Request           |
| `.unauthorized()`        | `(message?: string) => Response`                             | 401 Unauthorized          |
| `.forbidden()`           | `(message?: string) => Response`                             | 403 Forbidden             |
| `.notFound()`            | `(message?: string) => Response`                             | 404 Not Found             |
| `.conflict()`            | `(message?: string) => Response`                             | 409 Conflict              |
| `.unprocessableEntity()` | `(message?: string) => Response`                             | 422 Unprocessable Entity  |
| `.internalServerError()` | `(message?: string) => Response`                             | 500 Internal Server Error |
| `.json()`                | `(data: unknown, status?: number) => Response`               | Custom JSON response      |
| `.sse()`                 | `(stream: ReadableStream, options?: SseOptions) => Response` | Server-Sent Events        |

---

## Event APIs

### EventRegistry

Builder for type-safe event definitions.

| Method                   | Signature                    | Description             |
| ------------------------ | ---------------------------- | ----------------------- |
| `EventRegistry.create()` | `() => EventRegistryBuilder` | Create registry builder |
| `.event<T>()`            | `(name: string) => this`     | Register event type     |
| `.build()`               | `() => BuiltEventRegistry`   | Build registry          |

---

### EventSystem

Event emission and subscription.

| Method         | Signature                                                            | Description        |
| -------------- | -------------------------------------------------------------------- | ------------------ |
| `.emit()`      | `(name: string, data: T, metadata?: EventMetadata) => Promise<void>` | Emit event         |
| `.subscribe()` | `(name: string, handler: EventHandler) => EventSubscription`         | Subscribe to event |

---

### EventContext

Context for event handlers.

| Property   | Type            | Description                                    |
| ---------- | --------------- | ---------------------------------------------- |
| `data`     | `TPayload`      | Event payload                                  |
| `metadata` | `EventMetadata` | eventId, correlationId, causationId, timestamp |
| `log`      | `Logger`        | Logger with trace propagation                  |

---

### EventIdempotency

Prevent duplicate event processing.

| Method          | Signature                                                  | Description                |
| --------------- | ---------------------------------------------------------- | -------------------------- |
| `.tryAcquire()` | `(eventName: string, eventId: string) => Promise<boolean>` | Check if already processed |

---

## Workflow APIs

### WorkflowRegistry

Builder for workflow definitions.

| Method                      | Signature                                | Description             |
| --------------------------- | ---------------------------------------- | ----------------------- |
| `WorkflowRegistry.create()` | `() => WorkflowRegistryBuilder`          | Create registry builder |
| `.workflow()`               | `(workflowClass: WorkflowClass) => this` | Register workflow       |
| `.build()`                  | `() => BuiltWorkflowRegistry`            | Build registry          |

---

### WorkflowBuilder

Builder for defining workflow steps.

| Method    | Signature                                                                  | Description |
| --------- | -------------------------------------------------------------------------- | ----------- |
| `.step()` | `(name: string, handler: StepHandler, rollback?: RollbackHandler) => this` | Define step |

---

### WorkflowExecutor (via AppContext.workflows)

Start and manage workflows.

| Method     | Signature                                                     | Description    |
| ---------- | ------------------------------------------------------------- | -------------- |
| `.start()` | `(name: string, data: TData) => Promise<FlowHandle<TResult>>` | Start workflow |

---

### FlowHandle

Handle for running workflow.

| Method      | Signature                | Description         |
| ----------- | ------------------------ | ------------------- |
| `.result()` | `() => Promise<TResult>` | Wait for completion |
| `.status()` | `() => FlowStatus`       | Get current status  |

---

### WorkflowContext

Context for step handlers.

| Property      | Type                      | Description                 |
| ------------- | ------------------------- | --------------------------- |
| `data`        | `TData`                   | Workflow input data         |
| `log`         | `Logger`                  | Logger instance             |
| `stepResults` | `Record<string, unknown>` | Results from previous steps |

---

## WebSocket APIs

### SocketEmitter

Base interface for socket emitters (ctx.socket, AppContext.socket).

| Method         | Signature                                                          | Description                  |
| -------------- | ------------------------------------------------------------------ | ---------------------------- |
| `.publish()`   | `(topic: string, message: string \| ArrayBuffer) => Promise<void>` | Publish to topic subscribers |
| `.send()`      | `(socketId: string, message: string \| ArrayBuffer) => boolean`    | Send to specific socket      |
| `.broadcast()` | `(message: string \| ArrayBuffer) => void`                         | Broadcast to all sockets     |

---

### WebSocketProvider

Full provider interface extending SocketEmitter and SocketLifecycle.

| Method                       | Signature                                   | Description                |
| ---------------------------- | ------------------------------------------- | -------------------------- |
| `.subscribe()`               | `(socketId: string, topic: string) => void` | Subscribe socket to topic  |
| `.unsubscribe()`             | `(socketId: string, topic: string) => void` | Unsubscribe from topic     |
| `.disconnect()`              | `(socketId: string) => void`                | Disconnect socket          |
| `.isConnected()`             | `(socketId: string) => boolean`             | Check if connected         |
| `.getConnectionCount()`      | `() => number`                              | Get total connections      |
| `.getTopicSubscriberCount()` | `(topic: string) => number`                 | Get topic subscriber count |
| `.setServer()`               | `(server: BunServer) => void`               | Set Bun server reference   |
| `.start()`                   | `() => Promise<void>`                       | Start provider             |
| `.stop()`                    | `() => Promise<void>`                       | Stop provider              |

---

### SocketCoordinator

Coordinates WebSocket connections and subscriptions.

| Method                    | Signature                                                              | Description             |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `.addConnection()`        | `<TData>(ws: WebSocketConnection<TData>) => void`                      | Track new connection    |
| `.removeConnection()`     | `(socketId: string) => void`                                           | Remove connection       |
| `.subscribeToTopic()`     | `(socketId: string, topic: string) => void`                            | Subscribe to topic      |
| `.unsubscribeFromTopic()` | `(socketId: string, topic: string) => void`                            | Unsubscribe from topic  |
| `.getConnection()`        | `<TData>(socketId: string) => WebSocketConnection<TData> \| undefined` | Get connection          |
| `.getTopicSubscribers()`  | `(topic: string) => WebSocketConnection<unknown>[]`                    | Get topic subscribers   |
| `.getAllConnections()`    | `() => WebSocketConnection<unknown>[]`                                 | Get all connections     |
| `.getConnectionCount()`   | `() => number`                                                         | Get connection count    |
| `.getProvider()`          | `() => WebSocketProvider`                                              | Get underlying provider |

---

### WebSocketConnection

Bun WebSocket connection with typed data.

| Property/Method  | Type/Signature                             | Description            |
| ---------------- | ------------------------------------------ | ---------------------- |
| `data.socketId`  | `string`                                   | Unique connection ID   |
| `data.data`      | `TData`                                    | User data from upgrade |
| `data.topics`    | `Set<string>`                              | Subscribed topics      |
| `.subscribe()`   | `(topic: string) => void`                  | Subscribe to topic     |
| `.unsubscribe()` | `(topic: string) => void`                  | Unsubscribe from topic |
| `.send()`        | `(message: string \| ArrayBuffer) => void` | Send message           |
| `.close()`       | `(code?: number, reason?: string) => void` | Close connection       |
| `readyState`     | `number`                                   | Connection state       |
| `remoteAddress`  | `string`                                   | Client IP address      |

---

### WebSocketHandlers

Event handlers for onWebSocket().

| Handler   | Signature                                                                                 | Description       |
| --------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `open`    | `(ws: WebSocketConnection<TData>) => void \| Promise<void>`                               | Connection opened |
| `message` | `(ws: WebSocketConnection<TData>, msg: string \| ArrayBuffer) => void \| Promise<void>`   | Message received  |
| `close`   | `(ws: WebSocketConnection<TData>, code: number, reason: string) => void \| Promise<void>` | Connection closed |
| `ping`    | `(ws: WebSocketConnection<TData>, data: Buffer) => void \| Promise<void>`                 | Ping received     |
| `pong`    | `(ws: WebSocketConnection<TData>, data: Buffer) => void \| Promise<void>`                 | Pong received     |
| `drain`   | `(ws: WebSocketConnection<TData>) => void \| Promise<void>`                               | Buffer drained    |

---

### InProcWsProvider

In-process WebSocket provider for single-instance deployments.

```typescript
import { InProcWsProvider, createInProcWsProvider } from '@orijs/websocket';

// Via constructor
const provider = new InProcWsProvider({ logger });

// Via factory function
const provider = createInProcWsProvider({ logger });
```

---

### RequestBoundSocketEmitter

Request-bound wrapper with correlation ID.

| Property        | Type     | Description            |
| --------------- | -------- | ---------------------- |
| `correlationId` | `string` | Request correlation ID |

Methods are same as SocketEmitter (publish, send, broadcast).

---

### MessageRegistry

Opinionated message handler registry with schema validation.

```typescript
import { MessageRegistry, JoinRoom, LeaveRoom } from '@orijs/websocket';

const registry = new MessageRegistry()
	.on(JoinRoom, (ws, data) => ws.subscribe(data.room))
	.on(LeaveRoom, (ws, data) => ws.unsubscribe(data.room));
```

| Method                  | Signature                                                                           | Description                   |
| ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `constructor`           | `(options?: { logger?: Logger }) => MessageRegistry`                                | Create registry               |
| `.on()`                 | `<TData>(message: ServerMessageDefinition<TData>, handler: MessageHandler) => this` | Register handler              |
| `.has()`                | `(type: string) => boolean`                                                         | Check if handler exists       |
| `.getRegisteredTypes()` | `() => string[]`                                                                    | Get all registered type names |
| `.handle()`             | `(ws: ServerWebSocket, type: string, data: unknown) => Promise<HandleResult>`       | Handle incoming message       |

**HandleResult:**

```typescript
type HandleResult =
	| { handled: true }
	| { handled: false; reason: 'unknown_type' | 'validation_failed'; details?: string };
```

---

### ServerMessage

Factory for creating server-side message definitions.

```typescript
import { ServerMessage } from '@orijs/websocket';
import { Type } from '@orijs/validation';

const UpdateStatus = ServerMessage.define({
	name: 'status.update',
	data: Type.Object({
		status: Type.String(),
		timestamp: Type.Number()
	})
});
```

| Method      | Signature                                                                                      | Description    |
| ----------- | ---------------------------------------------------------------------------------------------- | -------------- |
| `.define()` | `<T extends TSchema>(config: { name: string; data: T }) => ServerMessageDefinition<Static<T>>` | Define message |

**Built-in Control Messages:**

| Export      | Type Name    | Data Schema        |
| ----------- | ------------ | ------------------ |
| `JoinRoom`  | `room.join`  | `{ room: string }` |
| `LeaveRoom` | `room.leave` | `{ room: string }` |
| `Heartbeat` | `heartbeat`  | `{}`               |

---

### OriSocketRouter

Interface for socket routers with organized message handling.

```typescript
interface OriSocketRouter<TState extends object = Record<string, unknown>> {
	configure(route: SocketRouteBuilder<TState>): void;
}
```

---

### SocketRouteBuilder

Fluent API for defining socket routes within a router.

| Method               | Signature                                                          | Description                          |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `.connectionGuard()` | `(guard: SocketGuardClass) => this`                                | Add guard that runs ONCE on connect  |
| `.guard()`           | `(guard: SocketGuardClass) => this`                                | Add guard that runs per-message      |
| `.on()`              | `(type: string, handler: SocketHandler, schema?: TSchema) => this` | Register message handler with schema |

---

### SocketContext

Per-message context for socket handlers.

```typescript
class SocketContext<TState extends object = Record<string, unknown>, TData = unknown>
```

| Property/Method  | Type/Signature                           | Description                   |
| ---------------- | ---------------------------------------- | ----------------------------- |
| `state`          | `TState`                                 | State from guards (type-safe) |
| `data`           | `unknown`                                | Raw message data              |
| `ws`             | `WebSocketConnection<TData>`             | WebSocket connection          |
| `socketId`       | `string`                                 | Unique connection ID          |
| `userData`       | `TData`                                  | Data from upgrade handler     |
| `messageType`    | `string`                                 | Type of message being handled |
| `correlationId`  | `string`                                 | Request correlation ID        |
| `log`            | `Logger`                                 | Socket-scoped logger          |
| `app`            | `AppContext`                             | Application context           |
| `events`         | `EventEmitter`                           | Request-bound event emitter   |
| `workflows`      | `WorkflowExecutor`                       | Request-bound workflow exec   |
| `socket`         | `SocketEmitter`                          | Request-bound socket emitter  |
| `.set()`         | `<K>(key: K, value: TState[K]) => void`  | Set state value               |
| `.get()`         | `<K>(key: K) => TState[K]`               | Get state value               |
| `.json<T>()`     | `() => T`                                | Parse/cast message data       |
| `.send()`        | `(data: unknown) => void`                | Send to this client           |
| `.subscribe()`   | `(topic: string) => void`                | Subscribe to topic            |
| `.unsubscribe()` | `(topic: string) => void`                | Unsubscribe from topic        |
| `.publish()`     | `(topic: string, data: unknown) => void` | Publish to topic              |

---

### SocketGuard

Guard interface for socket authentication/authorization.

```typescript
interface SocketGuard {
	canActivate(ctx: SocketContext): boolean | Promise<boolean>;
}
```

---

### Application.socketRouter()

Register a socket router with dependency injection.

```typescript
app.socketRouter(RouterClass, [Dependency1, Dependency2]);
```

| Parameter | Type                | Description                                    |
| --------- | ------------------- | ---------------------------------------------- |
| `router`  | `SocketRouterClass` | Router class implementing `OriSocketRouter`    |
| `deps`    | `Constructor[]`     | Dependencies to inject into router constructor |

---

## Cache APIs

### Cache Builder

| Method         | Signature                                      | Description        |
| -------------- | ---------------------------------------------- | ------------------ |
| `Cache.for()`  | `(entity: EntityDef) => CacheBuilderForEntity` | Start cache config |
| `.ttl()`       | `(duration: Duration) => CacheBuilderWithTtl`  | Set TTL (required) |
| `.grace()`     | `(duration: Duration) => this`                 | Set grace period   |
| `.dependsOn()` | `(entity: EntityDef) => this`                  | Add dependency     |
| `.build()`     | `() => Readonly<CacheConfig>`                  | Build config       |

---

### CacheService

| Method          | Signature                                                                          | Description             |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `.getOrSet()`   | `<T>(config: CacheConfig, params: TParams, fetch: () => Promise<T>) => Promise<T>` | Get with fallback       |
| `.invalidate()` | `(entity: EntityDef, params: TParams) => Promise<void>`                            | Invalidate with cascade |

---

## Logging APIs

### Logger

| Method               | Signature                                                     | Description   |
| -------------------- | ------------------------------------------------------------- | ------------- |
| `constructor`        | `(name: string, options?: LoggerOptions) => Logger`           | Create logger |
| `.debug()`           | `(message: string, fields?: Record<string, unknown>) => void` | Log debug     |
| `.info()`            | `(message: string, fields?: Record<string, unknown>) => void` | Log info      |
| `.warn()`            | `(message: string, fields?: Record<string, unknown>) => void` | Log warning   |
| `.error()`           | `(message: string, fields?: Record<string, unknown>) => void` | Log error     |
| `Logger.configure()` | `(options: LoggerGlobalOptions) => void`                      | Global config |

---

### Transports

| Transport          | Constructor                                   | Description           |
| ------------------ | --------------------------------------------- | --------------------- |
| `ConsoleTransport` | `new ConsoleTransport()`                      | stdout with colors    |
| `FileTransport`    | `new FileTransport(path: string)`             | Rotating log files    |
| `FilterTransport`  | `new FilterTransport(options)`                | Level-based filtering |
| `MultiTransport`   | `new MultiTransport(transports: Transport[])` | Fan-out               |

---

## Config APIs

### EnvConfig

| Method           | Signature                                                          | Description        |
| ---------------- | ------------------------------------------------------------------ | ------------------ |
| `constructor`    | `(schema: EnvSchema) => EnvConfig`                                 | Create config      |
| `.get()`         | `(key: string) => Promise<string \| undefined>`                    | Get optional value |
| `.getRequired()` | `(key: string) => Promise<string>`                                 | Get required value |
| `.loadKeys()`    | `(keys: string[]) => Promise<Record<string, string \| undefined>>` | Load multiple keys |

---

### ValidatedConfig

| Method        | Signature                                                                 | Description             |
| ------------- | ------------------------------------------------------------------------- | ----------------------- |
| `constructor` | `(provider: ConfigProvider, schema: TSchema) => ValidatedConfig<TSchema>` | Create validated config |
| `.loadKeys()` | `(keys: string[]) => Promise<Static<TSchema>>`                            | Load and validate       |

---

### NamespacedConfig

| Method        | Signature                                                        | Description              |
| ------------- | ---------------------------------------------------------------- | ------------------------ |
| `constructor` | `(provider: ConfigProvider, prefix: string) => NamespacedConfig` | Create namespaced config |

---

## Type Definitions

### Core Types

```typescript
type Constructor<T = any> = new (...args: any[]) => T;

type Token<T> = symbol & { readonly __type?: T };

type InjectionToken<T = unknown> = Constructor<T> | Token<T> | string;

type LifecycleHook = () => void | Promise<void>;

type LifecyclePhase = 'created' | 'bootstrapped' | 'starting' | 'ready' | 'stopping' | 'stopped';

type Handler = (ctx: RequestContext) => Response | Promise<Response>;
```

### Configuration Types

```typescript
interface ProviderOptions {
	eager?: boolean; // Default: false
}

interface AppLoggerOptions {
	level?: 'debug' | 'info' | 'warn' | 'error';
	transports?: Transport[];
	clearConsole?: boolean;
}

interface ApplicationOptions {
	container?: Container;
	responseFactory?: ResponseFactory;
}

interface ContainerOptions {
	logger?: Logger;
}
```

### Event Types

```typescript
interface EventMetadata {
	eventId: string;
	correlationId?: string;
	causationId?: string;
	timestamp: number;
}

type EventHandler<T = unknown> = (ctx: EventContext<T>) => void | Promise<void>;
```

### Workflow Types

```typescript
type FlowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolling_back';

type StepHandler<TData = unknown> = (ctx: WorkflowContext<TData>) => unknown | Promise<unknown>;

type RollbackHandler = (ctx: WorkflowContext, stepResult: unknown) => void | Promise<void>;
```

### Cache Types

```typescript
interface EntityDef {
	name: string;
}

type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`;

interface CacheConfig {
	entity: EntityDef;
	ttl: number;
	grace?: number;
	dependencies?: EntityDef[];
}
```

---

## Interfaces

### OriController

```typescript
interface OriController<TState = unknown> {
	configure(router: RouteBuilder<TState>): void;
}
```

### Guard

```typescript
interface Guard {
	canActivate(ctx: RequestContext): boolean | Promise<boolean>;
}
```

### Interceptor

```typescript
interface Interceptor {
	intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response>;
}
```

### Pipe

```typescript
interface Pipe {
	transform(ctx: RequestContext): void | Promise<void>;
}
```

### ConfigProvider

```typescript
interface ConfigProvider {
	get(key: string): Promise<string | undefined>;
	getRequired(key: string): Promise<string>;
	loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
```

---

## Duration Helpers

| Format  | Example | Milliseconds |
| ------- | ------- | ------------ |
| Seconds | `'30s'` | 30,000       |
| Minutes | `'5m'`  | 300,000      |
| Hours   | `'1h'`  | 3,600,000    |
| Days    | `'7d'`  | 604,800,000  |
