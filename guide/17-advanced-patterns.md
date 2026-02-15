# Chapter 17: Advanced Patterns

This chapter covers patterns that emerge in production OriJS applications — extension function architecture, multi-tenancy, structured error handling, performance optimization, and the critical topic of writing your own custom providers.

## Extension Functions in Depth

Extension functions are OriJS's replacement for NestJS modules. They are plain TypeScript functions that configure an application instance.

### Anatomy of an Extension Function

An extension function receives an `OriApplication` instance and returns it after registering providers, controllers, events, or other resources:

```typescript
import type { OriApplication } from '@orijs/orijs';

export function addUsers(app: OriApplication): OriApplication {
  return app
    .provider(UserRepository, [DbService])
    .provider(UserService, [UserRepository, CacheService])
    .controller('/users', UserController, [UserService]);
}
```

The function can also register events, workflows, guards, and interceptors:

```typescript
export function addNotifications(app: OriApplication): OriApplication {
  return app
    .provider(NotificationService, [EmailClient, PushClient])
    .event(NotificationSent).consumer(NotificationSentConsumer, [AuditService])
    .workflow(SendBulkNotification).consumer(SendBulkNotificationWorkflow, [NotificationService]);
}
```

### Extension Functions with Dependencies

Extension functions can accept parameters for configuration:

```typescript
import type { OriApplication } from '@orijs/orijs';
import { SQL } from 'bun:sql';

export function addDatabase(app: OriApplication, sql: SQL): OriApplication {
  return app
    .providerInstance(SQL, sql)
    .provider(DbUserService, [SQL])
    .provider(DbProjectService, [SQL]);
}

// In app.ts
const sql = new SQL({ url: process.env.DATABASE_URL });

Ori.create()
  .use(app => addDatabase(app, sql))
  .use(addRepositories)
  .use(addServices)
  .listen(3000);
```

### Parameterized Extension Functions

For extension functions that need configuration options, use a factory pattern:

```typescript
interface CorsOptions {
  origins: string[];
  credentials?: boolean;
}

export function addCors(options: CorsOptions) {
  return (app: OriApplication): OriApplication => {
    return app.cors({
      origin: options.origins,
      credentials: options.credentials ?? true,
    });
  };
}

// Usage
Ori.create()
  .use(addCors({ origins: ['https://myapp.com'], credentials: true }))
  .listen(3000);
```

### Conditional Extension Functions

Because extension functions are just functions, conditional application is straightforward:

```typescript
const app = Ori.create()
  .use(addCore)
  .use(addApi);

if (process.env.ENABLE_ADMIN === 'true') {
  app.use(addAdmin);
}

if (process.env.NODE_ENV === 'development') {
  app.use(addDevTools);
}

app.listen(3000);
```

### Testing Extension Functions

Extension functions are testable by applying them to a test application:

```typescript
import { describe, test, expect } from 'bun:test';
import { Ori } from '@orijs/orijs';
import { addUsers } from '../src/extensions/add-users';

describe('addUsers extension', () => {
  test('should register UserService provider', () => {
    const app = Ori.create().disableSignalHandling();
    addUsers(app);

    const container = app.getContainer();
    expect(container.has(UserService)).toBe(true);
  });

  test('should register user routes', async () => {
    const app = Ori.create()
      .disableSignalHandling()
      .providerInstance(DbService, mockDbService);

    addUsers(app);

    const server = await app.listen(0);
    const routes = app.getRoutes();

    expect(routes.some(r => r.fullPath === '/users' && r.method === 'GET')).toBe(true);

    await app.stop();
  });
});
```

## Multi-Tenancy

Multi-tenancy is a common requirement in SaaS applications. OriJS's guard and context system makes it straightforward.

### Tenant Guard

Create a guard that extracts tenant information from the request and sets it on the context:

```typescript
import type { Guard, RequestContext } from '@orijs/orijs';

interface TenantState {
  accountUuid: string;
  projectUuid: string;
}

class TenantGuard implements Guard {
  constructor(private readonly tenantService: TenantService) {}

  public async canActivate(ctx: RequestContext): Promise<boolean> {
    const accountUuid = ctx.request.headers.get('x-account-uuid');
    const projectUuid = ctx.request.headers.get('x-project-uuid');

    if (!accountUuid || !projectUuid) {
      return false;
    }

    // Validate tenant exists and user has access
    const hasAccess = await this.tenantService.validateAccess(
      ctx.state.user,
      accountUuid,
      projectUuid
    );

    if (!hasAccess) return false;

    ctx.set('accountUuid', accountUuid);
    ctx.set('projectUuid', projectUuid);
    return true;
  }
}
```

### Tenant-Scoped Queries

Services receive tenant context from the guard and scope all queries:

```typescript
class MonitorRepository {
  constructor(private readonly db: DbMonitorService) {}

  public async findAll(accountUuid: string, projectUuid: string): Promise<Monitor[]> {
    return this.db.findAll(accountUuid, projectUuid);
  }

  public async findByUuid(
    accountUuid: string,
    projectUuid: string,
    monitorUuid: string
  ): Promise<Monitor | null> {
    return this.db.findByUuid(accountUuid, projectUuid, monitorUuid);
  }
}
```

The controller passes tenant context from `ctx.state`:

```typescript
class MonitorController implements OriController<TenantState & AuthState> {
  constructor(private readonly monitorService: MonitorService) {}

  configure(r: RouteBuilder<TenantState & AuthState>) {
    r.guard(AuthGuard);
    r.guard(TenantGuard);
    r.get('/', this.listMonitors);
  }

  private listMonitors = async (ctx: RequestContext<TenantState & AuthState>) => {
    const monitors = await this.monitorService.findAll(
      ctx.state.accountUuid,
      ctx.state.projectUuid
    );
    return Response.json(monitors);
  };
}
```

### Tenant-Scoped Cache Keys

Scope cache keys by tenant to prevent data leakage between accounts:

```typescript
import { defineScopes, defineEntities, EntityRegistry, createCacheBuilder } from '@orijs/cache';

const Scope = defineScopes({
  Global: { name: 'global' },
  Account: { name: 'account', param: 'accountUuid' },
  Project: { name: 'project', param: 'projectUuid' },
});

const Entities = defineEntities({
  Account: { name: 'Account', scope: Scope.Account },
  Project: { name: 'Project', scope: Scope.Project },
  Monitor: { name: 'Monitor', scope: Scope.Project, param: 'monitorUuid' },
  User: { name: 'User', scope: Scope.Account, param: 'userUuid' },
});

const registry = EntityRegistry.create()
  .scopes(Scope)
  .entities(Entities)
  .build();

const Cache = createCacheBuilder(registry);

// Params auto-derived from entity registry:
// Monitor params = ['accountUuid', 'projectUuid', 'monitorUuid']
// Cache key includes tenant context automatically
const MonitorCache = Cache.for(Entities.Monitor).ttl('5m').build();
```

## Error Handling Strategy

### Domain Errors

Define domain-specific error classes that carry context:

```typescript
// src/errors/domain-errors.ts
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string, cause?: Error) {
    super(
      `${entity} with ID ${id} not found`,
      'NOT_FOUND',
      404,
      cause
    );
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFLICT', 409, cause);
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    public readonly fields: Record<string, string>,
    cause?: Error
  ) {
    super(message, 'VALIDATION_ERROR', 422, cause);
  }
}
```

### Error Mapping Interceptor

Create an interceptor that catches domain errors and maps them to HTTP responses:

```typescript
import type { Interceptor, RequestContext } from '@orijs/orijs';
import { DomainError } from '../errors/domain-errors';

class ErrorMappingInterceptor implements Interceptor {
  public async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      if (error instanceof DomainError) {
        ctx.log.warn('Domain error', {
          code: error.code,
          message: error.message,
          statusCode: error.statusCode,
        });

        return Response.json(
          {
            error: error.code,
            message: error.message,
            ...(error instanceof ValidationError && { fields: error.fields }),
          },
          { status: error.statusCode }
        );
      }

      // Unknown errors — log and return 500
      ctx.log.error('Unhandled error', { error });
      return Response.json(
        { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
        { status: 500 }
      );
    }
  }
}

// Register globally
Ori.create()
  .intercept(ErrorMappingInterceptor)
  // ...
```

### Error Wrapping at Boundaries

Wrap third-party errors at the boundary where they enter your system:

```typescript
class UserRepository {
  constructor(private readonly db: DbUserService) {}

  public async findByEmail(email: string): Promise<User | null> {
    try {
      return await this.db.findByEmail(email);
    } catch (error) {
      // Wrap database-specific error with domain context
      throw new DomainError(
        `Failed to query user by email`,
        'DB_ERROR',
        500,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
```

## Structured Logging Patterns

### Log Levels

Use log levels consistently across your application:

- `debug` — Detailed information for debugging (query params, cache hits/misses)
- `info` — Normal operational events (user created, request handled)
- `warn` — Unexpected but recoverable situations (slow query, retry attempt)
- `error` — Errors that need attention (unhandled exceptions, failed external calls)

### Structured Context

Always include structured context with log messages:

```typescript
// Good — structured context
ctx.log.info('User created', {
  userId: user.id,
  email: user.email,
  accountUuid: ctx.state.accountUuid,
});

// Bad — unstructured string concatenation
ctx.log.info(`User ${user.id} created with email ${user.email}`);
```

### Automatic Request Context

OriJS's `RequestContext` automatically creates a child logger with the correlation ID. Event and workflow contexts do the same:

```typescript
// ctx.log automatically includes correlationId
ctx.log.info('Processing request');
// Output: { correlationId: "abc-123", msg: "Processing request", ... }
```

### Transport Configuration

Configure transports for different environments:

```typescript
import { consoleTransport, fileTransport, filterTransport } from '@orijs/logging';

// Development — colored pretty output (auto-detected when not in production)
Ori.create()
  .logger({
    level: 'debug',
    transports: [consoleTransport({ pretty: true, colors: true })],
  });

// Production — JSON to stdout, all logs also to file with rotation
Ori.create()
  .logger({
    level: 'info',
    transports: [
      consoleTransport({ json: true }),    // JSON to stdout for log aggregation
      fileTransport('./logs/app.log', {    // All logs to rotated file
        rotate: { size: '10mb', keep: 5 },
      }),
    ],
  });
```

## CORS Configuration

Configure CORS at the application level:

```typescript
Ori.create()
  .cors({
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 86400, // 24 hours
  })
  .listen(3000);
```

For development with a wildcard:

```typescript
Ori.create()
  .cors({ origin: '*' })
  .listen(3000);
```

CORS headers are pre-computed at startup for static origins, avoiding per-request overhead. For array origins, only the `Access-Control-Allow-Origin` header is computed per-request by checking the `Origin` header against the allowed list.

## Performance Patterns

### Singleton Optimization

OriJS's DI container uses singleton instances by default. Services are instantiated once and shared across all requests. This means:

- No per-request allocation overhead for services
- Connections (database, Redis) are shared
- State should not be stored on service instances — use `RequestContext` for request-scoped data

### Avoiding N+1 Queries

When loading related data, batch your queries:

```typescript
class MonitorService {
  constructor(
    private readonly monitorRepo: MonitorRepository,
    private readonly snapshotRepo: SnapshotRepository
  ) {}

  public async findAllWithSnapshots(
    accountUuid: string,
    projectUuid: string
  ): Promise<MonitorWithSnapshots[]> {
    // Load all monitors in one query
    const monitors = await this.monitorRepo.findAll(accountUuid, projectUuid);
    if (monitors.length === 0) return [];

    // Load all snapshots for all monitors in one query (not N queries)
    const monitorUuids = monitors.map(m => m.uuid);
    const snapshots = await this.snapshotRepo.findByMonitorUuids(
      accountUuid,
      projectUuid,
      monitorUuids
    );

    // Group snapshots by monitor
    const snapshotsByMonitor = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots) {
      const existing = snapshotsByMonitor.get(snapshot.monitorUuid) ?? [];
      existing.push(snapshot);
      snapshotsByMonitor.set(snapshot.monitorUuid, existing);
    }

    return monitors.map(monitor => ({
      ...monitor,
      snapshots: snapshotsByMonitor.get(monitor.uuid) ?? [],
    }));
  }
}
```

### Connection Pooling

Database and Redis connections should be created once and shared via `providerInstance`:

```typescript
import { SQL } from 'bun:sql';
import { createRedisCacheProvider } from '@orijs/cache-redis';

const sql = new SQL({
  url: process.env.DATABASE_URL,
  max: 20,       // Connection pool size
  idleTimeout: 30, // Close idle connections after 30s
});

Ori.create()
  .use(app => addDatabase(app, sql))
  .cache(createRedisCacheProvider({
    connection: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  }))
  .listen(3000);
```

### Eager Provider Instantiation

By default, providers are lazy — instantiated on first use. For services that need to be ready immediately (queue listeners, connection pools), use eager instantiation:

```typescript
Ori.create()
  .provider(QueueListener, [Redis], { eager: true })
  .provider(MetricsCollector, [], { eager: true })
  .listen(3000);
```

## Writing Custom Providers

This is where OriJS's provider architecture truly shines. Every built-in infrastructure component — validation, caching, events, workflows, WebSocket scaling — implements a provider interface. You can write your own implementation and plug it in.

### The Provider Interface Pattern

Every OriJS infrastructure component follows the same pattern:

1. A **provider interface** defines the contract (what operations are available)
2. A **lifecycle interface** defines start/stop hooks (how the framework manages it)
3. A **full provider interface** combines both (what implementations provide)
4. **Built-in implementations** ship with OriJS (InMemory, Redis, BullMQ)
5. **You write your own** by implementing the interface

### Example: Custom Cache Provider (Memcached)

The `CacheProvider` interface defines what a cache backend must support:

```typescript
// From @orijs/cache — this is the interface you implement
interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<number>;
  delMany(keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
```

To create a Memcached provider:

```typescript
// src/providers/memcached-cache-provider.ts
import Memcached from 'memcached';
import type { CacheProvider } from '@orijs/cache';

export class MemcachedCacheProvider implements CacheProvider {
  private readonly client: Memcached;

  constructor(servers: string, options?: Memcached.options) {
    this.client = new Memcached(servers, options);
  }

  public async get<T>(key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.client.get(key, (err, data) => {
        if (err) return reject(err);
        if (data === undefined) return resolve(null);
        resolve(JSON.parse(data) as T);
      });
    });
  }

  public async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.set(key, JSON.stringify(value), ttlSeconds, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  public async del(key: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.del(key, (err, result) => {
        if (err) return reject(err);
        resolve(result ? 1 : 0);
      });
    });
  }

  public async delMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      deleted += await this.del(key);
    }
    return deleted;
  }

  public async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  public async ttl(_key: string): Promise<number> {
    // Memcached doesn't support TTL queries — return -1 (unknown)
    return -1;
  }
}
```

Register it with the application:

```typescript
import { MemcachedCacheProvider } from './providers/memcached-cache-provider';

Ori.create()
  .cache(new MemcachedCacheProvider('localhost:11211'))
  .provider(UserService, [CacheService])
  .listen(3000);
```

Your `UserService` doesn't change at all — it depends on `CacheService`, which depends on the `CacheProvider` interface, not on Redis specifically.

### Example: Custom Event Provider (RabbitMQ)

The `EventProvider` interface combines `EventEmitter` and `EventLifecycle`:

```typescript
// From @orijs/events — the interfaces you implement
interface EventEmitter {
  emit<TReturn = void>(
    eventName: string,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions
  ): EventSubscription<TReturn>;

  subscribe<TPayload = unknown, TReturn = void>(
    eventName: string,
    handler: EventHandlerFn<TPayload, TReturn>
  ): void | Promise<void>;
}

interface EventLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface EventProvider extends EventEmitter, EventLifecycle {}
```

A RabbitMQ implementation:

```typescript
// src/providers/rabbitmq-event-provider.ts
import amqp from 'amqplib';
import type { EventProvider, EventHandlerFn, EventMessage, EmitOptions } from '@orijs/events';
import { EventSubscription } from '@orijs/events';  // Class with _resolve()/_reject() methods
import type { PropagationMeta } from '@orijs/logging';

export class RabbitMQEventProvider implements EventProvider {
  private connection: amqp.Connection | null = null;
  private channel: amqp.Channel | null = null;
  private readonly handlers = new Map<string, EventHandlerFn>();

  constructor(private readonly url: string) {}

  public async start(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();
  }

  public async stop(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  public emit<TReturn = void>(
    eventName: string,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions
  ): EventSubscription<TReturn> {
    const subscription = new EventSubscription<TReturn>(crypto.randomUUID());

    const message: EventMessage = {
      version: '1',
      eventId: crypto.randomUUID(),
      eventName,
      payload,
      meta: meta ?? {},
      correlationId: subscription.correlationId,
      timestamp: Date.now(),
    };

    // Publish to RabbitMQ exchange
    const published = this.channel!.publish(
      'events',
      eventName,
      Buffer.from(JSON.stringify(message))
    );

    if (!published) {
      subscription._reject(new Error('RabbitMQ publish failed'));
    } else {
      // For simplicity, resolve immediately
      // A full implementation would track request-response correlation
      subscription._resolve(undefined as TReturn);
    }

    return subscription;
  }

  public async subscribe<TPayload = unknown, TReturn = void>(
    eventName: string,
    handler: EventHandlerFn<TPayload, TReturn>
  ): Promise<void> {
    await this.channel!.assertQueue(eventName, { durable: true });
    await this.channel!.bindQueue(eventName, 'events', eventName);

    this.channel!.consume(eventName, async (msg) => {
      if (!msg) return;

      try {
        const message = JSON.parse(msg.content.toString()) as EventMessage<TPayload>;
        await handler(message);
        this.channel!.ack(msg);
      } catch (error) {
        this.channel!.nack(msg, false, true); // Requeue on failure
      }
    });
  }
}
```

Register it:

```typescript
import { RabbitMQEventProvider } from './providers/rabbitmq-event-provider';

Ori.create()
  .eventProvider(new RabbitMQEventProvider('amqp://localhost'))
  .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
  .listen(3000);
```

### Example: Custom Validation Provider (Zod)

OriJS's validation system accepts TypeBox schemas, Standard Schema implementations, or custom validator functions. To use Zod, leverage the Standard Schema interface that Zod 4+ supports:

```typescript
// src/validation/zod-schemas.ts
import { z } from 'zod';

// Zod 4+ implements Standard Schema natively
// These schemas work directly with OriJS validation
export const CreateUserBody = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
});

// Use in controllers — OriJS detects Standard Schema automatically
class UserController implements OriController {
  configure(r: RouteBuilder) {
    r.post('/', this.createUser, {
      body: CreateUserBody, // Zod schema works directly
    });
  }

  private createUser = async (ctx: RequestContext) => {
    const body = await ctx.json(); // Validated by Zod
    return Response.json(body, { status: 201 });
  };
}
```

For Zod 3.x (which does not support Standard Schema), create a wrapper:

```typescript
// src/validation/zod-adapter.ts
import { z } from 'zod';
import type { Validator } from '@orijs/validation';

export function zodValidator<T>(schema: z.ZodSchema<T>): Validator<T> {
  return (data: unknown): T => {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
      );
    }
    return result.data;
  };
}

// Usage
const CreateUserBody = zodValidator(z.object({
  name: z.string().min(1),
  email: z.string().email(),
}));

r.post('/', this.createUser, { body: CreateUserBody });
```

### Example: Custom WebSocket Scaling Provider

The `WebSocketProvider` interface enables custom pub/sub backends for horizontal scaling:

```typescript
// From @orijs/websocket — the full interface
interface WebSocketProvider extends SocketEmitter, SocketLifecycle {
  subscribe(socketId: string, topic: string): void;
  unsubscribe(socketId: string, topic: string): void;
  disconnect(socketId: string): void;
  isConnected(socketId: string): boolean;
  getConnectionCount(): number;
  getTopicSubscriberCount(topic: string): number;
  setServer(server: BunServer): void;
}
```

A NATS-based implementation for WebSocket scaling:

```typescript
// src/providers/nats-websocket-provider.ts
import { connect, type NatsConnection, type Subscription } from 'nats';
import type { WebSocketProvider, BunServer, SocketMessageLike } from '@orijs/websocket';
import { validate } from '@orijs/validation';

export class NatsWsProvider implements WebSocketProvider {
  private nc: NatsConnection | null = null;
  private server: BunServer | null = null;
  private readonly subscriptions = new Map<string, Set<string>>(); // topic -> socketIds
  private readonly natsSubscriptions = new Map<string, Subscription>();

  constructor(private readonly natsUrl: string) {}

  public async start(): Promise<void> {
    this.nc = await connect({ servers: this.natsUrl });
  }

  public async stop(): Promise<void> {
    for (const sub of this.natsSubscriptions.values()) {
      sub.unsubscribe();
    }
    await this.nc?.drain();
  }

  public setServer(server: BunServer): void {
    this.server = server;
  }

  public subscribe(socketId: string, topic: string): void {
    let subscribers = this.subscriptions.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(topic, subscribers);

      // Subscribe to NATS topic for cross-instance messaging
      const sub = this.nc!.subscribe(`ws.${topic}`);
      this.natsSubscriptions.set(topic, sub);

      // Forward NATS messages to local WebSocket subscribers
      (async () => {
        for await (const msg of sub) {
          const data = new TextDecoder().decode(msg.data);
          this.server?.publish(topic, data);
        }
      })();
    }
    subscribers.add(socketId);

    // Also subscribe on Bun's local pub/sub
    // (handled by SocketCoordinator wrapping)
  }

  public async publish(topic: string, message: string | ArrayBuffer): Promise<void> {
    const data = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : new Uint8Array(message);

    // Publish to NATS for cross-instance delivery
    this.nc!.publish(`ws.${topic}`, data);

    // Also publish locally
    this.server?.publish(topic, message);
  }

  public send(socketId: string, message: string | ArrayBuffer): void {
    // Direct send requires local connection lookup
    // In a distributed setup, you'd publish to a socket-specific NATS subject
    this.server?.publish(`__direct__${socketId}`, message);
  }

  public broadcast(message: string | ArrayBuffer): void {
    this.publish('__broadcast__', message);
  }

  public async emit<TData>(
    messageDef: SocketMessageLike<TData>,
    topic: string,
    data: TData
  ): Promise<void> {
    const result = await validate(messageDef.dataSchema, data);
    if (!result.success) {
      throw new Error(`Validation failed: ${result.errors.map(e => e.message).join(', ')}`);
    }
    const payload = JSON.stringify({
      name: messageDef.name,
      data: result.data,
      timestamp: Date.now(),
    });
    await this.publish(topic, payload);
  }

  public unsubscribe(socketId: string, topic: string): void {
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(socketId);
      if (subscribers.size === 0) {
        this.natsSubscriptions.get(topic)?.unsubscribe();
        this.natsSubscriptions.delete(topic);
        this.subscriptions.delete(topic);
      }
    }
  }

  public disconnect(socketId: string): void {
    for (const [topic, subscribers] of this.subscriptions) {
      subscribers.delete(socketId);
    }
  }

  public isConnected(_socketId: string): boolean {
    return true; // Simplified — real impl tracks connections
  }

  public getConnectionCount(): number {
    const allSockets = new Set<string>();
    for (const subscribers of this.subscriptions.values()) {
      for (const socketId of subscribers) {
        allSockets.add(socketId);
      }
    }
    return allSockets.size;
  }

  public getTopicSubscriberCount(topic: string): number {
    return this.subscriptions.get(topic)?.size ?? 0;
  }
}
```

Register it:

```typescript
import { NatsWsProvider } from './providers/nats-websocket-provider';

Ori.create()
  .websocket(new NatsWsProvider('nats://localhost:4222'))
  .listen(3000);
```

### How to Register Custom Providers

Each infrastructure component has a specific registration method on the application:

| Component | Registration Method | Example |
|-----------|-------------------|---------|
| Cache | `.cache(provider)` | `.cache(new MemcachedCacheProvider(...))` |
| Events | `.eventProvider(provider)` | `.eventProvider(new RabbitMQEventProvider(...))` |
| Workflows | `.workflowProvider(provider)` | `.workflowProvider(new CustomWorkflowProvider(...))` |
| WebSocket | `.websocket(provider)` | `.websocket(new NatsWsProvider(...))` |
| Config | `.config(provider)` | `.config(new VaultConfigProvider(...))` |

For validation, use Standard Schema-compatible libraries or custom validator functions directly in route schemas — no special registration needed.

### Testing Custom Providers

Test custom providers by implementing the interface and verifying each method:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemcachedCacheProvider } from '../src/providers/memcached-cache-provider';
import type { CacheProvider } from '@orijs/cache';

describe('MemcachedCacheProvider', () => {
  let provider: CacheProvider;

  beforeEach(() => {
    provider = new MemcachedCacheProvider('localhost:11211');
  });

  test('should store and retrieve values', async () => {
    await provider.set('test-key', { name: 'Alice' }, 60);

    const result = await provider.get<{ name: string }>('test-key');
    expect(result).toEqual({ name: 'Alice' });
  });

  test('should return null for missing keys', async () => {
    const result = await provider.get('nonexistent');
    expect(result).toBeNull();
  });

  test('should delete keys', async () => {
    await provider.set('to-delete', 'value', 60);
    const deleted = await provider.del('to-delete');
    expect(deleted).toBe(1);

    const result = await provider.get('to-delete');
    expect(result).toBeNull();
  });

  test('should check key existence', async () => {
    await provider.set('exists-key', 'value', 60);

    expect(await provider.exists('exists-key')).toBe(true);
    expect(await provider.exists('missing-key')).toBe(false);
  });
});
```

For integration testing with `CacheService`, swap in your custom provider:

```typescript
import { CacheService } from '@orijs/cache';

test('should work with CacheService', async () => {
  const provider = new MemcachedCacheProvider('localhost:11211');
  const cacheService = new CacheService(provider);

  // Test through the CacheService API
  const result = await cacheService.getOrSet(
    MonitorListCache,
    { accountUuid: 'acc-123', projectUuid: 'proj-456' },
    async () => [{ name: 'Monitor 1' }]
  );

  expect(result).toEqual([{ name: 'Monitor 1' }]);
});
```

## Production Checklist

### Configuration
- [ ] Environment variables validated at startup with `ValidatedConfig`
- [ ] Secrets loaded from secure provider (not `.env` in production)
- [ ] Log level set to `info` (not `debug`) in production
- [ ] CORS configured with specific origins (not `*`)

### Security
- [ ] Authentication guard applied globally or to all protected routes
- [ ] Tenant isolation enforced in all data queries
- [ ] Rate limiting on public endpoints
- [ ] Request body size limits configured
- [ ] HTTPS enforced (via reverse proxy)

### Performance
- [ ] Database connection pooling configured
- [ ] Redis connection shared (not per-request)
- [ ] Cache TTLs set appropriately for each entity
- [ ] N+1 queries eliminated in list endpoints
- [ ] Eager providers configured for startup-critical services

### Observability
- [ ] Structured logging with correlation IDs
- [ ] Error tracking configured (Sentry, Datadog, etc.)
- [ ] Health check endpoint exposed
- [ ] Metrics collection for key operations

### Reliability
- [ ] Graceful shutdown configured with appropriate timeout
- [ ] Event consumers are idempotent
- [ ] Workflow steps have rollback handlers
- [ ] Circuit breakers on external service calls
- [ ] Dead letter queues configured for failed events

---

[Previous: Testing ←](./16-testing.md) | [Next: Migration from NestJS →](./18-migration-from-nestjs.md)
