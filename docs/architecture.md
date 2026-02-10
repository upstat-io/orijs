# Architecture Overview

Technical reference for OriJS framework internals. This document covers the high-level architecture, package organization, and cross-cutting design patterns that maintainers need to understand.

## Package Map

OriJS is organized into 16 packages across four functional layers:

```
@orijs/orijs              Meta-package re-exporting all packages

Core:
  @orijs/core             Application, DI container, request pipeline, coordinators, types

Events & Workflows:
  @orijs/events           Event system with registry, delivery engine, subscriptions
  @orijs/workflows        Workflow execution with steps, rollback, context
  @orijs/bullmq           Distributed event + workflow providers via BullMQ

Infrastructure:
  @orijs/cache            Cache builder, entity registry, singleflight, key generation
  @orijs/cache-redis      Redis-backed cache with meta key cascade invalidation
  @orijs/websocket        Server WebSocket management, pub/sub, message registry
  @orijs/websocket-redis  Redis pub/sub for horizontal WebSocket scaling
  @orijs/websocket-client Browser WebSocket client with reconnection

Utilities:
  @orijs/validation       Schema-agnostic validation (TypeBox, Standard Schema, custom)
  @orijs/config           Provider-based configuration (env, cloud secrets, namespaced)
  @orijs/logging          Structured logging with transports and context propagation
  @orijs/mapper           Data transformation between domain models and DB entities
  @orijs/sql              Type-safe SQL query building for Bun's native SQL driver
  @orijs/test-utils       Test helpers, container managers, fixtures
```

## Application Lifecycle

The application follows a deterministic startup and shutdown sequence:

```
Ori.create()
  │
  ├── Build Phase (synchronous, fluent API)
  │   ├── .config()          Set config provider
  │   ├── .logger()          Configure logging
  │   ├── .provider()        Queue provider registrations
  │   ├── .controller()      Queue controller registrations
  │   ├── .event()           Register event definitions
  │   ├── .workflow()        Register workflow definitions
  │   ├── .cache()           Set cache provider
  │   ├── .websocket()       Set WebSocket provider
  │   └── .use()             Apply extension functions
  │
  ├── Bootstrap Phase (.listen() triggers)
  │   ├── Register providers with DI container
  │   ├── Validate dependency graph (missing deps, circular, constructor mismatch)
  │   ├── Register controllers → compile routes
  │   ├── Register event/workflow consumers → instantiate via DI
  │   ├── Register socket routers → compile message routes
  │   ├── Instantiate eager providers
  │   ├── Execute startup hooks (FIFO)
  │   ├── Start event/workflow providers
  │   ├── Start Bun HTTP server
  │   └── Execute ready hooks (FIFO)
  │
  └── Shutdown Phase (.stop() or SIGTERM/SIGINT)
      ├── Execute shutdown hooks (LIFO)
      ├── Stop event/workflow providers
      ├── Close HTTP server
      └── Timeout protection (default 10s)
```

**Lifecycle phases:** `created` → `bootstrapped` → `starting` → `ready` → `stopping` → `stopped`

Startup/ready hooks execute FIFO (first registered, first executed). Shutdown hooks execute LIFO (last registered, first executed) so that dependencies are torn down in reverse order.

## Dependency Injection

### Design Decisions

- **Singleton-only scope.** No request-scoped or transient providers. Request-scoped data flows through `RequestContext` parameters instead.
- **Explicit dependency arrays.** No `reflect-metadata`, no decorators. Dependencies declared as `[DepA, DepB]` arrays that are type-checked against constructor signatures.
- **Startup validation.** The entire DI graph is validated before the HTTP server starts. Missing dependencies, constructor mismatches, and circular dependencies all fail fast with actionable error messages.

### Container Internals

```
Container
  ├── registry: Map<token, { service, deps, external? }>
  ├── instances: Map<token, instance>           (singleton cache)
  ├── resolving: Set<token>                     (circular detection during resolve)
  └── DependencyValidator
      ├── detectCycles()                        DFS-based O(V+E)
      ├── extractConstructorParams()            Parses source for error messages
      └── isPackageInstalled()                  Validates external npm deps
```

Resolution is lazy: services are instantiated on first `resolve()` call and cached. `resolveAsync()` supports async constructor patterns. A 5-second resolution timeout warns about slow service initialization.

### Token Types

Three token types are supported:

1. **Class constructors** — `app.provider(UserService, [UserRepo])` — the default, type-safe via `ConstructorDeps<T>`
2. **Symbols via `Token<T>`** — `createToken<T>('name')` — for interface-based injection
3. **Pre-instantiated values** — `app.providerInstance(token, instance)` — for external resources (DB connections, etc.)

## Coordinator Pattern

The application delegates domain-specific concerns to specialized coordinators, keeping `OriApplication` focused on the fluent API and lifecycle orchestration:

| Coordinator | Responsibility |
|---|---|
| `ProviderCoordinator` | Queues and registers providers, manages eager instantiation |
| `RoutingCoordinator` | Compiles HTTP controllers into Bun-native routes |
| `EventCoordinator` | Manages event definitions, consumers, provider lifecycle |
| `WorkflowCoordinator` | Manages workflow definitions, consumers, step execution |
| `SocketRoutingCoordinator` | Compiles socket routers, handles connection/message lifecycle |

Each coordinator owns its registration queue, instantiation logic, and runtime dispatch. The application delegates to them during bootstrap and shutdown.

## Request Pipeline

HTTP requests flow through a layered pipeline:

```
Incoming Request
  │
  ├── Extract correlation ID (from X-Correlation-ID header or generate UUID)
  ├── Extract/create trace context (W3C traceparent or custom)
  │
  ├── Guards (sequential)
  │   ├── Global guards
  │   ├── Controller guards
  │   └── Route guards
  │   (any false → 403 Forbidden)
  │
  ├── Validation (sequential)
  │   ├── Path parameter validators (UUID, string, number)
  │   ├── Query schema (TypeBox, Standard Schema, custom)
  │   └── Body schema (TypeBox, Standard Schema, custom)
  │   (any failure → 400/422)
  │
  ├── Interceptors (onion/chain pattern)
  │   ├── Global interceptors
  │   ├── Controller interceptors
  │   └── Route interceptors
  │   (each wraps the next, can modify request/response)
  │
  ├── Handler execution
  │   └── Returns Response
  │
  └── CORS headers applied
```

**Fast path optimization:** Routes with no guards, interceptors, schema validation, or param validators skip middleware entirely — the handler is called directly with minimal overhead.

**Guard resolution:** Guards are resolved from the DI container once at route registration time and reused across requests (singleton caching).

**Interceptor chain:** Built as a linked list at compile time. Each interceptor calls `next()` to invoke the next interceptor or the final handler.

## WebSocket Pipeline

WebSocket connections follow a two-phase model:

```
Phase 1: Connection (runs ONCE on upgrade)
  ├── Connection guards (sequential)
  │   (any false → reject upgrade)
  ├── Set connection state (persists across messages)
  └── Store in SocketRoutingCoordinator

Phase 2: Message Routing (runs PER MESSAGE)
  ├── Copy connection state to message context
  ├── Per-message guards (optional, e.g. rate limiting)
  ├── Validate message data against schema
  ├── Execute handler
  └── Send response with type + correlation ID
```

Connection state set by connection guards (e.g., authenticated user) persists across all messages for that connection without re-evaluation.

## Event System Architecture

### Interface Segregation

Event and workflow providers follow a three-interface pattern:

```
EventEmitter       (consumer interface: what services inject)
  ├── emit()
  └── subscribe()

EventLifecycle     (framework interface: what Application manages)
  ├── start()
  └── stop()

EventProvider      (implementation interface: extends both)
```

This allows services to depend on the narrow `EventEmitter` interface while the framework manages the full `EventProvider` lifecycle.

### Event Flow

```
ctx.events.emit(EventDef, payload)
  │
  ├── RequestBoundEventEmitter
  │   ├── Validates payload against TypeBox schema
  │   ├── Propagates correlation ID + causation ID
  │   └── Delegates to EventCoordinator
  │
  ├── EventCoordinator
  │   └── Delegates to EventProvider
  │
  └── EventProvider (InProcess or BullMQ)
      ├── Creates EventMessage envelope
      ├── Routes to handlers via EventDeliveryEngine
      │   ├── First handler: request-response (return value resolves subscription)
      │   └── Remaining handlers: fire-and-forget
      └── Handler receives EventContext with chained emit capability
```

### Type Carrier Pattern

`EventDefinition` and `WorkflowDefinition` carry type information via phantom fields:

```typescript
// Runtime: _data and _result are always undefined
// Compile-time: enables typeof EventDef['_data'] type extraction
interface EventDefinition<TData, TResult> {
  name: string;
  dataSchema: TSchema;
  resultSchema?: TSchema;
  _data: TData;      // phantom
  _result: TResult;  // phantom
}
```

Utility types extract these: `Data<typeof MyEvent>`, `Result<typeof MyEvent>`, `EventConsumer<typeof MyEvent>`.

## Workflow Execution

Workflows support sequential and parallel step groups with rollback:

```
WorkflowExecutor.execute(WorkflowDef, data)
  │
  ├── Validate input data against schema
  │
  ├── Step Groups (in order)
  │   ├── Sequential Group
  │   │   ├── Step A → validate output → accumulate result
  │   │   └── Step B → validate output → accumulate result
  │   │
  │   └── Parallel Group
  │       ├── Step C ─┐
  │       └── Step D ─┤→ Promise.all() → validate outputs → accumulate results
  │                   │
  │   On failure:
  │   └── Rollback completed steps (LIFO order)
  │       └── Errors logged but don't stop other rollbacks
  │
  ├── Validate final result against schema
  └── Return WorkflowHandle (id, status(), result(), cancel())
```

Each step receives a `WorkflowContext` with accumulated results from prior steps, enabling data flow between steps without shared mutable state.

## Cache Architecture

### Entity Registry

The cache system uses a hierarchical entity-scope model:

```
Scope Hierarchy: global → account → project (user-defined)

EntityRegistry
  ├── defineScopes()     Scope chain with params
  ├── defineEntities()   Entity → scope binding with unique keys
  └── Auto-computed entity params = scope params + unique keys
```

### Cache Key Generation

Cache keys are deterministic hashes:

```
Cache key:     cache:{wyhash(stableStringify(entity + params))}     (base36)
Meta key:      cache:meta:{hash}                                     (dependency tracking)
Tag meta key:  cache:tag:{hash}                                      (cross-scope invalidation)
```

Uses `fast-json-stable-stringify` for deterministic JSON serialization and Bun's wyhash for fast hashing.

### Cascade Invalidation

When an entity changes, the cache system invalidates all dependent entries via meta keys:

1. Cache entries store references to meta keys during `setWithMeta()`
2. Meta keys are Redis SETs containing cache key references
3. `delByMeta(metaKey)` atomically: gathers all cache keys from meta sets → deletes all cache keys → deletes meta keys
4. Atomicity enforced via Lua script to prevent race conditions

## Security Model

Security measures are built into multiple layers:

### Path Security
- Max path length: 2048 characters (DoS prevention)
- Path traversal blocked (`..` segments)
- Null bytes blocked in routes
- Duplicate slashes normalized

### Parameter Security
- Max param length: 256 characters
- Allowlist validation: `[a-zA-Z0-9_-]`
- UUID validation: fixed 36 chars, dashes at positions 8/13/18/23, hex chars only

### Data Security
- Query strings parsed into null-prototype objects (prototype pollution prevention)
- `Json.parse()` strips `__proto__`, `constructor`, `prototype` keys
- Config provider marks config as non-enumerable (prevents accidental serialization)
- Safe URI decoding with fallback for malformed sequences

### WebSocket Security
- 5-second upgrade timeout
- Topic validation: 1-256 chars, `[a-zA-Z0-9_:.-]` allowlist
- Socket ID validation: UUID v4 format only
- Redis message envelope sanitized against prototype pollution

## Cross-Cutting Patterns

### Request-Bound Emitters

Event, workflow, and socket emitters are wrapped in request-scoped proxies that automatically propagate correlation IDs and causation IDs:

```
RequestContext
  ├── .events    → RequestBoundEventEmitter (validates, propagates correlation)
  ├── .workflows → RequestBoundWorkflowExecutor (validates, direct invocation)
  └── .socket    → RequestBoundSocketEmitter (binds correlation ID)
```

### Correlation ID Propagation

Every request gets a correlation ID (from `X-Correlation-ID` header or auto-generated). This ID flows through:

1. `RequestContext.correlationId` → available in handlers
2. `ctx.log` → automatically attached to all log entries
3. `ctx.events.emit()` → propagated as `correlationId` in EventMessage
4. Event consumers → receive in `EventContext`, can chain via `causationId`
5. `requestContext()` → available in services via AsyncLocalStorage

### Lazy Initialization

Several context properties are lazily initialized to avoid overhead when not used:

- `RequestContext.query` — parsed on first access
- `RequestContext.log` — logger created on first access
- `RequestContext.correlationId` — generated on first access
- `RequestContext.state` — state object created on first access

## File Organization

All packages follow consistent structure:

```
packages/{name}/
  ├── src/
  │   ├── index.ts          Public API exports
  │   ├── types.ts          Type definitions and interfaces
  │   ├── {name}.ts         Primary implementation
  │   └── ...               Supporting files
  ├── tests/
  │   └── *.spec.ts         Test files
  └── package.json
```

Naming conventions:
- Implementation files: `kebab-case.ts`
- Type/interface files: `types.ts` or `{name}.types.ts`
- Provider implementations: `{provider-name}-provider.ts` or `in-process-{name}.ts`
- Factory functions: `create{Name}()` pattern
- Builder classes: `{Name}Builder` pattern

## Dependency Direction

```
Controllers/Consumers (entry points)
  │
  ├── depends on → @orijs/core (types, AppContext, RequestContext)
  ├── depends on → Application services (via DI)
  │
  └── @orijs/core
      ├── depends on → @orijs/logging (Logger)
      ├── depends on → @orijs/validation (schema validation)
      ├── depends on → @orijs/events (EventProvider interface)
      ├── depends on → @orijs/workflows (WorkflowProvider interface)
      ├── depends on → @orijs/websocket (WebSocketProvider interface)
      └── depends on → @orijs/config (ConfigProvider interface)

  Provider implementations (@orijs/bullmq, @orijs/cache-redis, @orijs/websocket-redis)
      └── depend on → Provider interfaces from their respective packages
```

Infrastructure packages (`@orijs/logging`, `@orijs/config`, `@orijs/cache`) are cross-cutting — they can be depended on by any layer.
