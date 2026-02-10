# The OriJS Guide

A comprehensive guide to building web applications with OriJS — the NestJS-inspired web framework for Bun, without the decorators.

## What is OriJS?

OriJS is a modern web framework built from the ground up for the [Bun](https://bun.sh) runtime. It takes the best ideas from NestJS — dependency injection, controllers, guards, interceptors — and reimagines them without decorators, without reflect-metadata, and without the complexity tax.

If you've used NestJS, you'll feel at home. If you haven't, you'll find OriJS approachable, explicit, and fast.

## Table of Contents

### Getting Started
1. [Introduction & Philosophy](./01-introduction.md) — Why OriJS exists, what problems it solves, and the design principles behind it
2. [Quick Start](./02-quick-start.md) — Install, create your first app, and understand the project structure
3. [Core Concepts](./03-core-concepts.md) — The application lifecycle, dependency injection, and the building blocks of an OriJS app

### Building HTTP APIs
4. [Controllers & Routing](./04-controllers-and-routing.md) — Define routes, handle parameters, and build RESTful APIs
5. [Validation](./05-validation.md) — Validate request bodies, query parameters, and path parameters with TypeBox
6. [Guards & Authentication](./06-guards-and-authentication.md) — Protect routes, authenticate users, and implement authorization
7. [Interceptors & Middleware](./07-interceptors.md) — Cross-cutting concerns like logging, timing, caching, and response transformation

### Data & Events
8. [Configuration](./08-configuration.md) — Environment variables, validated config, and namespaced configuration
9. [Data Mapping](./09-data-mapping.md) — Map SQL results to TypeScript objects with type safety
10. [Events](./10-events.md) — Type-safe event system with BullMQ for background jobs and distributed processing
11. [Workflows](./11-workflows.md) — Orchestrate multi-step processes with the Saga pattern

### Real-Time & Advanced
12. [WebSockets](./12-websockets.md) — Real-time communication with pub/sub, Socket Routers, and horizontal scaling
13. [Caching](./13-caching.md) — Multi-level caching with singleflight, grace periods, and cascade invalidation
14. [Testing](./14-testing.md) — Unit, functional, and E2E testing strategies with built-in test utilities
15. [Advanced Patterns](./15-advanced-patterns.md) — Extension functions, multi-tenancy, error handling, and production patterns

### Reference
16. [Migration from NestJS](./16-migration-from-nestjs.md) — Step-by-step guide for teams moving from NestJS to OriJS
17. [API Reference](./17-api-reference.md) — Complete API reference for all packages

## Packages

| Package | Description |
|---------|-------------|
| `@orijs/core` | DI container, lifecycle management, core types |
| `@orijs/orijs` | Main framework — controllers, routing, guards, interceptors |
| `@orijs/validation` | TypeBox-based request validation |
| `@orijs/config` | Environment and validated configuration |
| `@orijs/cache` | Entity-based caching with singleflight |
| `@orijs/cache-redis` | Redis provider for distributed caching |
| `@orijs/events` | Type-safe event system |
| `@orijs/bullmq` | BullMQ event and workflow providers |
| `@orijs/workflows` | Saga-pattern workflow orchestration |
| `@orijs/websocket` | WebSocket support with pub/sub |
| `@orijs/websocket-redis` | Redis provider for WebSocket horizontal scaling |
| `@orijs/websocket-client` | TypeScript WebSocket client with reconnection |
| `@orijs/mapper` | SQL result to TypeScript object mapping |
| `@orijs/sql` | SQL utilities and tagged template literals |
| `@orijs/logging` | Pino-inspired structured logging |
| `@orijs/test-utils` | Testing utilities and mock factories |

## Prerequisites

- [Bun](https://bun.sh) v1.1.0 or later
- TypeScript 5.0+
- Basic familiarity with TypeScript and HTTP concepts

## License

OriJS is open source software licensed under the MIT License.
