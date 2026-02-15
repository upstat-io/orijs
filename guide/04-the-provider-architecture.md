# Chapter 4: The Provider Architecture

This is the most important chapter in the guide. The provider architecture is what makes OriJS fundamentally different from other frameworks. Every feature chapter that follows — validation, events, caching, WebSockets — builds on the concepts explained here.

## The Problem with Framework Lock-In

Consider a typical NestJS application that uses caching:

```typescript
// NestJS — caching is baked into the framework
import { CacheModule } from '@nestjs/cache-manager';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';

@Module({
  imports: [CacheModule.register({ ttl: 300, store: 'memory' })],
})
export class AppModule {}

@Controller('users')
export class UserController {
  constructor(@Inject(CACHE_MANAGER) private cache: Cache) {}

  @Get(':id')
  @CacheTTL(60)
  @UseInterceptors(CacheInterceptor)
  async getUser(@Param('id') id: string) {
    return this.userService.findById(id);
  }
}
```

This works. But six months later, your application has grown and you need Redis for caching instead of in-memory. You install `cache-manager-redis-store`, update the module configuration, and... discover that the store interface has changed between versions, the TTL behavior is different, and your integration tests that relied on the in-memory store need to be rewritten.

A year later, you realize you need more sophisticated caching — singleflight for preventing cache stampedes, grace periods for stale-while-revalidate, cascade invalidation for related entities. But `@nestjs/cache-manager` doesn't support these features. You're now building a custom cache layer on top of the framework's cache layer, fighting the abstractions instead of working with them.

**This is lock-in.** Not vendor lock-in in the traditional sense — you can still technically replace the cache. But the framework's cache abstraction is woven into your controllers, your decorators, your module configuration, and your tests. Replacing it means touching hundreds of files.

## How OriJS Solves This

OriJS separates every infrastructure component into two parts:

1. **An interface** that defines what the component can do
2. **A provider** that implements the interface with a specific technology

Your application code depends on the interface. The provider is plugged in at the application's entry point. If you need to swap the technology, you change one line — the provider registration — and everything else continues to work.

```
┌─────────────────────────────────────────┐
│           Your Application              │
│                                         │
│  Controllers → Services → Repositories  │
│       │            │           │        │
│       ▼            ▼           ▼        │
│  ┌─────────────────────────────────┐    │
│  │      Provider Interfaces         │    │
│  │  CacheProvider, EventProvider,   │    │
│  │  WebSocketProvider, etc.         │    │
│  └──────────────┬──────────────────┘    │
└─────────────────┼───────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │             │             │
    ▼             ▼             ▼
┌────────┐  ┌────────┐  ┌────────────┐
│ Redis  │  │ In-Mem │  │  Your Own  │
│Provider│  │Provider│  │  Provider  │
└────────┘  └────────┘  └────────────┘
```

## Provider Interfaces

OriJS defines provider interfaces for every infrastructure component. Here are the key ones:

### CacheProvider

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

**Built-in providers:**
- `InMemoryCacheProvider` (from `@orijs/cache`) — For development and testing
- `RedisCacheProvider` (from `@orijs/cache-redis`) — For production

**You could write:** `MemcachedCacheProvider`, `DynamoDBCacheProvider`, `CloudflareCacheProvider`

### EventProvider

OriJS splits the event interface using the Interface Segregation Principle:

```typescript
// Consumer-facing interface — what SERVICES see
interface EventEmitter {
  emit<TReturn>(
    eventName: string,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions,
  ): EventSubscription<TReturn>;

  subscribe<TPayload, TReturn>(
    eventName: string,
    handler: EventHandlerFn<TPayload, TReturn>,
  ): void | Promise<void>;
}

// Framework-facing interface — what ORIJS APPLICATION manages
interface EventLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Full provider interface — what IMPLEMENTATIONS provide
interface EventProvider extends EventEmitter, EventLifecycle {}

```

**Built-in providers:**
- `BullMQEventProvider` (from `@orijs/bullmq`) — Persistent, retryable events backed by Redis

**You could write:** `RabbitMQEventProvider`, `KafkaEventProvider`, `SQSEventProvider`, `InMemoryEventProvider`

### WorkflowProvider

Like events, workflows use the Interface Segregation Principle:

```typescript
// Consumer-facing interface — what SERVICES see
interface WorkflowExecutor {
  execute<TData, TResult>(
    workflow: WorkflowDefinitionLike<TData, TResult>,
    data: TData,
  ): Promise<FlowHandle<TResult>>;

  getStatus(flowId: string): Promise<FlowStatus>;
}

// Framework-facing interface — what ORIJS APPLICATION manages
interface WorkflowLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Full provider interface — what IMPLEMENTATIONS provide
interface WorkflowProvider extends WorkflowExecutor, WorkflowLifecycle {}
```

**Built-in providers:**
- `BullMQWorkflowProvider` (from `@orijs/bullmq`) — Saga-pattern workflows using BullMQ FlowProducer

**You could write:** `TemporalWorkflowProvider`, `StepFunctionsWorkflowProvider`, `InMemoryWorkflowProvider`

### WebSocketProvider (Scaling)

Like other providers, WebSocket uses ISP — `SocketEmitter` for services, `SocketLifecycle` for the framework:

```typescript
// Consumer-facing interface — what SERVICES see via ctx.socket
interface SocketEmitter {
  publish(topic: string, message: string | ArrayBuffer): Promise<void>;
  send(socketId: string, message: string | ArrayBuffer): void;
  broadcast(message: string | ArrayBuffer): void;
}

// Full provider interface — what IMPLEMENTATIONS provide
interface WebSocketProvider extends SocketEmitter, SocketLifecycle {
  subscribe(socketId: string, topic: string): void;
  unsubscribe(socketId: string, topic: string): void;
  disconnect(socketId: string): void;
  isConnected(socketId: string): boolean;
  getConnectionCount(): number;
  getTopicSubscriberCount(topic: string): number;
  setServer(server: BunServer): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Built-in providers:**
- `RedisWsProvider` (from `@orijs/websocket-redis`) — Redis pub/sub for multi-server WebSocket scaling

**You could write:** `NATSWebSocketProvider`, `KafkaWebSocketProvider`, `RabbitMQWebSocketProvider`

### ConfigProvider

```typescript
interface ConfigProvider {
  get(key: string): Promise<string | undefined>;
  getRequired(key: string): Promise<string>;
  loadKeys(keys: string[]): Promise<Record<string, string | undefined>>;
}
```

**Built-in providers:**
- `EnvConfigProvider` (from `@orijs/config`) — Reads from environment variables
- `NamespacedConfigBuilder` — Groups config by prefix
- `ValidatedConfig` — Type-safe config with TypeBox schema validation

**You could write:** `VaultConfigProvider`, `AWSSSMConfigProvider`, `ConsulConfigProvider`

## Using Built-In Providers

Let's see how providers are used in practice. We'll set up caching with the built-in Redis provider, then show how to swap it.

### Setting Up Redis Cache

```bash
bun add @orijs/cache @orijs/cache-redis
```

```typescript
// src/providers/infrastructure.ts
import type { OriApplication } from '@orijs/core';
import { createRedisCacheProvider } from '@orijs/cache-redis';

export function addInfrastructure(app: OriApplication): OriApplication {
  const cacheProvider = createRedisCacheProvider({
    connection: {
      host: Bun.env.REDIS_HOST ?? 'localhost',
      port: Number(Bun.env.REDIS_PORT ?? 6379),
    },
  });

  return app.cache(cacheProvider);
}
```

```typescript
// src/app.ts
import { Ori } from '@orijs/orijs';
import { addInfrastructure } from './providers/infrastructure';
import { addUsers } from './providers/users';

Ori.create()
  .use(addInfrastructure)
  .use(addUsers)
  .listen(3000);
```

Now any service can use caching through the framework's cache system:

```typescript
// src/users/user.service.ts
import { CacheService } from '@orijs/cache';
import { UserCache } from '../cache-configs';  // CacheConfig built with the builder

export class UserService {
  constructor(
    private repo: UserRepository,
    private cache: CacheService,
  ) {}

  public async getUser(id: string): Promise<User | undefined> {
    // getOrSet: check cache → on miss, call factory → store result
    return this.cache.getOrSet(UserCache, { id }, async (ctx) => {
      const user = await this.repo.findById(id);
      if (!user) return ctx.skip();  // Don't cache null
      return user;
    });
  }
}
```

### Swapping to In-Memory Cache for Tests

```typescript
// test/setup.ts
import { Ori } from '@orijs/orijs';
import { InMemoryCacheProvider } from '@orijs/cache';

function createTestApp() {
  return Ori.create()
    .cache(new InMemoryCacheProvider())  // Swap Redis for in-memory
    .use(addUsers)
    .disableSignalHandling();
}
```

One line changed. Your `UserService` doesn't know or care that it's using in-memory caching instead of Redis. The `CacheService` interface is the same. The behavior is the same. But your tests don't need a Redis instance.

### Swapping to a Custom Provider

Suppose your company uses Memcached. You write a provider:

```typescript
// src/infrastructure/memcached-cache.provider.ts
import type { CacheProvider } from '@orijs/cache';
import Memcached from 'memcached';

export class MemcachedCacheProvider implements CacheProvider {
  private client: Memcached;

  constructor(servers: string) {
    this.client = new Memcached(servers);
  }

  public async get<T>(key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.client.get(key, (err, data) => {
        if (err) reject(err);
        else resolve(data ? JSON.parse(data) : null);
      });
    });
  }

  public async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.set(key, JSON.stringify(value), ttlSeconds, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async del(key: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.del(key, (err) => {
        if (err) reject(err);
        else resolve(1);
      });
    });
  }

  public async delMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      count += await this.del(key);
    }
    return count;
  }

  public async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  public async ttl(key: string): Promise<number> {
    // Memcached doesn't expose TTL — return -1 (unknown)
    return -1;
  }
}
```

Now swap it in:

```typescript
// src/providers/infrastructure.ts
import type { OriApplication } from '@orijs/core';
import { MemcachedCacheProvider } from '../infrastructure/memcached-cache.provider';

export function addInfrastructure(app: OriApplication): OriApplication {
  const cacheProvider = new MemcachedCacheProvider(
    Bun.env.MEMCACHED_SERVERS ?? 'localhost:11211'
  );

  return app.cache(cacheProvider);
}
```

That's it. Every service that uses caching now uses Memcached. No changes to controllers, services, repositories, or tests (except integration tests that verify Memcached-specific behavior).

## The Provider Pattern in Depth

### Why Interfaces, Not Abstract Classes?

OriJS uses TypeScript interfaces for provider contracts, not abstract classes. This is a deliberate choice:

```typescript
// Interface — no runtime cost
interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  // ...
}

// vs. Abstract class — runtime cost
abstract class AbstractCacheProvider {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  // ...
}
```

Interfaces are erased at compile time — they add zero bytes to your bundle and zero overhead at runtime. Abstract classes exist at runtime and create inheritance chains that complicate testing and composition.

More importantly, interfaces allow classes to implement multiple provider contracts:

```typescript
// A single class can be both a cache provider and a health-checkable service
class RedisCacheProvider implements CacheProvider, HealthCheckable {
  async get<T>(key: string): Promise<T | null> { /* ... */ }
  async healthCheck(): Promise<HealthStatus> { /* ... */ }
}
```

### Provider Lifecycle

Providers that connect to external services (Redis, message queues, databases) typically need startup and shutdown logic. OriJS handles this through the provider's `start()` and `stop()` methods:

```typescript
interface EventProvider {
  // ... event methods ...
  start(): Promise<void>;  // Connect, create consumers
  stop(): Promise<void>;   // Drain queues, disconnect
}
```

When you register a provider, OriJS calls `start()` during application bootstrap and `stop()` during shutdown. You don't need to manage the lifecycle yourself.

### Provider Composition

Providers can be composed — a higher-level provider can wrap a lower-level one:

```typescript
// The CacheService wraps a CacheProvider and adds singleflight + grace periods
class CacheService {
  constructor(private provider: CacheProvider) {}

  public async getOrSet<T, TParams extends object>(
    config: CacheConfig<TParams>,
    params: TParams,
    factory: (ctx: FactoryContext<T>) => Promise<T>,
  ): Promise<T | undefined> {
    const cacheKey = generateCacheKey(config, params);

    // Singleflight: if multiple requests ask for the same key simultaneously,
    // only one actually calls the factory. Others wait for its result.
    return this.singleflight.do(cacheKey, async () => {
      const entry = await this.provider.get<CacheEntry<T>>(cacheKey);
      if (entry && entry.expiresAt > Date.now()) return entry.value;

      const value = await factory(ctx);
      await this.provider.set(cacheKey, { value, ... }, config.ttl);
      return value;
    });
  }
}
```

The `CacheService` doesn't know whether the underlying `CacheProvider` is Redis, Memcached, or in-memory. It adds caching *behavior* (singleflight, grace periods) on top of any storage *implementation*.

This is the [Strategy pattern](https://en.wikipedia.org/wiki/Strategy_pattern) applied at the infrastructure level. The framework provides the strategy interface and orchestration; providers supply the implementation.

## Writing a Custom Provider: Step by Step

Let's walk through creating a custom event provider from scratch. Suppose you want to use RabbitMQ instead of BullMQ.

### Step 1: Understand the Interface

```typescript
import type { EventProvider, EventHandlerFn, EmitOptions, PropagationMeta } from '@orijs/events';

// EventProvider requires:
// - emit(): Send an event
// - subscribe(): Register a handler for an event
// - start(): Connect and initialize
// - stop(): Disconnect and clean up
```

### Step 2: Implement the Provider

```typescript
// src/infrastructure/rabbitmq-event.provider.ts
import type {
  EventProvider,
  EventHandlerFn,
  EmitOptions,
  PropagationMeta,
} from '@orijs/events';
import { createSubscription, type EventSubscription } from '@orijs/events';
import amqp from 'amqplib';

export class RabbitMQEventProvider implements EventProvider {
  private connection: amqp.Connection | null = null;
  private channel: amqp.Channel | null = null;
  private handlers: Map<string, EventHandlerFn<unknown, unknown>> = new Map();

  constructor(private url: string) {}

  public emit<TReturn>(
    eventName: string,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions,
  ): EventSubscription<TReturn> {
    const subscription = createSubscription<TReturn>();
    const eventMessage = {
      version: '1',
      eventId: crypto.randomUUID(),
      eventName,
      payload,
      meta: meta ?? {},
      correlationId: subscription.correlationId,
      timestamp: Date.now(),
    };
    const message = JSON.stringify(eventMessage);

    if (options?.delay) {
      // RabbitMQ delayed message exchange
      this.channel!.publish('delayed', eventName, Buffer.from(message), {
        headers: { 'x-delay': options.delay },
      });
    } else {
      this.channel!.publish('events', eventName, Buffer.from(message));
    }

    return subscription;
  }

  public async subscribe<TPayload, TReturn>(
    eventName: string,
    handler: EventHandlerFn<TPayload, TReturn>,
  ): Promise<void> {
    this.handlers.set(eventName, handler as EventHandlerFn<unknown, unknown>);

    if (this.channel) {
      await this.channel.assertQueue(eventName, { durable: true });
      await this.channel.bindQueue(eventName, 'events', eventName);
      await this.channel.consume(eventName, async (msg) => {
        if (!msg) return;
        try {
          const parsed = JSON.parse(msg.content.toString());
          // EventHandlerFn receives a full EventMessage object
          await handler(parsed);
          this.channel!.ack(msg);
        } catch (error) {
          this.channel!.nack(msg, false, false); // Dead letter on failure
        }
      });
    }
  }

  public async start(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();

    await this.channel.assertExchange('events', 'topic', { durable: true });

    // Register any handlers that were added before start()
    for (const [eventName, handler] of this.handlers) {
      await this.subscribe(eventName, handler);
    }
  }

  public async stop(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
```

### Step 3: Register the Provider

```typescript
// src/providers/infrastructure.ts
import type { OriApplication } from '@orijs/core';
import { RabbitMQEventProvider } from '../infrastructure/rabbitmq-event.provider';

export function addInfrastructure(app: OriApplication): OriApplication {
  const eventProvider = new RabbitMQEventProvider(
    Bun.env.RABBITMQ_URL ?? 'amqp://localhost'
  );

  return app.eventProvider(eventProvider);
}
```

### Step 4: Use It

Your application code doesn't change at all:

```typescript
// This works the same whether the provider is BullMQ, RabbitMQ, or anything else
ctx.events.emit(UserCreatedEvent, { userId: user.id });
```

## The Provider Ecosystem

OriJS ships with these provider packages:

| Package | Provider Interface | Technology | Purpose |
|---------|-------------------|------------|---------|
| `@orijs/config` | ConfigProvider | Bun.env | Environment configuration |
| `@orijs/cache` | CacheProvider | In-Memory | Development/testing cache |
| `@orijs/cache-redis` | CacheProvider | Redis | Production cache |
| `@orijs/events` | EventProvider | (interface only) | Event system contract |
| `@orijs/bullmq` | EventProvider + WorkflowProvider | BullMQ/Redis | Persistent events and workflows |
| `@orijs/workflows` | WorkflowProvider | (interface only) | Workflow system contract |
| `@orijs/websocket` | WebSocketProvider | (interface only) | WebSocket scaling contract |
| `@orijs/websocket-redis` | WebSocketProvider | Redis pub/sub | WebSocket horizontal scaling |
| `@orijs/validation` | — | TypeBox | Request validation, schema definitions |
| `@orijs/logging` | — | Built-in | Structured logging with transports |

### How to Choose Providers

**For development and testing:**
- Use `InMemoryCacheProvider` — no Redis needed
- Use in-memory event handling — no BullMQ/Redis needed
- Use `EnvConfigProvider` with `.env` files

**For production:**
- Use `RedisCacheProvider` for distributed caching
- Use `BullMQEventProvider` for persistent, retryable events
- Use `RedisWsProvider` for multi-server WebSocket scaling
- Use `ValidatedConfig` for type-safe configuration

**For custom infrastructure:**
- Write your own provider implementing the interface
- Common substitutions: RabbitMQ for events, Memcached for caching, Consul/Vault for config
- Test your provider with the same test suite used for built-in providers

## Comparison with Other Approaches

### NestJS: Locked-In Infrastructure

NestJS provides infrastructure through specialized modules: `@nestjs/cache-manager`, `@nestjs/bull`, `@nestjs/microservices`. These modules expose both the interface and the implementation, tightly coupled through decorators:

```typescript
// NestJS — the @CacheTTL decorator is specific to @nestjs/cache-manager
@Get('users/:id')
@CacheTTL(60)
@UseInterceptors(CacheInterceptor)
async getUser(@Param('id') id: string) { /* ... */ }
```

To replace the cache, you need to replace the module, the decorators, and any code that uses cache-specific features. The decorators are the lock-in mechanism — they couple your route definitions to a specific infrastructure package.

### Fastify: Plugin-Based, Not Interface-Based

Fastify uses plugins to add functionality:

```typescript
fastify.register(fastifyRedis, { host: '127.0.0.1' });
fastify.register(fastifyCaching, { cache: fastifyRedis });
```

Plugins are composable but not interchangeable. A `fastify-redis` plugin exposes Redis-specific APIs. A `fastify-memcached` plugin exposes different APIs. There's no shared interface that lets you swap one for the other without changing your application code.

### OriJS: Interface-Based, Technology-Agnostic

OriJS's approach is closest to how enterprise Java frameworks like Spring handle infrastructure — through well-defined interfaces with pluggable implementations. But without the XML configuration, annotation overhead, or startup time of Java:

```typescript
// Your service depends on CacheProvider (the interface)
class UserService {
  constructor(private cache: CacheProvider) {}
  // Works with Redis, Memcached, DynamoDB, in-memory — any CacheProvider
}

// The entry point chooses the implementation
app.cache(createRedisCacheProvider({ connection: { host: 'localhost', port: 6379 } }));
// Or: app.cache(new InMemoryCacheProvider());
// Or: app.cache(new MemcachedCacheProvider(servers));
```

## Real-World Provider Scenarios

### Scenario 1: Multi-Environment Deployment

```typescript
// src/app.ts
function configureCache(app: OriApplication): OriApplication {
  if (Bun.env.NODE_ENV === 'test') {
    return app.cache(new InMemoryCacheProvider());
  }

  if (Bun.env.CACHE_BACKEND === 'memcached') {
    return app.cache(new MemcachedCacheProvider(Bun.env.MEMCACHED_SERVERS!));
  }

  // Default: Redis
  return app.cache(createRedisCacheProvider({
    connection: {
      host: Bun.env.REDIS_HOST!,
      port: Number(Bun.env.REDIS_PORT ?? 6379),
    },
  }));
}

Ori.create()
  .use(configureCache)
  .use(addUsers)
  .listen(3000);
```

### Scenario 2: Gradual Migration

Your team is migrating from RabbitMQ to Kafka. With providers, you can do this gradually:

```typescript
// Phase 1: RabbitMQ for everything
app.eventProvider(new RabbitMQEventProvider(rabbitUrl));

// Phase 2: Migrate to Kafka by swapping the single provider
// All event definitions (UserEvents, AnalyticsEvents) are provider-agnostic
app.eventProvider(new KafkaEventProvider(kafkaUrl));
```

Your services never change. The migration happens entirely at the application entry point.

### Scenario 3: Testing Without Infrastructure

```typescript
// test/helpers/create-test-app.ts
export function createTestApp(): OriApplication {
  return Ori.create()
    .cache(new InMemoryCacheProvider())
    // Events: in-memory, synchronous for predictable tests
    .use(app => addEventsInMemory(app))
    // Config: hardcoded test values via a simple ConfigProvider
    .config(new EnvConfigProvider())  // Reads from .env.test
    .use(addUsers)
    .disableSignalHandling();
}
```

No Redis, no RabbitMQ, no external services needed. Your CI pipeline runs with zero infrastructure dependencies for unit and functional tests.

## Provider Design Guidelines

If you're writing a provider for the OriJS ecosystem, follow these guidelines:

### 1. Implement the Full Interface

Don't skip methods. If the interface requires `ttl()`, implement it — even if your storage backend doesn't natively support it. Return sensible defaults (`-1` for "unknown") and document the limitation.

### 2. Handle Connection Failures Gracefully

Providers that connect to external services should:
- Retry connections with backoff in `start()`
- Log connection failures with context
- Throw clear errors when the connection is required but unavailable

### 3. Support Clean Shutdown

The `stop()` method should:
- Stop accepting new work
- Drain any pending operations (flush buffers, ack messages)
- Close connections
- Release resources

### 4. Be Stateless Where Possible

Providers should minimize internal state. Each method call should be independent — don't cache state between calls unless the interface contract requires it. This makes providers safe for concurrent use.

### 5. Package It Properly

If you're publishing a provider as an npm package:

```
@your-org/orijs-cache-dynamodb
├── src/
│   ├── dynamodb-cache.provider.ts
│   └── index.ts
├── package.json
└── README.md
```

Use the naming convention `@your-org/orijs-{interface}-{technology}`. This makes it discoverable and clear what interface it implements.

### 6. Include Integration Tests

Ship your provider with tests that verify it correctly implements the interface. Write tests that exercise every method of the provider contract:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { DynamoDBCacheProvider } from './dynamodb-cache.provider';

describe('DynamoDBCacheProvider', () => {
  let provider: DynamoDBCacheProvider;

  beforeEach(() => {
    provider = new DynamoDBCacheProvider({
      tableName: 'test-cache',
      region: 'us-east-1',
    });
  });

  test('should get and set values', async () => {
    await provider.set('key', { name: 'test' }, 300);
    const result = await provider.get<{ name: string }>('key');
    expect(result).toEqual({ name: 'test' });
  });

  test('should return null for missing keys', async () => {
    const result = await provider.get('nonexistent');
    expect(result).toBeNull();
  });

  test('should delete keys', async () => {
    await provider.set('key', 'value', 300);
    const deleted = await provider.del('key');
    expect(deleted).toBe(1);
  });
});
```

## What's Next

You now understand the provider architecture — the foundation that makes OriJS flexible and vendor-agnostic. Every chapter that follows will reference providers, and you'll see the pattern repeated: an interface that defines capabilities, a built-in provider that implements it, and the ability to swap in your own.

Next, we'll build HTTP APIs with controllers and routing — the fluent builder API that replaces NestJS's decorator-based route definitions.

[Next: Controllers & Routing →](./05-controllers-and-routing.md)
