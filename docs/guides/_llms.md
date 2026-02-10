# OriJS AI Index

## Setup & Structure

- **getting-started.md**: install, bun, create app, project structure, hello world
- **core-concepts.md**: Application, Ori.create, Container, DI, injection, tokens, lifecycle, onStartup, onReady, onShutdown, AppContext

## HTTP & Routing

- **http-routing.md**: Controller, configure, RouteBuilder, get/post/put/patch/delete, path params, query params, guards, interceptors, pipes, ResponseFactory, SSE
- **validation.md**: TypeBox, Type.String, Type.Object, ctx.json, ValidationError, request body, schema

## Data & Persistence

- **mapper.md**: buildMapper, pick, prefix, json, mapRow, mapRows, database mapping, JSONB
- **caching.md**: Cache.for, CacheService, getOrSet, TTL, grace, Singleflight, invalidation, dependsOn, Redis

## Events & Workflows

- **events.md**: Event.define, emit, Consumer, IEventConsumer, onEvent, onSuccess, onError, BullMQEventProvider, cron, scheduled, correlationId
- **workflows.md**: Workflow.define, steps, execute, WorkflowConsumer, IWorkflowConsumer, rollback, compensation, BullMQWorkflowProvider, FlowProducer, saga

## WebSocket

- **websocket.md**: WebSocket, .websocket(), .onWebSocket(), SocketEmitter, publish, subscribe, broadcast, send, topics, InProcWsProvider, RedisWsProvider, custom emitter, ctx.socket, AppContext.socket, upgrade, authentication, pub/sub, real-time, WebSocketConnection, WebSocketHandlers, SocketCoordinator, MessageRegistry, ServerMessage.define, JoinRoom, LeaveRoom, Heartbeat, opinionated messages, schema validation, @orijs/websocket-client, SocketClient, emit, SocketRouter, .socketRouter(), OriSocketRouter, SocketRouteBuilder, SocketContext, connectionGuard, SocketGuard, message routing, connection guards, message guards, two-phase model

## Infrastructure

- **logging.md**: Logger, debug/info/warn/error, transports, structured logging, trace ID
- **configuration.md**: EnvConfig, ValidatedConfig, NamespacedConfig, environment variables

## Testing

- **testing.md**: bun test, preload.ts, mock, createMockAppContext, createMockRequestContext, RedisTestHelper, functional test, unit test

## Advanced

- **advanced-patterns.md**: createToken, resolveAsync, lifecycle hooks, extension functions, multi-tenancy, fluent builder
- **api-reference.md**: method signatures, Application, Container, RouteBuilder, RequestContext, EventRegistry, Cache, Logger
- **troubleshooting.md**: service not registered, circular dependency, async constructor, container validation
- **migration-from-nestjs.md**: NestJS, decorators vs explicit, Zod vs TypeBox, Jest vs Bun test

## Comprehensive Guide (guide/)

For in-depth explanations with real-world examples, design rationale, and framework comparisons, see the **OriJS Guide** at `guide/README.md`:

| Chapter | File | Topics |
|---------|------|--------|
| Introduction | [guide/01-introduction.md](../../guide/01-introduction.md) | Philosophy, design principles, when to use OriJS |
| Quick Start | [guide/02-quick-start.md](../../guide/02-quick-start.md) | Step-by-step app setup |
| Core Concepts | [guide/03-core-concepts.md](../../guide/03-core-concepts.md) | Application lifecycle, DI, building blocks |
| Controllers & Routing | [guide/04-controllers-and-routing.md](../../guide/04-controllers-and-routing.md) | Routes, params, RESTful APIs |
| Validation | [guide/05-validation.md](../../guide/05-validation.md) | TypeBox request validation |
| Guards & Auth | [guide/06-guards-and-authentication.md](../../guide/06-guards-and-authentication.md) | Route protection, auth |
| Interceptors | [guide/07-interceptors.md](../../guide/07-interceptors.md) | Cross-cutting concerns |
| Configuration | [guide/08-configuration.md](../../guide/08-configuration.md) | Env vars, validated config |
| Data Mapping | [guide/09-data-mapping.md](../../guide/09-data-mapping.md) | SQL to TypeScript mapping |
| Events | [guide/10-events.md](../../guide/10-events.md) | Type-safe events, BullMQ |
| Workflows | [guide/11-workflows.md](../../guide/11-workflows.md) | Saga pattern orchestration |
| WebSockets | [guide/12-websockets.md](../../guide/12-websockets.md) | Real-time, pub/sub, scaling |
| Caching | [guide/13-caching.md](../../guide/13-caching.md) | Multi-level caching, singleflight |
| Testing | [guide/14-testing.md](../../guide/14-testing.md) | Unit, functional, E2E strategies |
| Advanced Patterns | [guide/15-advanced-patterns.md](../../guide/15-advanced-patterns.md) | Extensions, multi-tenancy, errors |
| Migration from NestJS | [guide/16-migration-from-nestjs.md](../../guide/16-migration-from-nestjs.md) | NestJS to OriJS migration |
| API Reference | [guide/17-api-reference.md](../../guide/17-api-reference.md) | Complete API reference |
