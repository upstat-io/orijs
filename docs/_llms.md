# OriJS Technical Documentation

> Technical specs for framework maintainers and contributors.
> For the user-facing guide, see [guide/README.md](../guide/README.md).

## Documentation Index

- [Architecture Overview](./architecture.md) -- High-level architecture, package map, lifecycle, DI, pipeline, security model
  - Package map: 16 packages across core, events/workflows, infrastructure, and utilities layers
  - Application lifecycle: create, configure, listen, shutdown
  - Dependency injection container and provider registration
  - Request pipeline: routing, guards, validation, handler, response
  - Security model: guard chains, authentication patterns

- [Core Package](./core.md) -- @orijs/core internals: Application, Container, RequestPipeline, coordinators, types
  - `OriApplication` fluent builder API and factory overrides
  - `Container` dependency injection: provider registration, resolution, scoping
  - `RequestPipeline` middleware chain: routing, guard, validation, serialization
  - Coordinators: `RoutingCoordinator`, `EventCoordinator`, `WorkflowCoordinator`, `LifecycleManager`
  - Type system: `OriRoute`, `OriGuard`, `OriMiddleware`, response types

- [Events](./events.md) -- @orijs/events: EventRegistry, DeliveryEngine, subscriptions, InProcessProvider
  - `EventRegistry` builder with compile-time type accumulation
  - `DeliveryEngine` dispatch with fire-and-forget and request-response patterns
  - Subscription model: handler registration, error handling, retry policy
  - `InProcessEventProvider` for single-process / testing use
  - Interface segregation: `EventEmitter`, `EventLifecycle`, `EventProvider`

- [Workflows](./workflows.md) -- @orijs/workflows: step execution, rollback, InProcessWorkflowProvider
  - `WorkflowDefinition` builder with sequential and parallel step composition
  - Step execution with result accumulation and context passing
  - Rollback support: step-level compensating actions
  - `InProcessWorkflowProvider` for single-process / testing use
  - Interface segregation: `WorkflowExecutor`, `WorkflowLifecycle`, `WorkflowProvider`

- [BullMQ](./bullmq.md) -- @orijs/bullmq: distributed events/workflows via BullMQ queues
  - `BullMQEventProvider`: per-event-type queue isolation, scheduled/cron events
  - `BullMQWorkflowProvider`: distributed workflow execution via FlowProducer
  - `QueueManager`: queue/worker lifecycle, concurrency, connection management
  - `CompletionTracker`: request-response pattern via QueueEvents
  - `ScheduledEventManager`: recurring event scheduling with cron support

- [Cache](./cache.md) -- @orijs/cache + @orijs/cache-redis: entity registry, singleflight, cascade invalidation
  - `EntityRegistry`: hierarchical scope/entity model with auto-computed parameters
  - `CacheBuilder`: fluent cache configuration with TTL, singleflight, serialization
  - `CacheService`: type-safe get/set/invalidate with key generation
  - Singleflight: concurrent request deduplication for cache misses
  - Redis provider: meta key cascade invalidation, `SET`/`GET`/`DEL` with pipeline batching

- [WebSocket](./websocket.md) -- @orijs/websocket + redis + client: pub/sub, rooms, reconnection
  - Server core: connection management, topic pub/sub, room abstraction
  - Message registry with type-safe handler registration
  - Redis provider: horizontal scaling via Redis pub/sub
  - Browser client: auto-reconnection, message queuing, heartbeat
  - Interface segregation: `SocketEmitter`, `SocketLifecycle`, `WebSocketProvider`

- [Validation](./validation.md) -- @orijs/validation: TypeBox, Standard Schema, safe JSON, param/query helpers
  - Three schema types: TypeBox (TSchema), Standard Schema, custom validators
  - `validate()` and `validateSync()` with `ValidationResult<T>` return type
  - `Json.parse` / `Json.sanitize`: prototype pollution prevention with O(n) traversal
  - `Params` helpers: UUID, string, number path parameter schemas
  - `Query` helpers: pagination, search, sort query parameter schemas with coercion

- [Config](./config.md) -- @orijs/config: provider-based configuration, namespaced multi-provider
  - `ConfigProvider` interface: async get/getRequired/loadKeys
  - `EnvConfigProvider`: Bun.env with auto .env file loading
  - `ValidatedConfig`: key validation, caching, sync access after startup
  - `NamespacedConfigBuilder`: multi-provider with `env` + custom namespaces
  - Config transformers for derived properties

- [Logging](./logging.md) -- @orijs/logging: structured logging, transports, context propagation
  - `Logger` class: Pino-compatible levels, immutable child loggers, async buffering
  - Context system: `AsyncLocalStorage`, `requestContext()`, `runWithContext()`, `setMeta()`
  - Trace fields: core (correlationId, traceId, spanId) + application-registered
  - Transports: console (pretty/JSON), file (rotation), filter (name-based), multi (fan-out)
  - Log buffer: sonic-boom style string concatenation, timer-based flush, overflow protection

- [Mapper](./mapper.md) -- @orijs/mapper: data transformation, field mapping, coercion
  - `field()` factory: type-safe field definitions with column name, type, optional, default
  - `Mapper.defineTables()`: frozen table structures with direct column name access
  - `Mapper.for<T>()` builder: pick, json, col, embed, omit, field rename, transform
  - `BuiltMapper`: runtime row-to-object mapping with `MapResult` fluent wrapper
  - Coercion functions: string, number, boolean, date with `MapperError` context

- [Utilities](./utilities.md) -- @orijs/sql + @orijs/test-utils: SQL builder, test infrastructure
  - `createOriSql()`: tagged template SQL with identifier markers `${[name]}`
  - `SqlIdentifier` type and `isIdentifier()` guard
  - `BaseContainerManager`: abstract testcontainer lifecycle with retry and circuit breaker
  - `RedisContainerManager` / `createRedisTestHelper()`: Redis testcontainers with BullMQ support
  - Async helpers: `waitFor`, `waitForAsync`, `withTimeout`, `delay`

- [Provider Contracts](./provider-contracts.md) -- All provider interfaces with behavioral contracts
  - Interface Segregation Pattern (ISP): consumer vs framework vs provider interfaces
  - EventProvider, WorkflowProvider, CacheProvider, WebSocketProvider, ConfigProvider contracts
  - Guard, Interceptor, Pipe, SocketGuard middleware interfaces
  - Implementation inventory: InProcess, BullMQ, Redis, Env variants
  - Behavioral guarantees and initialization order requirements
