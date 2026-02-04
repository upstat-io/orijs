# OriJS Framework User Guide

> **A lightweight, Bun-first backend framework with explicit dependency injection, type-safe routing, and event-driven architecture.**

**Status**: Active
**Last Updated**: 2026-01-12
**Target Audience**: Backend developers building APIs, microservices, or migrating from NestJS

---

## Overview

OriJS is a modern backend framework designed for [Bun](https://bun.sh) that prioritizes:

- **Explicit over Magic**: No decorators or reflection. Dependencies are declared as arrays, making the code self-documenting and easy to understand.
- **Type Safety**: TypeScript generics enforce correct types throughout the framework - from DI to route handlers to event payloads.
- **Performance**: Bun-native implementation with direct route mapping for minimal overhead.
- **Simplicity**: Fluent builder API makes configuration intuitive and chainable.

OriJS is ideal for teams building REST APIs, background workers, or microservices who want the structure of NestJS without the decorator magic and Node.js overhead.

---

## Section Index

| Section                                             | Description                                           |
| --------------------------------------------------- | ----------------------------------------------------- |
| [Getting Started](./getting-started.md)             | Installation, first app, and verification             |
| [Core Concepts](./core-concepts.md)                 | Application, DI container, AppContext, lifecycle      |
| [HTTP & Routing](./http-routing.md)                 | Controllers, routes, guards, interceptors, pipes      |
| [Validation](./validation.md)                       | TypeBox schemas, request validation, error handling   |
| [Mappers](./mapper.md)                              | Database-to-domain mapping, fluent builder API        |
| [Events](./events.md)                               | Type-safe pub/sub, handlers, idempotency              |
| [Workflows](./workflows.md)                         | Saga pattern for long-running processes               |
| [WebSocket](./websocket.md)                         | Real-time pub/sub, socket routers, custom emitters    |
| [Caching](./caching.md)                             | Multi-level cache, singleflight, cascade invalidation |
| [Logging](./logging.md)                             | Structured logging with transports                    |
| [Configuration](./configuration.md)                 | Environment-based config with TypeBox validation      |
| [Testing](./testing.md)                             | Unit, functional, and E2E testing patterns            |
| [Advanced Patterns](./advanced-patterns.md)         | Extension functions, tokens, multi-tenancy            |
| [API Reference](./api-reference.md)                 | Complete API documentation                            |
| [Troubleshooting](./troubleshooting.md)             | Common issues and solutions                           |
| [Migration from NestJS](./migration-from-nestjs.md) | Step-by-step migration guide                          |

---

## Quick Reference

### Primary Use Cases

- REST API backends
- Background workers and queue processors
- Microservices with event-driven communication
- Systems requiring saga/workflow patterns

### Key Components

| Component          | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `Application`      | Main entry point with fluent configuration API |
| `Container`        | Dependency injection without decorators        |
| `AppContext`       | Application-level context for services         |
| `RequestContext`   | Per-request context for route handlers         |
| `SocketContext`    | Per-message context for socket handlers        |
| `SocketRouter`     | Organized WebSocket message handling with DI   |
| `EventRegistry`    | Type-safe event definitions                    |
| `WorkflowRegistry` | Saga workflow definitions                      |
| `Mapper`           | Database row to domain object transformation   |
| `CacheService`     | Multi-level caching with singleflight          |
| `Singleflight`     | Thundering herd prevention                     |

### Dependencies

```bash
# Required
bun add @orijs/orijs

# Optional (based on features used)
bun add ioredis        # For Redis-based caching
bun add bullmq         # For queue-based events/workflows
```

---

## Critical Rules

1. **Use arrow functions for route handlers** - Regular methods lose `this` binding in callback context
2. **Register dependencies before dependents** - The container validates at startup but order helps readability
3. **Always call `.disableSignalHandling()` in tests** - Prevents test runner interference
4. **Use lifecycle hooks for async initialization** - Constructors should be synchronous; move async work to `onStartup()`
5. **Inject `AppContext` for app-wide features** - Access events, workflows, config, and DI through the context

---

## Quick Start

```typescript
import { Ori, RouteBuilder, RequestContext } from '@orijs/orijs';

class HealthController {
	configure(r: RouteBuilder) {
		r.get('/health', this.health);
	}

	private health = async () => Response.json({ status: 'ok' });
}

Ori.create()
	.controller('/', HealthController)
	.listen(3000, () => console.log('Server running on :3000'));
```

Run with:

```bash
bun run app.ts
```

---

## Related Documentation

- [Bun Documentation](https://bun.sh/docs) - Runtime APIs and features
- [TypeBox Documentation](https://github.com/sinclairzx81/typebox) - Schema validation library
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) - Distributed tracing standard used by OriJS events
