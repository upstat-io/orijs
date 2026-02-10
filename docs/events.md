# @orijs/events - Technical Reference

Package: `packages/events/src/`

## Overview

`@orijs/events` is OriJS's event system providing type-safe event emission, subscription, and handler registration. It supports both fire-and-forget and request-response patterns through composable components.

The system is structured around Interface Segregation: consumers see `EventEmitter`, the framework manages `EventLifecycle`, and provider implementations fulfill `EventProvider` (which extends both).

---

## 1. EventRegistry

Source: `event-registry.ts`, `event-registry.types.ts`

Fluent builder for defining event names with compile-time type safety. Produces a frozen, immutable registry.

### Type Parameter Accumulation

The builder uses accumulating generics to track registered event names at compile time. Each call to `.event()` widens the type union:

```typescript
interface EventRegistryBuilder<TEventNames extends string = never> {
    event<N extends string>(name: N): EventRegistryBuilder<TEventNames | N>;
    use<TNewNames extends string>(
        fn: (builder: EventRegistryBuilder<TEventNames>) => EventRegistryBuilder<TNewNames>
    ): EventRegistryBuilder<TNewNames>;
    build(): BuiltEventRegistry<TEventNames>;
}
```

The internal `EventRegistryBuilderInternal<TEventNames>` class accumulates names in a `Set<string>` and returns `this as unknown as EventRegistryBuilder<TEventNames | N>` on each `.event()` call. This is a safe assertion since the same builder instance is returned with expanded type parameters.

### Methods

| Method | Signature | Behavior |
|--------|-----------|----------|
| `EventRegistry.create()` | `() => EventRegistryBuilder<never>` | Factory entry point. Returns new internal builder. |
| `.event(name)` | `<N extends string>(name: N) => EventRegistryBuilder<TEventNames \| N>` | Registers a name. Throws if duplicate. Adds to internal `Set<string>`. |
| `.use(fn)` | `<TNewNames>(fn) => EventRegistryBuilder<TNewNames>` | Applies a composition function for modular event definitions. Passes the current builder to `fn`. |
| `.build()` | `() => BuiltEventRegistry<TEventNames>` | Copies internal set, freezes the array and registry object. Returns immutable registry. |

### BuiltEventRegistry Interface

```typescript
interface BuiltEventRegistry<TEventNames extends string = string> {
    getEventNames(): readonly TEventNames[];
    hasEvent(name: string): name is TEventNames;
}
```

Both the registry object and the event names array are `Object.freeze()`-d. The `hasEvent` method doubles as a type guard via the `name is TEventNames` return type.

### Event Naming Convention

Format: `<entity>.<action>` in past tense.

- `user.created`, `order.placed`, `payment.processed`
- Multi-level: `order.status.changed`, `notification.email.sent`
- Entity first, granular events, noun entities, verb actions in past tense

---

## 2. Event System (events.ts)

Source: `events.ts`

Main facade binding a registry to a provider, producing a type-safe `EventSystem`.

### createEventSystem()

```typescript
function createEventSystem<TEventNames extends string>(
    registry: BuiltEventRegistry<TEventNames>,
    options?: CreateEventSystemOptions
): EventSystem<TEventNames>
```

Options:

```typescript
interface CreateEventSystemOptions {
    provider?: EventProvider;         // Default: new InProcessEventProvider()
    defaultMeta?: PropagationMeta;    // Default propagation metadata
}
```

### EventSystem Interface

```typescript
interface EventSystem<TEventNames extends string = string> {
    readonly emit: TypedEmitFn<TEventNames>;
    readonly provider: EventProvider;
    readonly registry: BuiltEventRegistry<TEventNames>;
    onEvent<TPayload, TReturn>(eventName: TEventNames, handler: EventHandler<TPayload, TReturn>): void;
    createBuilder(): EventBuilder<TEventNames>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
```

### emit() Internals

The `emit` function:

1. Validates `eventName` against the registry (throws `Error` for unknown events)
2. Captures propagation metadata from `AsyncLocalStorage` via `capturePropagationMeta()`
3. Merges captured metadata with `defaultMeta` (captured takes precedence)
4. Delegates to `provider.emit(eventName, payload, meta, options)`

```typescript
interface TypedEmitFn<TEventNames extends string> {
    <TReturn = void>(
        eventName: TEventNames,
        payload: unknown,
        options?: { delay?: number; causationId?: string }
    ): EventSubscription<TReturn>;
}
```

### onEvent()

Creates an `EventHandlerBuilder`, calls `.on()` to register the handler, then `.registerWith()` to wire it to the provider. The builder wraps the high-level `EventHandler<TPayload, TReturn>` into a low-level `EventMessage` handler.

### createBuilder()

Returns a new `EventHandlerBuilder` for class-based handler registration via the `configure()` pattern.

### createPropagationMeta()

```typescript
function createPropagationMeta(
    correlationId?: string,
    additional?: Record<string, unknown>
): PropagationMeta
```

Utility to create metadata for event context propagation.

---

## 3. EventDeliveryEngine

Source: `event-delivery.ts`

Composable event execution engine, extracted from a base orchestrator to enable composition over inheritance.

### Configuration

```typescript
interface EventDeliveryConfig {
    readonly registry: IHandlerRegistry;
    readonly log: EventDeliveryLogger;
    readonly createChainedEmit: CreateChainedEmitFn;
}
```

### deliver() Method

```typescript
deliver<TReturn>(message: EventMessage, subscription: EventSubscription<TReturn>): void
```

Execution semantics:

1. Looks up handlers from the registry for `message.eventName`
2. If no handlers: returns immediately (subscription stays unresolved)
3. Creates a `ChainedEmitFn` from the message
4. **First handler**: executes via `Promise.resolve().then()`, resolves subscription with return value on success, rejects on error
5. **Remaining handlers**: executed identically but with `subscription = null` (fire-and-forget). Errors are logged with full context (`eventName`, `eventId`, `correlationId`, `causationId`, `error`, `stack`) but not propagated

The `Promise.resolve().then()` pattern ensures handlers execute asynchronously without blocking the caller.

### ChainedEmitFn

```typescript
type ChainedEmitFn = <TChainReturn = void>(
    eventName: string,
    payload: unknown,
    options?: { delay?: number }
) => EventSubscription<TChainReturn>;
```

Created by `createChainedEmitFactory()`, which wraps the provider's emit function to automatically inject `causationId` from the parent message's `correlationId`:

```typescript
function createChainedEmitFactory(emitFn: ...): CreateChainedEmitFn {
    return (message: EventMessage): ChainedEmitFn => {
        return (eventName, payload, options) => {
            const { meta, causationId } = createChainedMeta(message.meta, message.correlationId);
            return emitFn(eventName, payload, meta, { ...options, causationId });
        };
    };
}
```

---

## 4. EventHandlerBuilder

Source: `event-handler-builder.ts`

Fluent API for registering event handlers. Converts high-level `EventContext` handlers to low-level `EventMessage` handlers.

### Key Types

```typescript
type EventHandler<TPayload = unknown, TReturn = void> = (ctx: EventContext<TPayload>) => Promise<TReturn>;

interface EventBuilder<TEventNames extends string = string> {
    on<TPayload, TReturn>(eventName: TEventNames, handler: EventHandler<TPayload, TReturn>): void;
}

interface EventHandlerClass<TEventNames extends string = string> {
    configure(builder: EventBuilder<TEventNames>): void;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `on(eventName, handler)` | Stores the registration internally. Casts handler to `EventHandler<unknown, unknown>` for storage. |
| `getRegistrations()` | Returns the accumulated registrations as a readonly array. |
| `registerWith(provider, emitFn)` | Iterates registrations, wraps each handler, and calls `provider.subscribe()`. |

### Handler Wrapping

`registerWith()` calls `createWrappedHandler()` for each registration. The wrapper:

1. Creates a `ChainedEmitFn` from the message (preserving correlation context via `createChainedMeta`)
2. Calls `createEventContext()` with the message and chained emit
3. Invokes the original handler with the context
4. Returns the handler's result (propagated to the subscription)

This is the boundary where `EventMessage` (provider-level) is converted to `EventContext` (consumer-level).

---

## 5. EventContext

Source: `event-context.ts`

Consumer-facing context passed to event handlers.

### Interface

```typescript
interface EventContext<TPayload = unknown, TEventNames extends string = string> {
    readonly eventId: string;
    readonly data: TPayload;
    readonly log: Logger;
    readonly emit: EventEmitFn<TEventNames>;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly eventName: string;
    readonly timestamp: number;
}
```

### createEventContext()

```typescript
function createEventContext<TPayload, TEventNames>(
    options: CreateEventContextOptions<TEventNames>
): EventContext<TPayload, TEventNames>
```

Behavior:

1. Creates a `Logger` via `Logger.fromMeta(name, message.meta)` -- preserves parent context (correlationId, traceId, etc.) from the `AsyncLocalStorage` propagation chain
2. Assigns `message.payload as TPayload` to `data`
3. Returns `Object.freeze({...})` -- the context is immutable

### createChainedMeta()

```typescript
function createChainedMeta(
    parentMeta: PropagationMeta,
    parentCorrelationId: string
): { meta: PropagationMeta; causationId: string }
```

Returns the parent's meta unchanged and sets `causationId` to the parent's `correlationId`. This creates a causal chain: the parent event's correlation ID becomes the child event's causation ID.

---

## 6. EventSubscription

Source: `event-subscription.ts`

Request-response state machine enabling both callback-based and async/await consumption patterns.

### State Machine

```typescript
type SubscriptionState<T> =
    | { readonly status: 'pending' }
    | { readonly status: 'resolved'; readonly value: T }
    | { readonly status: 'rejected'; readonly error: Error };
```

States: `pending` -> `resolved` | `rejected`. Once settled, state transitions are ignored (atomic single-transition guarantee).

### Public Methods

| Method | Signature | Behavior |
|--------|-----------|----------|
| `subscribe(callback)` | `(cb: SubscribeCallback<T>) => this` | Registers success callback. If already resolved, invokes immediately. Returns `this` for chaining. |
| `catch(callback)` | `(cb: ErrorCallback) => this` | Registers error callback. If already rejected, invokes immediately. Returns `this` for chaining. |
| `toPromise(timeoutMs?)` | `(timeoutMs?: number) => Promise<T>` | Converts to Promise. Caches the Promise. If `timeoutMs` provided: wraps with `setTimeout` that rejects if not settled. Clears timeout on settlement. |
| `then(onfulfilled?, onrejected?)` | Thenable interface | Delegates to `this.toPromise().then(...)`. Makes `EventSubscription` directly `await`-able. |
| `isResolved()` | `() => boolean` | Checks `status === 'resolved'` |
| `isRejected()` | `() => boolean` | Checks `status === 'rejected'` |
| `isSettled()` | `() => boolean` | Checks `status !== 'pending'` |

### Internal Methods (called by providers)

| Method | Behavior |
|--------|----------|
| `_resolve(value)` | If not pending, returns (no-op). Sets state to resolved. Invokes `subscribeCallback` and `promiseHandlers.resolve`. |
| `_reject(error)` | If not pending, returns (no-op). Sets state to rejected. Invokes `errorCallback` and `promiseHandlers.reject`. |

### Race Condition Prevention

- **Atomic state transitions**: `_resolve` and `_reject` check `status !== 'pending'` before mutating, preventing double-settlement
- **Late subscription handling**: `subscribe()` and `catch()` check current state and invoke callbacks immediately if already settled
- **Promise caching**: `toPromise()` reuses the same Promise on repeated calls; if already settled at Promise creation time, resolves/rejects synchronously inside the constructor

### createSubscription()

```typescript
function createSubscription<T = void>(): EventSubscription<T>
```

Factory that generates a `correlationId` via `crypto.randomUUID()` and returns a new `EventSubscription`.

---

## 7. EventMessage

Source: `event-provider.types.ts`

Internal message envelope for event transport between emit and subscribe.

```typescript
const EVENT_MESSAGE_VERSION = '1';

interface EventMessage<TPayload = unknown> {
    readonly version: string;       // Schema version for detecting incompatible messages during upgrades
    readonly eventId: string;       // Unique ID for this specific event instance (idempotency)
    readonly eventName: string;     // The event name
    readonly payload: TPayload;     // The event payload data
    readonly meta: PropagationMeta; // Propagation metadata for context
    readonly correlationId: string; // Unique ID for request-response correlation
    readonly causationId?: string;  // ID of parent event (event chain tracking)
    readonly timestamp: number;     // Timestamp when event was emitted
}
```

The `version` field (`EVENT_MESSAGE_VERSION`) enables schema evolution: consumers can detect and handle messages from different versions during rolling upgrades.

### EmitOptions

```typescript
interface EmitOptions {
    readonly delay?: number;          // Delay in ms before delivery
    readonly causationId?: string;    // Parent event ID for chain tracking
    readonly timeout?: number;        // Timeout for request-response (0 = none)
    readonly idempotencyKey?: string; // Deduplication key (BullMQ: becomes jobId)
}
```

Note on `idempotencyKey`: For BullMQ, the key must NOT contain colons (`:`) as BullMQ uses them as separators.

---

## 8. InProcessEventProvider

Source: `in-process-orchestrator.ts`

Local synchronous implementation for development and testing.

### Composition

The provider composes three components:

- `HandlerRegistry` (or injected `IHandlerRegistry`): manages subscriptions
- `EventDeliveryEngine` (or injected `IEventDelivery`): handles execution
- `Logger` (or injected `EventDeliveryLogger`): error reporting

All three are injectable via `InProcessEventProviderOptions` for testing.

### Configuration

```typescript
interface InProcessEventProviderOptions {
    readonly registry?: IHandlerRegistry;
    readonly delivery?: IEventDelivery;
    readonly log?: EventDeliveryLogger;
    readonly idempotencyKeyTtlMs?: number;            // Default: 300000 (5 minutes)
    readonly idempotencyCleanupIntervalMs?: number;    // Default: 60000 (1 minute)
}
```

### emit() Flow

1. Creates a new `EventSubscription` via `createSubscription()`
2. **Idempotency check**: If `options.idempotencyKey` provided, checks `processedIdempotencyKeys` Map. If duplicate, resolves subscription with `undefined` and returns immediately. Otherwise, marks key as processed with `Date.now()` timestamp.
3. Creates `EventMessage` with `crypto.randomUUID()` for `eventId`
4. If `delay > 0`: schedules delivery via `setTimeout`, tracks timeout in `pendingTimeouts` Set
5. Otherwise: calls `delivery.deliver(message, subscription)` immediately
6. Returns subscription

### Idempotency Key Deduplication

- `processedIdempotencyKeys`: `Map<string, number>` mapping key to timestamp
- Periodic cleanup via `setInterval` (default: 60 seconds), calling `cleanupExpiredIdempotencyKeys()` which removes entries older than `idempotencyKeyTtlMs` (default: 5 minutes)
- The cleanup interval is `unref()`-d so it does not prevent process exit

### Delayed Delivery

- `scheduleDelivery()` creates a `setTimeout` and adds it to the `pendingTimeouts` Set
- When the timeout fires, it removes itself from the set and calls `delivery.deliver()`

### Lifecycle

- `start()`: sets `started = true`
- `stop()`: clears all pending timeouts, clears idempotency keys, clears cleanup interval, sets `started = false`

---

## 9. TestEventProvider

Source: `test-event-provider.ts`

Async test implementation that always uses `setTimeout` for event delivery.

### Key Difference from InProcessEventProvider

InProcessEventProvider uses `Promise.resolve().then()` for immediate delivery (microtask). TestEventProvider always uses `setTimeout` (macrotask), ensuring events are never resolved synchronously. This properly tests async patterns.

### Configuration

```typescript
interface TestEventProviderConfig {
    readonly processingDelay?: number;  // Default: 10ms
    readonly registry?: IHandlerRegistry;
    readonly delivery?: IEventDelivery;
    readonly log?: EventDeliveryLogger;
}
```

### emit() Behavior

Total delay = `emitDelay` (from `options.delay`) + `processingDelay` (from config). Always schedules delivery via `setTimeout`, even when total delay is 0.

### Test-Specific Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getPendingCount()` | `() => number` | Returns `pendingTimeouts.size`. Useful for asserting events are in flight. |
| `getProcessingDelay()` | `() => number` | Returns configured processing delay. |
| `getHandlerCount(eventName)` | `(eventName: string) => number` | Returns handler count for an event from the registry. |

---

## 10. HandlerRegistry

Source: `handler-registry.ts`

O(1) handler lookup for event subscriptions.

### Data Structure

```
Map<string, HandlerRegistration[]>
    eventName -> [ { handler }, { handler }, ... ]
```

The `Map` provides O(1) lookup by event name. Within each event's array, handlers are stored in registration order (array `push`).

### Interface

```typescript
interface IHandlerRegistry {
    subscribe<TPayload, TReturn>(eventName: string, handler: EventHandlerFn<TPayload, TReturn>): void;
    getHandlers(eventName: string): readonly HandlerRegistration[];
    getHandlerCount(eventName: string): number;
    clear(): void;
}
```

### Order Preservation

Handlers are returned in registration order. This is significant because `EventDeliveryEngine` treats the first handler specially (request-response) and remaining handlers as fire-and-forget.

---

## 11. EventIdempotency

Source: `event-idempotency.ts`

Consumer-side helper for preventing duplicate event processing. Distinct from the provider-level idempotency key in `EmitOptions` (which prevents duplicate emission).

### Configuration

```typescript
interface EventIdempotencyOptions {
    readonly maxSize?: number;  // Default: 10000
    readonly ttlMs?: number;    // Default: 3600000 (1 hour)
}
```

### processOnce()

```typescript
async processOnce<T>(eventId: string, handler: () => Promise<T>): Promise<IdempotencyResult<T>>
```

Flow:

1. Calls `cleanExpired()` to remove entries older than `ttlMs`
2. Checks if `eventId` exists in the `processed` Map
3. If duplicate: returns `{ executed: false, result: undefined }`
4. Marks as processing (`processed.set(eventId, Date.now())`) **before** execution (handles concurrent calls)
5. Enforces `maxSize` via LRU eviction (Map iteration order = insertion order, so first entries are oldest)
6. Executes handler
7. Returns `{ executed: true, result }`

### LRU Eviction

`evictOldest()` iterates `Map.keys()` from the beginning (insertion order), deleting `processed.size - maxSize` entries.

### Other Methods

| Method | Description |
|--------|-------------|
| `isProcessed(eventId)` | Checks if processed and not expired |
| `markProcessed(eventId)` | Manual mark + LRU enforcement |
| `clear()` | Clears all tracked IDs |
| `size` (getter) | Current number of tracked IDs |

This is an in-memory implementation suitable for single-process deployments. For distributed systems, a Redis-backed implementation would be needed.

---

## 12. Interface Segregation

Source: `event-provider.types.ts`

The provider interface is split by consumer role:

### EventEmitter (consumer interface)

```typescript
interface EventEmitter<TEventNames extends string = string> {
    emit<TReturn = void>(
        eventName: TEventNames,
        payload: unknown,
        meta?: PropagationMeta,
        options?: EmitOptions
    ): EventSubscription<TReturn>;

    subscribe<TPayload, TReturn>(
        eventName: TEventNames,
        handler: EventHandlerFn<TPayload, TReturn>
    ): void | Promise<void>;
}
```

Services inject this. No lifecycle methods visible. The `subscribe()` return type is `void | Promise<void>` because distributed providers (BullMQ) return a Promise that resolves when the worker is ready, while in-process providers resolve immediately.

### EventLifecycle (framework interface)

```typescript
interface EventLifecycle {
    start(): Promise<void>;
    stop(): Promise<void>;
}
```

Called by the OriJS application during startup/shutdown. Services never call these directly.

### EventProvider (implementation interface)

```typescript
interface EventProvider<TEventNames extends string = string>
    extends EventEmitter<TEventNames>, EventLifecycle {}
```

Provider implementations (`InProcessEventProvider`, `BullMQEventProvider`) implement this full interface. The application holds the `EventProvider` reference but injects only `EventEmitter` to services.
