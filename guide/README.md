# The OriJS Guide

A comprehensive guide to building web applications with OriJS — the provider-based web framework for Bun, inspired by the best ideas from NestJS, Fastify, Elysia, and Hono — without the decorators.

## What is OriJS?

OriJS is a modern, provider-based web framework built from the ground up for the [Bun](https://bun.sh) runtime. It takes the best architectural patterns from NestJS — dependency injection, controllers, guards, interceptors — and reimagines them with a fluent builder API, explicit configuration, and a pluggable provider system that lets you swap out any infrastructure component.

Everything in OriJS is a provider. Validation uses the TypeBox provider. Events use the BullMQ provider. Caching uses the Redis provider. WebSocket scaling uses the Redis pub/sub provider. And if the built-in providers don't fit your needs, you write your own — the framework doesn't care what's behind the interface.

If you've used NestJS, you'll feel at home. If you haven't, you'll find OriJS approachable, explicit, and fast.

## Table of Contents

### Getting Started
1. [Introduction & Philosophy](./01-introduction.md) — Why OriJS exists, the provider-based architecture, and the design principles behind every decision
2. [Quick Start](./02-quick-start.md) — Install, create your first app, and understand the project structure
3. [Core Concepts](./03-core-concepts.md) — The application lifecycle, dependency injection, AppContext, and extension functions
4. [The Provider Architecture](./04-the-provider-architecture.md) — How OriJS's pluggable provider system works, why it matters, and how to write your own

### Building HTTP APIs
5. [Controllers & Routing](./05-controllers-and-routing.md) — Define routes, handle parameters, and build RESTful APIs with the fluent RouteBuilder
6. [Validation](./06-validation.md) — Validate requests with the TypeBox provider, compose schemas, and build custom validators
7. [Guards & Authentication](./07-guards-and-authentication.md) — Protect routes, authenticate users, and implement role-based authorization
8. [Interceptors](./08-interceptors.md) — Cross-cutting concerns: logging, timing, caching, error transformation, and the onion model

### Configuration & Data
9. [Configuration](./09-configuration.md) — Environment variables, validated config, namespaced configuration, and async config loading
10. [Data Mapping](./10-data-mapping.md) — Map SQL results to TypeScript objects with type-safe column mapping and JOIN support

### Events & Background Processing
11. [Events](./11-events.md) — Type-safe event system with the BullMQ provider for persistent, retryable background processing
12. [Workflows](./12-workflows.md) — Orchestrate multi-step processes with the Saga pattern, compensation handlers, and BullMQ flows

### Real-Time & Infrastructure
13. [WebSockets](./13-websockets.md) — Real-time communication with Bun's native WebSocket support, Socket Routers, and Redis-backed horizontal scaling
14. [Caching](./14-caching.md) — Entity-based caching with singleflight, grace periods, cascade invalidation, and pluggable cache providers
15. [Logging](./15-logging.md) — Pino-inspired structured logging with transports, child loggers, and automatic request context

### Testing & Production
16. [Testing](./16-testing.md) — Unit, functional, and E2E testing strategies with built-in mock factories and test utilities
17. [Advanced Patterns](./17-advanced-patterns.md) — Extension functions, multi-tenancy, error handling, performance optimization, and writing custom providers

### Reference
18. [Migration from NestJS](./18-migration-from-nestjs.md) — Step-by-step guide for teams moving from NestJS to OriJS
19. [API Reference](./19-api-reference.md) — Complete API reference for all packages

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

## The Provider Philosophy

OriJS is built on a simple principle: **frameworks should provide structure, not lock-in.**

Every infrastructure component in OriJS implements a provider interface. The framework ships with production-ready providers (TypeBox for validation, BullMQ for events, Redis for caching), but these are conveniences, not requirements. If your team prefers Zod over TypeBox, RabbitMQ over BullMQ, or Memcached over Redis, you write a provider that implements the interface and plug it in.

This means:
- **No vendor lock-in.** Switch infrastructure components without rewriting business logic.
- **Testability.** Swap real providers with in-memory test providers in your test suite.
- **Gradual adoption.** Start with built-in providers and replace them as your needs evolve.
- **Community extensibility.** Anyone can publish a provider package for the ecosystem.

## Prerequisites

- [Bun](https://bun.sh) v1.1.0 or later
- TypeScript 5.0+
- Basic familiarity with TypeScript and HTTP concepts

## License

OriJS is open source software licensed under the MIT License.
