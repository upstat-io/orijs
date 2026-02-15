# OriJS

> **Alpha Software** — OriJS is actively developed and used in production. While real-world usage drives rapid improvements, the framework is still early stage. Use at your own risk. APIs and behaviors are subject to change.

A NestJS-inspired web framework for Bun — without the decorators.

## Philosophy

OriJS combines the best ideas from modern web frameworks and implements them using TypeScript interfaces and a fluent builder API instead of decorators.

**Inspiration:**

| Framework   | Ideas Borrowed                                                    |
| ----------- | ----------------------------------------------------------------- |
| **NestJS**  | Dependency injection, guards, interceptors, organized controllers |
| **Elysia**  | End-to-end type safety, schema validation options object          |
| **Hono**    | Lightweight middleware, simple composable API                     |
| **Fastify** | Schema-based validation, hooks, serialization                     |
| **Pino**    | Structured logging with child loggers and transports              |

**Why no decorators?**

- Decorators are still experimental in TypeScript
- The TC39 standard decorators are incompatible with legacy decorators (which NestJS uses)
- `reflect-metadata` adds runtime overhead
- Explicit configuration is easier to test and debug

## Packages

OriJS is organized into focused packages. Each infrastructure package is a **provider** — a pluggable implementation that can be swapped for your own.

### Core Packages
| Package | Description |
|---------|-------------|
| `@orijs/core` | DI container, lifecycle management, core types |
| `@orijs/orijs` | Main framework — controllers, routing, guards, interceptors |

### Provider Packages (Swappable)
| Package | Provides | Can Be Replaced With |
|---------|----------|---------------------|
| `@orijs/validation` | TypeBox-based request validation | Any JSON Schema validator, Zod adapter, custom validator |
| `@orijs/config` | Environment and validated configuration | Custom config loaders (Vault, AWS SSM, etc.) |
| `@orijs/cache` | Entity-based caching with singleflight | Any key-value store |
| `@orijs/cache-redis` | Redis cache provider | Memcached, DynamoDB, custom provider |
| `@orijs/events` | Type-safe event system | Any message queue |
| `@orijs/bullmq` | BullMQ event and workflow providers | RabbitMQ, Kafka, SQS, custom queue |
| `@orijs/workflows` | Saga-pattern workflow orchestration | Custom workflow engine |
| `@orijs/websocket` | WebSocket support with pub/sub | Custom WebSocket implementation |
| `@orijs/websocket-redis` | Redis provider for WebSocket horizontal scaling | Any pub/sub backend |
| `@orijs/websocket-client` | TypeScript WebSocket client with reconnection | Any WebSocket client |
| `@orijs/logging` | Pino-inspired structured logging | Winston, Bunyan, custom logger |

### Utility Packages
| Package | Description |
|---------|-------------|
| `@orijs/mapper` | SQL result to TypeScript object mapping |
| `@orijs/sql` | SQL utilities and tagged template literals |
| `@orijs/test-utils` | Testing utilities and mock factories |

## Quick Start

```typescript
import { Ori, Type, Params } from '@orijs/orijs';
import type { OriController, RouteBuilder, Context } from '@orijs/orijs';

class UserService {
	findAll() {
		return [{ id: '1', name: 'Alice' }];
	}

	findById(id: string) {
		return { id, name: 'Alice' };
	}
}

class UsersController implements OriController {
	constructor(private users: UserService) {}

	configure(r: RouteBuilder) {
		r.get('/', () => this.users.findAll()).get('/:id', (ctx) => this.users.findById(ctx.params.id), {
			params: Params.uuid('id')
		});
	}
}

Ori.create().provider(UserService).controller('/users', UsersController, [UserService]).listen(3000);
```

## Documentation

### Guide

The [OriJS Guide](./guide/README.md) is a comprehensive walkthrough covering everything from first setup to advanced architecture:

**Getting Started**
1. [Introduction & Philosophy](./guide/01-introduction.md) — Why OriJS exists, the provider-based architecture, and the design principles
2. [Quick Start](./guide/02-quick-start.md) — Install, create your first app, and understand the project structure
3. [Core Concepts](./guide/03-core-concepts.md) — The application lifecycle, dependency injection, AppContext, and extension functions
4. [The Provider Architecture](./guide/04-the-provider-architecture.md) — How the pluggable provider system works and how to write your own

**Building HTTP APIs**
5. [Controllers & Routing](./guide/05-controllers-and-routing.md) — Define routes, handle parameters, and build RESTful APIs
6. [Validation](./guide/06-validation.md) — Validate requests with TypeBox, compose schemas, and build custom validators
7. [Guards & Authentication](./guide/07-guards-and-authentication.md) — Protect routes, authenticate users, and implement authorization
8. [Interceptors](./guide/08-interceptors.md) — Cross-cutting concerns: logging, timing, caching, and the onion model

**Configuration & Data**
9. [Configuration](./guide/09-configuration.md) — Environment variables, validated config, and async config loading
10. [Data Mapping](./guide/10-data-mapping.md) — Map SQL results to TypeScript objects with type-safe column mapping

**Events & Background Processing**
11. [Events](./guide/11-events.md) — Type-safe event system with BullMQ for persistent, retryable background processing
12. [Workflows](./guide/12-workflows.md) — Orchestrate multi-step processes with the Saga pattern and compensation handlers

**Real-Time & Infrastructure**
13. [WebSockets](./guide/13-websockets.md) — Real-time communication with Bun's native WebSocket support and Redis-backed scaling
14. [Caching](./guide/14-caching.md) — Entity-based caching with singleflight, grace periods, and cascade invalidation
15. [Logging](./guide/15-logging.md) — Pino-inspired structured logging with transports and automatic request context

**Testing & Production**
16. [Testing](./guide/16-testing.md) — Unit, functional, and E2E testing strategies with mock factories
17. [Advanced Patterns](./guide/17-advanced-patterns.md) — Extension functions, multi-tenancy, error handling, and custom providers

**Reference**
18. [Migration from NestJS](./guide/18-migration-from-nestjs.md) — Step-by-step guide for teams moving from NestJS
19. [API Reference](./guide/19-api-reference.md) — Complete API reference for all packages

## Running

```bash
# Install dependencies
bun install

# Run the example
bun run example/src/app.ts

# Type check
bun run tsc --noEmit

# Run tests
bun test
```

## Name

OriJS is named after the Ori from Stargate SG-1.

## License

[MIT](LICENSE)
