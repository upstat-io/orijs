# Provider Contracts

Technical reference for all provider interfaces across the OriJS framework.

Each provider follows the **Interface Segregation Principle (ISP)**: a single implementation class is split into multiple interfaces so that consumers only depend on what they use. The pattern is:

| Interface Role | Who Uses It | What It Contains |
|---|---|---|
| **Consumer-facing** | Services, business code | Operational methods only (emit, get, set) |
| **Framework-facing** | Application lifecycle | start/stop, registration hooks |
| **Provider** | Implementation classes | Combines both (extends consumer + framework) |

Source: All provider types live in their respective packages under `packages/<name>/src/types.ts` (or `<name>.types.ts`).

---

## Table of Contents

1. [EventProvider](#1-eventprovider)
2. [WorkflowProvider](#2-workflowprovider)
3. [CacheProvider](#3-cacheprovider)
4. [WebSocketProvider](#4-websocketprovider)
5. [ConfigProvider](#5-configprovider)
6. [Guard](#6-guard)
7. [Interceptor](#7-interceptor)
8. [Pipe](#8-pipe)
9. [SocketGuard](#9-socketguard)

---

## 1. EventProvider

**Source**: `packages/events/src/event-provider.types.ts`

The event system uses three interfaces following ISP:

```
EventEmitter       (consumer-facing)
EventLifecycle     (framework-facing)
EventProvider      extends EventEmitter + EventLifecycle  (implementation)
```

### 1.1 EventEmitter (Consumer-Facing)

Services inject this interface. It provides emit and subscribe -- nothing else.

```typescript
interface EventEmitter<TEventNames extends string = string> {
  emit<TReturn = void>(
    eventName: TEventNames,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions
  ): EventSubscription<TReturn>;

  subscribe<TPayload = unknown, TReturn = void>(
    eventName: TEventNames,
    handler: EventHandlerFn<TPayload, TReturn>
  ): void | Promise<void>;
}
```

**Method: `emit`**

| Parameter | Type | Description |
|---|---|---|
| `eventName` | `TEventNames` | Event name to emit to |
| `payload` | `unknown` | Event data |
| `meta` | `PropagationMeta` (optional) | Propagation metadata (correlationId, trace, accountUuid, etc.) |
| `options` | `EmitOptions` (optional) | Delay, causationId, timeout, idempotencyKey |
| **Returns** | `EventSubscription<TReturn>` | Handle for tracking result. Thenable (supports `await`). |

The returned `EventSubscription<T>` supports three usage patterns:
- **Fire-and-forget**: Ignore the return value entirely.
- **Callback**: Call `.subscribe(callback)` and `.catch(errorCallback)`.
- **Async/await**: `await events.emit(...)` (subscription implements `then()`).

**Method: `subscribe`**

| Parameter | Type | Description |
|---|---|---|
| `eventName` | `TEventNames` | Event name to listen on |
| `handler` | `EventHandlerFn<TPayload, TReturn>` | Function receiving `EventMessage<TPayload>`, returning `Promise<TReturn>` |
| **Returns** | `void \| Promise<void>` | For distributed providers, returns Promise that resolves when worker is ready |

**EmitOptions**:

| Field | Type | Description |
|---|---|---|
| `delay` | `number` (optional) | Delay in ms before delivery |
| `causationId` | `string` (optional) | Parent event ID for chain tracking |
| `timeout` | `number` (optional) | Timeout in ms for request-response pattern |
| `idempotencyKey` | `string` (optional) | Deduplication key. For BullMQ: becomes jobId. Must NOT contain colons. |

**EventMessage** (internal transport structure):

| Field | Type | Description |
|---|---|---|
| `version` | `string` | Schema version (currently `'1'`) |
| `eventId` | `string` | Unique event instance ID |
| `eventName` | `string` | Event name |
| `payload` | `TPayload` | Event data |
| `meta` | `PropagationMeta` | Propagation context |
| `correlationId` | `string` | Request-response correlation |
| `causationId` | `string` (optional) | Parent event ID |
| `timestamp` | `number` | Emission time |

### 1.2 EventLifecycle (Framework-Facing)

Application calls these during startup/shutdown. Services never call these directly.

```typescript
interface EventLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

| Method | Behavioral Contract |
|---|---|
| `start()` | Connect to transport (queues, etc.). Called during application startup. |
| `stop()` | Disconnect gracefully. Must wait for in-flight events to complete before resolving. |

### 1.3 EventProvider (Implementation)

```typescript
interface EventProvider<TEventNames extends string = string>
  extends EventEmitter<TEventNames>, EventLifecycle {}
```

Implementors must satisfy both EventEmitter and EventLifecycle contracts.

**Behavioral contract for implementors**:
- `emit()` must create an `EventMessage` with version `'1'`, a UUID eventId, and timestamp.
- `emit()` must propagate `meta` through to the handler's `EventMessage`.
- `subscribe()` must ensure the handler is ready before emitting events (for distributed providers, await the returned Promise).
- `stop()` must drain in-flight work before resolving.
- Idempotency keys, when provided, must deduplicate event submissions.

### 1.4 EventSubscription

**Source**: `packages/events/src/event-subscription.ts`

A state-machine class that bridges emitters and handlers for the request-response pattern.

```typescript
class EventSubscription<T = void> {
  readonly correlationId: string;

  subscribe(callback: SubscribeCallback<T>): this;
  catch(callback: ErrorCallback): this;
  toPromise(timeoutMs?: number): Promise<T>;
  then<T1, T2>(...): Promise<T1 | T2>;  // Makes it directly awaitable

  isResolved(): boolean;
  isRejected(): boolean;
  isSettled(): boolean;
}
```

Internal state transitions: `pending` -> `resolved` | `rejected`. Once settled, further resolve/reject calls are no-ops.

Provider internals call `_resolve(value)` and `_reject(error)` to settle the subscription.

### 1.5 Existing Implementations

| Implementation | Package | Transport | Use Case |
|---|---|---|---|
| `InProcessEventProvider` | `@orijs/events` | In-memory (synchronous) | Development, testing |
| `BullMQEventProvider` | `@orijs/bullmq` | BullMQ queues (Redis) | Production, distributed |

**InProcessEventProvider** (`packages/events/src/in-process-orchestrator.ts`):
- Delivers events synchronously within the same process.
- Uses composition: `HandlerRegistry` for subscriptions, `EventDeliveryEngine` for execution.
- `start()` and `stop()` are no-ops (no external transport).

**BullMQEventProvider** (`packages/bullmq/src/events/bullmq-event-provider.ts`):
- Uses per-event-type BullMQ queues.
- Composition: `QueueManager` (per-event queues), `CompletionTracker` (QueueEvents for request-response), `ScheduledEventManager` (cron/delayed).
- `subscribe()` returns a Promise that resolves when the BullMQ Worker is ready.
- `stop()` closes all workers, queues, and QueueEvents connections.

---

## 2. WorkflowProvider

**Source**: `packages/workflows/src/workflow.types.ts`

Three interfaces following ISP:

```
WorkflowExecutor   (consumer-facing)
WorkflowLifecycle  (framework-facing)
WorkflowProvider   extends WorkflowExecutor + WorkflowLifecycle  (implementation)
```

### 2.1 WorkflowExecutor (Consumer-Facing)

Services inject this to start workflows. Cannot call lifecycle methods.

```typescript
interface WorkflowExecutor {
  execute<TData, TResult>(
    workflow: WorkflowDefinitionLike<TData, TResult>,
    data: TData
  ): Promise<FlowHandle<TResult>>;

  getStatus(flowId: string): Promise<FlowStatus>;
}
```

**Method: `execute`**

| Parameter | Type | Description |
|---|---|---|
| `workflow` | `WorkflowDefinitionLike<TData, TResult>` | Workflow definition (from `Workflow.define()`) |
| `data` | `TData` | Input data for the workflow |
| **Returns** | `Promise<FlowHandle<TResult>>` | Handle for status checking and result retrieval |

**Method: `getStatus`**

| Parameter | Type | Description |
|---|---|---|
| `flowId` | `string` | Unique flow ID |
| **Returns** | `Promise<FlowStatus>` | One of: `'pending'`, `'running'`, `'completed'`, `'failed'` |

**WorkflowDefinitionLike** (structural type, avoids importing from `@orijs/core`):

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Workflow name |
| `stepGroups` | `readonly StepGroup[]` | Step execution groups |
| `_data` | `TData` | Type carrier (undefined at runtime) |
| `_result` | `TResult` | Type carrier (undefined at runtime) |

### 2.2 FlowHandle and FlowStatus

```typescript
interface FlowHandle<TResult = unknown> {
  readonly id: string;
  status(): Promise<FlowStatus>;
  result(): Promise<TResult>;
}

type FlowStatus = 'pending' | 'running' | 'completed' | 'failed';
```

`result()` blocks until the workflow completes and returns the `onComplete` handler's return value.

Design decision: individual step failures do not automatically set status to `'failed'`. The parent's `onError` handler decides whether to continue or fail.

### 2.3 WorkflowLifecycle (Framework-Facing)

```typescript
interface WorkflowLifecycle<TOptions = unknown> {
  registerDefinitionConsumer?(
    workflowName: string,
    handler: (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<unknown>,
    stepGroups?: readonly StepGroup[],
    stepHandlers?: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>,
    onError?: (data: unknown, meta?: unknown, error?: Error, stepResults?: Record<string, unknown>) => Promise<void>,
    options?: TOptions
  ): void;

  registerEmitterWorkflow?(workflowName: string): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Method: `registerDefinitionConsumer`** (optional)

Registers a workflow consumer with the provider. The `handler` callback is invoked as the `onComplete` handler after all steps finish.

| Parameter | Type | Description |
|---|---|---|
| `workflowName` | `string` | Workflow name (from definition) |
| `handler` | `(data, meta?, stepResults?) => Promise<unknown>` | The onComplete handler |
| `stepGroups` | `readonly StepGroup[]` (optional) | Step execution structure |
| `stepHandlers` | `Record<string, { execute, rollback? }>` (optional) | Step handler functions |
| `onError` | Error callback (optional) | Called when a step fails |
| `options` | `TOptions` (optional) | Provider-specific config (e.g., concurrency, retries) |

When `stepGroups` is provided and non-empty, the provider:
1. Registers step handlers from `stepHandlers`.
2. Creates child jobs/tasks for each step.
3. Executes steps in order (sequential or parallel per group type).
4. Calls the `handler` (onComplete) only after all steps complete.

When `stepGroups` is empty or not provided, the handler is called directly.

**Method: `registerEmitterWorkflow`** (optional)

Registers a workflow definition for emit-only (no local consumer). Used when this instance can start workflows but does not process them.

**Step Types**:

```typescript
type StepHandler<TData = unknown, TResult = unknown> =
  (ctx: WorkflowContext<TData>) => Promise<TResult> | TResult;

type RollbackHandler<TData = unknown> =
  (ctx: WorkflowContext<TData>) => Promise<void> | void;

interface StepGroup {
  readonly type: 'sequential' | 'parallel';
  readonly definitions: readonly StepDefinitionBase[];
}

interface StepDefinitionBase {
  readonly name: string;
}
```

Rollback handlers MUST be idempotent. In distributed systems with retries, a rollback may be called multiple times.

### 2.4 WorkflowProvider (Implementation)

```typescript
interface WorkflowProvider<TOptions = unknown>
  extends WorkflowExecutor, WorkflowLifecycle<TOptions> {}
```

**Behavioral contract for implementors**:
- `execute()` must generate a unique flow ID and return a FlowHandle.
- Step execution must respect group ordering: sequential groups execute in order, parallel groups execute concurrently.
- Step results must accumulate as `{ stepName: result }` and be passed to the onComplete handler.
- On step failure: run rollbacks in reverse order for completed steps that have rollback handlers, then call `onError`.
- All workflow data (`TData`) must be JSON-serializable for distributed providers.
- `PropagationMeta` must be serialized into job data for context propagation.

**Error types**:

```typescript
class WorkflowStepError extends Error {
  readonly stepName: string;
  readonly cause: Error;
}
```

Thrown when a step fails. Preserves original stack trace via `cause` and appended stack string.

### 2.5 Existing Implementations

| Implementation | Package | Transport | Use Case |
|---|---|---|---|
| `InProcessWorkflowProvider` | `@orijs/workflows` | In-memory (synchronous) | Development, testing |
| `BullMQWorkflowProvider` | `@orijs/bullmq` | BullMQ FlowProducer (Redis) | Production, distributed |

**InProcessWorkflowProvider** (`packages/workflows/src/in-process-workflow-provider.ts`):
- Executes workflows synchronously in-process.
- Step errors flow to `onError`; workflow continues unless the error is re-thrown.
- Results accumulate as `{ step1: result1, step2: result2 }`.
- No cancellation support.

**BullMQWorkflowProvider** (`packages/bullmq/src/workflows/bullmq-workflow-provider.ts`):
- Uses BullMQ `FlowProducer` for distributed workflow execution.
- No in-memory state for step tracking -- uses `job.getChildrenValues()`.
- Rollback handlers via `StepRegistry` lookup, not local storage.
- Result notification via `QueueEvents` (any instance can receive).
- `failParentOnFailure` cascades failures up the job tree.
- Execution order guaranteed by BullMQ job dependencies (children before parent). Completion notification order is NOT guaranteed (QueueEvents is pub/sub).
- Supports `TOptions` generic for provider-specific configuration (concurrency, retries, etc.).

---

## 3. CacheProvider

**Source**: `packages/cache/src/types.ts`

The cache system uses two interfaces (not ISP -- both are consumer-facing but with different capability levels):

```
CacheProvider           (basic operations)
CacheProviderWithMeta   extends CacheProvider  (adds dependency tracking)
```

### 3.1 CacheProvider (Basic)

Generic cache provider interface. Any backend (Redis, in-memory, etc.) can implement this.

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

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `get<T>` | `key: string` | `T \| null` | Get value; null if not found or expired |
| `set<T>` | `key: string, value: T, ttlSeconds: number` | `void` | Set value with TTL (0 = no expiration). Value is JSON-serialized. |
| `del` | `key: string` | `number` | Delete key. Returns 0 or 1. |
| `delMany` | `keys: string[]` | `number` | Delete multiple keys. Returns count deleted. |
| `exists` | `key: string` | `boolean` | Check if key exists |
| `ttl` | `key: string` | `number` | Remaining TTL in seconds. -1 = no expiry, -2 = key absent. |

**Behavioral contract for implementors**:
- `get()` must deserialize JSON. Return null for missing or expired keys.
- `set()` must JSON-serialize the value before storing. TTL of 0 means no expiration.
- `del()` must return 0 if the key does not exist, 1 if it was deleted.
- `ttl()` must return -1 for keys with no expiry and -2 for non-existent keys (Redis convention).

### 3.2 CacheProviderWithMeta (Extended)

Adds meta key support for dependency tracking and cascade invalidation.

```typescript
interface CacheProviderWithMeta extends CacheProvider {
  setWithMeta(key: string, value: unknown, ttlSeconds: number, metaKeys: string[]): Promise<void>;
  delByMeta(metaKey: string): Promise<number>;
  delByMetaMany(metaKeys: string[]): Promise<number>;
}
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `setWithMeta` | `key, value, ttlSeconds, metaKeys` | `void` | Set value and associate with meta keys for dependency tracking |
| `delByMeta` | `metaKey: string` | `number` | Delete all cache entries associated with a meta key |
| `delByMetaMany` | `metaKeys: string[]` | `number` | Delete all entries for multiple meta keys atomically |

Meta keys are Redis sets that track which cache keys depend on a given entity. When an entity changes, `delByMeta` finds and deletes all dependent caches.

**Type guard**:

```typescript
function hasMetaSupport(provider: CacheProvider): provider is CacheProviderWithMeta
```

Runtime check for whether a provider supports meta key operations. Checks for presence and function-type of `setWithMeta`, `delByMeta`, and `delByMetaMany`.

### 3.3 Supporting Types

**CacheConfig** (immutable, returned by builder):

| Field | Type | Description |
|---|---|---|
| `entity` | `TEntityName` | Entity type (consumer-defined: `'User'`, `'Product'`, etc.) |
| `scope` | `TScope` | Cache scope (app-defined: `'global'`, `'account'`, `'project'`) |
| `ttl` | `number` | TTL in seconds |
| `grace` | `number` | Grace period in seconds for stale-while-revalidate (0 = disabled) |
| `params` | `readonly (keyof TParams)[]` | Parameter keys for cache key generation |
| `metaParams` | `readonly (keyof TParams)[]` | Parameter keys for meta key generation (invalidation granularity) |
| `dependsOn` | `Record<string, (keyof TParams)[]>` | Entity dependencies for cascade invalidation |
| `cacheNull` | `boolean` | Whether to cache null/undefined results |
| `timeout` | `number` (optional) | Fetch timeout in ms on cache miss (default: 1000ms) |
| `tags` | `(params: TParams) => string[]` (optional) | Tags for cross-scope invalidation |

**FactoryContext** (passed to factory during cache miss):

| Member | Type | Description |
|---|---|---|
| `skip()` | `never` | Don't cache; return undefined to caller |
| `fail(message)` | `never` | Signal error; preserve stale value if within grace period |
| `staleValue` | `T \| undefined` | Access stale data during grace period |
| `staleAge` | `number \| undefined` | How old stale value is (seconds) |

**Duration type**: `\`${number}${'s' | 'm' | 'h' | 'd'}\` | number | '0'`

**Key prefixes** (constants):

| Constant | Value | Purpose |
|---|---|---|
| `CACHE_KEY_PREFIX` | `'cache:'` | Prefix for cached values |
| `META_KEY_PREFIX` | `'cache:meta:'` | Prefix for dependency tracking sets |
| `TAG_META_KEY_PREFIX` | `'cache:tag:'` | Prefix for cross-scope invalidation tags |

### 3.4 Existing Implementations

| Implementation | Package | Backend | Supports Meta |
|---|---|---|---|
| `InMemoryCacheProvider` | `@orijs/cache` | `Map<string, CacheEntry>` | No |
| `RedisCacheProvider` | `@orijs/cache-redis` | Redis (ioredis) | Yes (`CacheProviderWithMeta`) |

**InMemoryCacheProvider** (`packages/cache/src/in-memory-cache-provider.ts`):
- Map-based in-memory storage with automatic TTL expiration.
- Implements `CacheProvider` only (no meta key support).
- No persistence, not shared across processes.
- Useful for testing and development.

**RedisCacheProvider** (`packages/cache-redis/src/redis-cache.ts`):
- Redis-backed implementation using ioredis.
- Implements `CacheProviderWithMeta` (full meta key support).
- Meta keys are Redis sets that track cache-key-to-entity relationships.
- `delByMeta` uses SMEMBERS + pipeline DEL for atomic cleanup.
- JSON serialization via `@orijs/validation`'s `Json` utility.

---

## 4. WebSocketProvider

**Source**: `packages/websocket/src/types.ts`

Three interfaces following ISP:

```
SocketEmitter      (consumer-facing)
SocketLifecycle    (framework-facing)
WebSocketProvider  extends SocketEmitter + SocketLifecycle  (implementation, adds management methods)
```

### 4.1 SocketEmitter (Consumer-Facing)

Services see this via `ctx.socket` or `ctx.app.socket`. Provides messaging operations only.

```typescript
interface SocketEmitter {
  publish(topic: string, message: string | ArrayBuffer): Promise<void>;
  send(socketId: string, message: string | ArrayBuffer): void;
  broadcast(message: string | ArrayBuffer): void;
  emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void>;
}
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `publish` | `topic, message` | `Promise<void>` | Publish message to all subscribers of a topic. Callers can optionally await for delivery confirmation. |
| `send` | `socketId, message` | `void` | Send directly to a specific socket |
| `broadcast` | `message` | `void` | Send to all connected sockets |
| `emit<TData>` | `message, topic, data` | `Promise<void>` | Emit typed message with runtime validation. Data validated against schema. Serialized as `{ name, data, timestamp }`. |

**SocketMessageLike** (structural type to avoid circular deps):

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique message name |
| `dataSchema` | `Schema<TData>` | Schema for runtime validation |
| `_data` | `TData` | Type carrier (undefined at runtime) |

### 4.2 SocketLifecycle (Framework-Facing)

```typescript
interface SocketLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

| Method | Behavioral Contract |
|---|---|
| `start()` | Connect to transport (Redis, etc.). Must be idempotent. Called BEFORE `setServer()` -- implementations must NOT publish during start. |
| `stop()` | Disconnect gracefully. Must be idempotent. |

The initialization order is important: `start()` is called before `setServer()`. Implementations must only use `start()` for establishing connections (e.g., Redis) and internal setup, not for publishing.

### 4.3 WebSocketProvider (Implementation)

Extends both consumer and lifecycle interfaces, and adds connection management methods.

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

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `subscribe` | `socketId, topic` | `void` | Subscribe a socket to a topic |
| `unsubscribe` | `socketId, topic` | `void` | Unsubscribe a socket from a topic |
| `disconnect` | `socketId` | `void` | Remove socket from all subscriptions. Call on connection close. |
| `isConnected` | `socketId` | `boolean` | Check if socket is connected |
| `getConnectionCount` | (none) | `number` | Total connected sockets |
| `getTopicSubscriberCount` | `topic` | `number` | Subscribers for a topic (0 if absent) |
| `setServer` | `server: BunServer` | `void` | Set Bun server reference. Called by Application after server starts. |

**Behavioral contract for implementors**:
- `setServer()` is called after `start()`. The implementation must store the server reference for use in `publish()` and `broadcast()`.
- `subscribe()`/`unsubscribe()` must update local tracking AND call `ws.subscribe()`/`ws.unsubscribe()` on the Bun `ServerWebSocket`.
- `disconnect()` must clean up all subscriptions for the socket. Called when a WebSocket connection closes.
- `publish()` for in-process providers uses `server.publish(topic, message)`. For Redis providers, publishes to Redis pub/sub channel.
- All socket IDs must be cryptographically random (UUID v4 via `crypto.randomUUID()`) to prevent enumeration attacks.

### 4.4 Supporting Types

**SocketData** (data attached to WebSocket connections):

| Field | Type | Description |
|---|---|---|
| `socketId` | `string` | Cryptographically random UUID v4 |
| `data` | `TData` | Application-specific data attached during upgrade |
| `topics` | `Set<string>` | Topics this socket is subscribed to |

**WebSocketConnection**: `ServerWebSocket<SocketData<TData>>` (Bun native type with typed data).

**WebSocketHandlers** (raw event handlers):

| Handler | Parameters | Description |
|---|---|---|
| `open` | `ws` | Connection established |
| `message` | `ws, message` | Message received (string or Buffer) |
| `close` | `ws, code, reason` | Connection closed |
| `ping` | `ws, data` | Ping received |
| `pong` | `ws, data` | Pong received |
| `drain` | `ws` | Backpressure cleared |

**SocketEmitterConstructor**: `new (provider: WebSocketProvider) => TEmitter` -- used by `Application.websocket<TEmitter>()` for type inference when wrapping the base provider with a custom emitter class.

**WebSocketProviderToken**: Typed injection token (`symbol & { __type?: WebSocketProvider }`) for DI registration/resolution.

### 4.5 Existing Implementations

| Implementation | Package | Transport | Scaling |
|---|---|---|---|
| `InProcWsProvider` | `@orijs/websocket` | Bun native `server.publish()` | Single instance |
| `RedisWsProvider` | `@orijs/websocket-redis` | Redis pub/sub (ioredis) | Horizontal scaling |

**InProcWsProvider** (`packages/websocket/src/in-proc-provider.ts`):
- Uses Bun's native `server.publish()` for local pub/sub.
- Maintains two tracking maps: `localSubscriptions` (topic -> socket IDs) and `socketTopics` (socket ID -> topics, reverse index for O(1) cleanup).
- `start()` and `stop()` are no-ops (no external transport).
- Thread-safe by JavaScript's single-threaded nature.

**RedisWsProvider** (`packages/websocket-redis/src/redis-websocket-provider.ts`):
- Uses two Redis connections: publisher (for PUBLISH) and subscriber (for SUBSCRIBE/PSUBSCRIBE).
- Required separation because a Redis connection in subscriber mode cannot issue PUBLISH.
- Cross-instance message delivery: when a message is published, Redis distributes it to all subscriber instances, which then deliver locally via `server.publish()`.
- `start()` establishes both Redis connections.
- `stop()` disconnects both connections.

---

## 5. ConfigProvider

**Source**: `packages/config/src/types.ts`

ConfigProvider does not use ISP splitting -- it is a simple interface with three methods. There is no lifecycle component; configuration is loaded eagerly during startup.

```typescript
interface ConfigProvider {
  get(key: string): Promise<string | undefined>;
  getRequired(key: string): Promise<string>;
  loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `get` | `key: string` | `string \| undefined` | Get config value; undefined if not found |
| `getRequired` | `key: string` | `string` | Get required value. **Must throw** if not found or empty. |
| `loadKeys` | `keys: string[]` | `Record<string, string \| undefined>` | Batch load multiple keys. Called during startup for eager caching. |

**Behavioral contract for implementors**:
- `get()` must return `undefined` (not null, not empty string) when a key is not found.
- `getRequired()` must throw an `Error` with an actionable message when the key is missing.
- `loadKeys()` must return all requested keys, with `undefined` for missing ones.
- All methods are async to support remote config backends (cloud secret managers, etc.).

The framework stores the ConfigProvider on `AppContext` as a non-enumerable property (set via `Object.defineProperty`). Services access it through `appContext.config`.

If no ConfigProvider is set, a `NullConfigProvider` is used that throws `"No ConfigProvider configured"` for all calls.

### 5.1 Existing Implementations

| Implementation | Package | Backend | Use Case |
|---|---|---|---|
| `EnvConfigProvider` | `@orijs/config` | `Bun.env` | Development (reads .env files) |
| `ValidatedConfig` | `@orijs/config` | Wraps any ConfigProvider | Adds key validation, tracking, fail-fast |

**EnvConfigProvider** (`packages/config/src/env-config.ts`):
- Reads from `Bun.env`, which automatically loads `.env`, `.env.local`, `.env.{NODE_ENV}`.
- `getRequired()` throws with message: `"Required config '{key}' is not set. Add it to your .env file or environment."`.
- `loadKeys()` iterates keys and reads from `Bun.env`.

**ValidatedConfig** (`packages/config/src/validated-config.ts`):
- Decorator/wrapper pattern: wraps any `ConfigProvider` and adds validation.
- Fluent API: `.expectKeys(...)` -> `.onFail('error' | 'warn')` -> `.validate()`.
- Tracks which keys are accessed via `loadedKeys` set.
- Caches loaded values in a `Map` after `loadKeys()`.
- `logLoadedKeys()` for debugging key access.
- `validate()` checks expected keys against loaded values on startup.

---

## 6. Guard

**Source**: `packages/core/src/types/middleware.ts`

Guards are the authentication/authorization layer for HTTP requests. They run before the handler and can block requests with a 403 Forbidden response.

```typescript
interface Guard {
  canActivate(ctx: RequestContext): boolean | Promise<boolean>;
}

type GuardClass = new (...args: any[]) => Guard;
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `canActivate` | `ctx: RequestContext` | `boolean \| Promise<boolean>` | Return `true` to allow, `false` to deny (403 Forbidden) |

**Behavioral contract for implementors**:
- Returning `false` causes the framework to send a 403 Forbidden response. The handler is never called.
- Throwing an error from `canActivate` is treated as a 500 Internal Server Error (the error is caught by the pipeline).
- Guards can set state on the context via `ctx.set()` for downstream handlers (e.g., setting `user` after authentication).
- Guards can be sync or async. The framework awaits the result regardless.
- Multiple guards on a route execute sequentially. If any guard returns `false`, the pipeline stops immediately.

**Resolution**: Guards are resolved from the DI container at route compilation time (not per-request). The resolved guard instance is reused across all requests to that route. This means guards must be stateless or use `ctx` for per-request state.

**Registration**: Guards are registered on routes via the fluent API:

```typescript
controller.get('/protected', handler).guard(AuthGuard);
controller.get('/admin', handler).guard(AuthGuard).guard(AdminGuard);
```

---

## 7. Interceptor

**Source**: `packages/core/src/types/middleware.ts`

Interceptors wrap handler execution in an onion model, allowing pre/post-processing of requests and responses.

```typescript
interface Interceptor {
  intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response>;
}

type InterceptorClass = new (...args: any[]) => Interceptor;
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `intercept` | `ctx: RequestContext, next: () => Promise<Response>` | `Promise<Response>` | Wrap the handler. Call `next()` to proceed. |

**Behavioral contract for implementors**:
- `next()` calls the next interceptor in the chain, or the handler if this is the innermost interceptor.
- Calling `next()` is optional -- an interceptor can short-circuit and return its own Response.
- The interceptor can modify the response by awaiting `next()`, then transforming the returned Response.
- The interceptor can perform setup before `next()` and cleanup after (timing, logging, etc.).
- Interceptors MUST always return a Response object.
- Errors thrown before `next()` prevent the handler from running. Errors thrown after `next()` propagate up.

**Chain construction**: The pipeline builds the interceptor chain as a linked-list/onion pattern at route compilation time. The chain executes in registration order:

```
Interceptor1.intercept(ctx, () =>
  Interceptor2.intercept(ctx, () =>
    handler(ctx)
  )
)
```

**Resolution**: Like guards, interceptors are resolved from the DI container at route compilation time and reused.

**Registration**:

```typescript
controller.get('/timed', handler).interceptor(TimingInterceptor);
```

---

## 8. Pipe

**Source**: `packages/core/src/types/middleware.ts`

Pipes transform and validate input data. They operate on a specific piece of request data (body, params, query) and can transform or reject it.

```typescript
interface Pipe<TInput = unknown, TOutput = unknown> {
  transform(value: TInput, metadata?: PipeMetadata): TOutput | Promise<TOutput>;
}

interface PipeMetadata {
  type: 'body' | 'param' | 'query';
  key?: string;
}

type PipeClass = new (...args: any[]) => Pipe;
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `transform` | `value: TInput, metadata?: PipeMetadata` | `TOutput \| Promise<TOutput>` | Transform/validate input. Throw to reject. |

**PipeMetadata fields**:

| Field | Type | Description |
|---|---|---|
| `type` | `'body' \| 'param' \| 'query'` | Where the value came from |
| `key` | `string` (optional) | Specific key for params and query |

**Behavioral contract for implementors**:
- Return the transformed value on success.
- Throw an error to reject the input (typically a validation error, which the pipeline converts to a 400 Bad Request).
- Pipes can be sync or async.
- Pipes are type-parameterized: `Pipe<TInput, TOutput>` allows transforming types (e.g., `Pipe<string, number>` for parsing a string param to a number).

**Resolution**: Pipes are resolved from the DI container.

---

## 9. SocketGuard

**Source**: `packages/core/src/types/socket-router.ts`

SocketGuard is the WebSocket equivalent of Guard. It serves two purposes depending on where it is registered:
1. **Connection guard**: runs once on WebSocket upgrade (authentication).
2. **Message guard**: runs per-message (rate limiting, authorization).

```typescript
interface SocketGuard {
  canActivate(ctx: SocketContextLike): boolean | Promise<boolean>;
}

type SocketGuardClass = new (...args: any[]) => SocketGuard;
```

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `canActivate` | `ctx: SocketContextLike` | `boolean \| Promise<boolean>` | Return `true` to allow, `false` to deny |

**SocketContextLike** (forward declaration to avoid circular deps):

| Member | Type | Description |
|---|---|---|
| `state` | `TState` | Typed state object |
| `app` | `{ socket: TSocket }` | Access to app context and socket emitter |
| `data` | `unknown` | Parsed message data |
| `messageType` | `string` | Message type being handled |
| `correlationId` | `string` | Trace correlation ID |
| `socketId` | `string` | Connection's socket ID |
| `set(key, value)` | method | Set state for downstream handlers |
| `get(key)` | method | Get state value |

**Behavioral contract for implementors**:
- **As connection guard**: Returning `false` rejects the WebSocket upgrade. The connection is closed. State set via `ctx.set()` persists for all subsequent messages on this connection.
- **As message guard**: Returning `false` sends an error response `{ type, data: null, error: 'Forbidden' }` for that message. The connection remains open.
- Throwing an error from a connection guard logs the error and rejects the connection.
- Throwing an error from a message guard logs the error and sends an error response.
- Guards can be sync or async.

**Resolution**: Connection guards are resolved from the DI container when the WebSocket upgrade occurs. Message guards are pre-resolved at route compilation time (like HTTP guards).

**Registration** via SocketRouteBuilder:

```typescript
class MyRouter implements OriSocketRouter<AuthState> {
  configure(r: SocketRouteBuilder<AuthState>) {
    // Connection guard -- runs ONCE on upgrade
    r.connectionGuard(FirebaseAuthGuard);

    // Message guard -- runs per message for all routes
    r.guard(RateLimitGuard);

    // Route with handler
    r.on('heartbeat', this.handleHeartbeat);
  }
}
```

The SocketRouteBuilder provides these guard-related methods:

| Method | Description |
|---|---|
| `connectionGuard(guard)` | Add a connection guard (runs once on upgrade) |
| `guard(guard)` | Add a message guard (runs per message) |
| `guards(guards)` | Replace all message guards |
| `clearGuards()` | Clear all message guards (not connection guards) |

---

## ISP Pattern Summary

The following table summarizes how each provider splits its interfaces:

| Provider | Consumer Interface | Framework Interface | Full Provider |
|---|---|---|---|
| Events | `EventEmitter` | `EventLifecycle` | `EventProvider` |
| Workflows | `WorkflowExecutor` | `WorkflowLifecycle<TOptions>` | `WorkflowProvider<TOptions>` |
| WebSocket | `SocketEmitter` | `SocketLifecycle` | `WebSocketProvider` (adds management) |
| Cache | `CacheProvider` | (none) | `CacheProviderWithMeta` (extends, not ISP) |
| Config | `ConfigProvider` | (none) | (no split) |
| HTTP Guard | `Guard` | (none) | (no split) |
| HTTP Interceptor | `Interceptor` | (none) | (no split) |
| HTTP Pipe | `Pipe<TInput, TOutput>` | (none) | (no split) |
| Socket Guard | `SocketGuard` | (none) | (no split) |

The ISP split only applies to providers that have both operational concerns (used by business code) and lifecycle concerns (managed by the framework). Simpler contracts like Guard, Interceptor, Pipe, and ConfigProvider are single interfaces because they have no lifecycle component managed by the framework.
