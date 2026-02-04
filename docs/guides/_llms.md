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
