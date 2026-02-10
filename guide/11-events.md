# Chapter 11: Events

[Previous: Data Mapping ←](./10-data-mapping.md) | [Next: Workflows →](./12-workflows.md)

---

HTTP requests need fast responses. But the work triggered by a request -- sending emails, updating search indexes, generating reports, syncing with third-party APIs -- often takes longer than a user should wait. Events decouple the "acknowledge the request" from the "do the work," letting your API respond in milliseconds while background processing happens asynchronously.

OriJS provides a type-safe event system built on the provider pattern. **BullMQ is the default event provider**, giving you persistent, retryable, Redis-backed queues out of the box. But BullMQ is a provider, not a requirement. If you need RabbitMQ, Kafka, SQS, or even a simple in-memory queue for testing, you write a provider that implements the `EventProvider` interface and plug it in. Your event definitions, handlers, and business logic stay exactly the same.

## Why Events?

### Loose Coupling

Without events, a user registration endpoint might look like this:

```typescript
async createUser(data: CreateUserInput) {
  const user = await this.userRepository.create(data);
  await this.emailService.sendWelcome(user.email);     // What if email is down?
  await this.analyticsService.trackSignup(user.uuid);   // What if analytics is slow?
  await this.searchService.indexUser(user);              // What if search is rebuilding?
  return user;
}
```

Every downstream service is a direct dependency. If email is down, user creation fails. If analytics is slow, the user waits. If you add a new integration, you modify the user service.

With events:

```typescript
async createUser(data: CreateUserInput) {
  const user = await this.userRepository.create(data);
  ctx.events.emit(UserCreated, { userId: user.uuid, email: user.email });
  return user;  // Responds immediately
}
```

The user service doesn't know or care who handles `UserCreated`. Email, analytics, and search each subscribe independently. Adding a new subscriber requires zero changes to the user service.

### Fast Responses

The emit call returns immediately. The actual processing happens asynchronously, in a background worker. Your API response time is decoupled from the time it takes to send emails or update indexes.

### Resilience

If the email service is temporarily down, the event sits in the queue. BullMQ retries it with exponential backoff. The user's account was already created successfully. When the email service recovers, the welcome email goes out. No data loss, no manual intervention.

### Extensibility

A year from now, you need to send a Slack notification when a user signs up. You add a new consumer for `UserCreated`. The existing code doesn't change. The user service doesn't even know the Slack consumer exists.

## Event.define() -- Type-Safe Event Definitions

Events are defined using `Event.define()` with TypeBox schemas for the data and result:

```typescript
import { Event } from '@orijs/core';
import { Type } from '@orijs/validation';

const UserCreated = Event.define({
  name: 'user.created',
  data: Type.Object({
    userId: Type.String(),
    email: Type.String(),
    displayName: Type.Optional(Type.String()),
  }),
  result: Type.Object({
    welcomeEmailSent: Type.Boolean(),
  }),
});
```

This creates a frozen, immutable event definition with:

- `name`: A unique event identifier using dot notation (`entity.action` in past tense)
- `data`: A TypeBox schema defining the event payload
- `result`: A TypeBox schema defining the handler's return value (use `Type.Void()` for fire-and-forget)

### Why Type Carriers Over Class-Based Events

Many frameworks define events as classes:

```typescript
// NestJS-style class events
class UserCreatedEvent {
  constructor(
    public userId: string,
    public email: string,
  ) {}
}
```

OriJS uses the "type carrier" pattern instead. Here's why:

**Serialization**: Events are sent between processes, across queues, through Redis. Classes don't serialize well -- you lose methods, prototypes, and `instanceof` checks. A plain object with a TypeBox schema serializes perfectly and validates at the boundary.

**Validation**: TypeBox schemas validate at runtime. When an event arrives from a queue, you can verify its shape before processing. Classes give you no runtime validation -- you trust that the sender constructed the object correctly.

**No Inheritance**: Class-based events tend to accumulate inheritance hierarchies (`BaseEvent -> DomainEvent -> UserEvent -> UserCreatedEvent`). Type carriers are flat, composable definitions. No prototype chains, no diamond inheritance, no hidden behavior.

**Type Extraction**: The `_data` and `_result` fields are undefined at runtime but carry the TypeScript type for compile-time extraction:

```typescript
import type { Data, Result } from '@orijs/core';

type UserCreatedData = Data<typeof UserCreated>;
// { userId: string; email: string; displayName?: string }

type UserCreatedResult = Result<typeof UserCreated>;
// { welcomeEmailSent: boolean }
```

### Event Naming Conventions

Follow the `entity.action` pattern in past tense:

```
user.created          -- Good: entity + past tense action
order.placed          -- Good
payment.processed     -- Good
monitor.check.failed  -- Good: multi-level for sub-actions

createUser            -- Bad: imperative
user-created          -- Bad: use dots, not hyphens
USER_CREATED          -- Bad: not SCREAMING_SNAKE
```

## Implementing Event Consumers

Event consumers handle incoming events. A consumer is a class that implements `IEventConsumer`:

```typescript
import type { IEventConsumer, EventContext, Data, Result } from '@orijs/core';

class UserCreatedConsumer implements IEventConsumer<
  Data<typeof UserCreated>,
  Result<typeof UserCreated>
> {
  constructor(
    private emailService: EmailService,
    private analyticsService: AnalyticsService,
  ) {}

  // Must be an arrow function property for correct `this` binding
  onEvent = async (ctx: EventContext<Data<typeof UserCreated>>) => {
    const { userId, email, displayName } = ctx.data;

    ctx.log.info('Processing user.created', { userId });

    // Send welcome email
    const sent = await this.emailService.sendWelcome(email, displayName);

    // Track analytics
    await this.analyticsService.track('signup', { userId });

    return { welcomeEmailSent: sent };
  };

  // Optional: called after onEvent succeeds
  onSuccess = async (ctx: EventContext<Data<typeof UserCreated>>, result: Result<typeof UserCreated>) => {
    ctx.log.info('user.created handled successfully', {
      userId: ctx.data.userId,
      emailSent: result.welcomeEmailSent,
    });
  };

  // Optional: called when onEvent throws
  onError = async (ctx: EventContext<Data<typeof UserCreated>>, error: Error) => {
    ctx.log.error('user.created handler failed', {
      userId: ctx.data.userId,
      error: error.message,
    });
  };
}
```

### Why Arrow Function Properties?

The consumer's `onEvent` is an arrow function property, not a method. This is intentional:

```typescript
// Arrow function -- `this` is captured at definition time
onEvent = async (ctx) => {
  await this.emailService.send(ctx.data.email);  // `this` works correctly
};

// Regular method -- `this` would be undefined when framework calls handler
async onEvent(ctx) {
  await this.emailService.send(ctx.data.email);  // `this` is undefined!
}
```

When the framework invokes the handler, it detaches the function from the instance. Arrow functions capture `this` lexically, so dependency access always works.

### EventContext

Every handler receives an `EventContext` with:

| Property | Type | Description |
|---|---|---|
| `eventId` | `string` | Unique ID for this event instance (for idempotency) |
| `data` | `TPayload` | The typed event payload |
| `log` | `Logger` | Logger with propagated correlation context |
| `emit` | `function` | Emit chained events with automatic causation tracking |
| `correlationId` | `string` | Request-response correlation ID |
| `causationId` | `string?` | Parent event ID (for event chains) |
| `eventName` | `string` | The event name being handled |
| `timestamp` | `number` | When the event was emitted |

### Multiple Consumers per Event

Multiple consumers can handle the same event independently:

```typescript
// Consumer 1: Send welcome email
class WelcomeEmailConsumer implements IEventConsumer<Data<typeof UserCreated>, void> {
  onEvent = async (ctx) => {
    await this.emailService.sendWelcome(ctx.data.email);
  };
}

// Consumer 2: Index user for search
class SearchIndexConsumer implements IEventConsumer<Data<typeof UserCreated>, void> {
  onEvent = async (ctx) => {
    await this.searchService.indexUser(ctx.data.userId);
  };
}

// Consumer 3: Track analytics
class AnalyticsConsumer implements IEventConsumer<Data<typeof UserCreated>, void> {
  onEvent = async (ctx) => {
    await this.analytics.track('user.created', ctx.data);
  };
}

// Register all three
app
  .event(UserCreated).consumer(WelcomeEmailConsumer, [EmailService])
  .event(UserCreated).consumer(SearchIndexConsumer, [SearchService])
  .event(UserCreated).consumer(AnalyticsConsumer, [AnalyticsService]);
```

Each consumer gets its own queue and processes independently. If the search indexer is slow, it doesn't affect email delivery.

## Emitting Events

Events are emitted from controllers and consumers (entry points only -- services should never emit events directly):

```typescript
class UserController {
  constructor(private userService: UserClientService) {}

  configure(r: RouteBuilder) {
    r.post('/users', this.createUser);
  }

  private createUser = async (ctx: RequestContext) => {
    const data = ctx.body<CreateUserInput>();
    const user = await this.userService.createUser(data);

    // Emit event -- returns immediately
    ctx.events.emit(UserCreated, {
      userId: user.uuid,
      email: user.email,
      displayName: user.displayName,
    });

    return ctx.json(user, 201);
  };
}
```

### Emitting from Event Handlers (Chained Events)

Event handlers can emit additional events, creating event chains. The `causationId` is automatically set to the current event's correlation ID, enabling distributed tracing:

```typescript
class OrderPlacedConsumer implements IEventConsumer<OrderData, void> {
  onEvent = async (ctx) => {
    // Process the order
    const processed = await this.orderService.process(ctx.data.orderId);

    // Emit chained event -- causationId automatically set
    ctx.emit('inventory.reserved', {
      orderId: ctx.data.orderId,
      items: processed.reservedItems,
    });

    // Emit delayed event (send receipt email after 5 minutes)
    ctx.emit('receipt.email.send', {
      orderId: ctx.data.orderId,
    }, { delay: 5 * 60 * 1000 }); // 5 minutes
  };
}
```

## The BullMQ Provider

BullMQ is the default event provider for production use. It provides persistent, Redis-backed queues with automatic retries, backoff, rate limiting, and job lifecycle management.

### Configuration

```typescript
import { BullMQEventProvider } from '@orijs/bullmq';

const eventProvider = new BullMQEventProvider({
  connection: {
    host: config.secrets.SECRET_REDIS_HOST,
    port: 6379,
  },

  // Retry configuration
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600 },  // Keep completed jobs for 1 hour
    removeOnFail: false,               // Keep failed jobs for inspection
  },

  // Worker configuration
  defaultWorkerOptions: {
    concurrency: 10,                   // Process 10 events in parallel
    limiter: { max: 100, duration: 1000 }, // Max 100 per second
  },
});

// Pass to application
const app = Ori.create()
  .events(eventProvider)
  // ...
  .listen(8001);
```

### Per-Event-Type Queues

BullMQ creates a **separate queue for each event type**. This is a deliberate architectural decision:

```
Queue: events.user.created      -> Worker (concurrency: 10)
Queue: events.order.placed      -> Worker (concurrency: 5)
Queue: events.email.send        -> Worker (concurrency: 20)
Queue: events.report.generate   -> Worker (concurrency: 1)
```

Why separate queues?

**No Head-of-Line Blocking**: If `report.generate` takes 5 minutes per event, it doesn't block `email.send` which takes 200ms. Each queue processes independently.

**Independent Scaling**: You can set different concurrency per event type. Email sending might have concurrency 20, while report generation has concurrency 1 to avoid overloading the database.

**Isolation**: A failing handler for one event type doesn't affect other types. If `order.placed` is consistently failing due to a downstream service outage, `user.created` keeps processing normally.

**Monitoring**: Separate queues mean separate metrics. You can monitor backlog, processing time, and error rates per event type.

### Scheduled and Delayed Events

BullMQ supports delayed delivery and recurring schedules:

```typescript
// Delayed event -- process after 30 seconds
ctx.events.emit(UserCreated, payload, { delay: 30000 });

// Scheduled recurring event (via provider directly)
await eventProvider.scheduleEvent('cleanup.run', {
  scheduleId: 'daily-cleanup',
  cron: '0 0 * * *',      // Every day at midnight
  payload: { maxAge: 30 },  // Delete records older than 30 days
});

// Remove a schedule
await eventProvider.unscheduleEvent('cleanup.run', 'daily-cleanup');
```

### Distributed Tracing

When an event is emitted, the current request's trace context is automatically captured from AsyncLocalStorage and propagated through the queue:

```
[HTTP Request] correlationId: "req-abc-123"
  -> emit('user.created') -- correlationId propagated to job data
    -> [Worker] EventContext.correlationId: "req-abc-123"
      -> ctx.log.info('Processing') -- log includes correlationId
      -> ctx.emit('email.send') -- causationId: "req-abc-123"
        -> [Worker] EventContext.causationId: "req-abc-123"
```

Every log line, error, and chained event carries the original request's correlation ID. When debugging a failed email, you can trace it back to the exact HTTP request that triggered it.

## Error Handling and Idempotency

### Automatic Retries

BullMQ automatically retries failed events based on your configuration:

```typescript
defaultJobOptions: {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
}
```

This retries up to 5 times with exponential backoff: 2s, 4s, 8s, 16s, 32s.

### Idempotency

Because events can be retried, handlers should be **idempotent** -- processing the same event twice should have the same effect as processing it once. The `EventIdempotency` helper tracks processed event IDs:

```typescript
import { EventIdempotency } from '@orijs/events';

class UserCreatedConsumer implements IEventConsumer<UserData, void> {
  private idempotency = new EventIdempotency();

  onEvent = async (ctx) => {
    const result = await this.idempotency.processOnce(ctx.eventId, async () => {
      await this.db.insertUser(ctx.data);
      await this.emailService.sendWelcome(ctx.data.email);
      return { processed: true };
    });

    if (!result.executed) {
      ctx.log.info('Skipped duplicate event', { eventId: ctx.eventId });
    }
  };
}
```

The in-memory `EventIdempotency` is suitable for single-process deployments. For distributed systems, use Redis-backed idempotency or leverage BullMQ's built-in `jobId`-based deduplication:

```typescript
// Emit with idempotency key -- BullMQ ignores duplicate jobIds
ctx.events.emit(UserCreated, payload, {
  idempotencyKey: `user-created-${userId}`,
});
```

### Dead Letter Queue Pattern

Keep failed jobs for inspection instead of discarding them:

```typescript
defaultJobOptions: {
  attempts: 5,
  removeOnFail: false,  // Failed jobs stay in queue for inspection
}
```

You can then inspect failed jobs through BullMQ's dashboard or programmatically query the queue for failed jobs, examine their error messages, fix the issue, and retry them.

## Testing Events

### Unit Testing Consumers

Test consumer handlers in isolation by creating a mock EventContext:

```typescript
import { describe, test, expect, mock } from 'bun:test';

describe('UserCreatedConsumer', () => {
  test('should send welcome email', async () => {
    const mockEmailService = {
      sendWelcome: mock(() => Promise.resolve(true)),
    };

    const consumer = new UserCreatedConsumer(mockEmailService as EmailService);

    const ctx = {
      eventId: 'evt-123',
      data: { userId: 'usr-456', email: 'alice@test.com' },
      log: { info: mock(), error: mock() },
      emit: mock(),
      correlationId: 'corr-789',
      eventName: 'user.created',
      timestamp: Date.now(),
    };

    const result = await consumer.onEvent(ctx);

    expect(mockEmailService.sendWelcome).toHaveBeenCalledWith('alice@test.com', undefined);
    expect(result).toEqual({ welcomeEmailSent: true });
  });
});
```

### Testing Event Emission

Verify that your controllers emit the correct events:

```typescript
test('should emit user.created event on signup', async () => {
  const emittedEvents: Array<{ event: unknown; data: unknown }> = [];

  // Mock the events emitter
  const mockEvents = {
    emit: mock((event, data) => {
      emittedEvents.push({ event, data });
    }),
  };

  const controller = new UserController(mockUserService);
  const ctx = createMockRequestContext({ events: mockEvents });

  await controller.createUser(ctx);

  expect(emittedEvents).toHaveLength(1);
  expect(emittedEvents[0].event).toBe(UserCreated);
  expect(emittedEvents[0].data).toEqual({
    userId: 'usr-123',
    email: 'alice@test.com',
  });
});
```

### Integration Testing with InProcessEventProvider

For integration tests that verify the full event flow (emit -> queue -> handler), use the `InProcessEventProvider`:

```typescript
import { InProcessEventProvider } from '@orijs/events';

const provider = new InProcessEventProvider();
const events = createEventSystem(registry, { provider });

// Register handler
events.onEvent<UserData>('user.created', async (ctx) => {
  await userService.handleCreated(ctx.data);
  return { handled: true };
});

await events.start();

// Emit and wait for result
const subscription = events.emit('user.created', { userId: 'usr-123' });
// InProcessEventProvider processes synchronously for testing
```

The in-process provider executes handlers synchronously in the same process, making it perfect for tests that need to verify the entire event flow without Redis.

## Writing a Custom Event Provider

The `EventProvider` interface extends two focused interfaces:

```typescript
// What services see (emit + subscribe)
interface EventEmitter<TEventNames extends string = string> {
  emit<TReturn = void>(
    eventName: TEventNames,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions,
  ): EventSubscription<TReturn>;

  subscribe<TPayload = unknown, TReturn = void>(
    eventName: TEventNames,
    handler: EventHandlerFn<TPayload, TReturn>,
  ): void | Promise<void>;
}

// What the framework manages (start + stop)
interface EventLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Full provider interface (combines both)
interface EventProvider<TEventNames extends string = string>
  extends EventEmitter<TEventNames>, EventLifecycle {}
```

### Example: Simple In-Memory Provider

```typescript
import type {
  EventProvider,
  EventHandlerFn,
  EmitOptions,
  EventMessage,
  EventSubscription,
} from '@orijs/events';
import { createSubscription, EVENT_MESSAGE_VERSION } from '@orijs/events';

class SimpleEventProvider implements EventProvider {
  private handlers = new Map<string, EventHandlerFn[]>();

  emit<TReturn = void>(
    eventName: string,
    payload: unknown,
    meta?: PropagationMeta,
    options?: EmitOptions,
  ): EventSubscription<TReturn> {
    const subscription = createSubscription<TReturn>();

    const message: EventMessage = {
      version: EVENT_MESSAGE_VERSION,
      eventId: crypto.randomUUID(),
      eventName,
      payload,
      meta: meta ?? {},
      correlationId: subscription.correlationId,
      causationId: options?.causationId,
      timestamp: Date.now(),
    };

    // Process asynchronously
    setTimeout(async () => {
      const handlers = this.handlers.get(eventName) ?? [];
      for (const handler of handlers) {
        try {
          const result = await handler(message);
          subscription._resolve(result as TReturn);
        } catch (error) {
          subscription._reject(error as Error);
        }
      }
    }, options?.delay ?? 0);

    return subscription;
  }

  subscribe<TPayload = unknown, TReturn = void>(
    eventName: string,
    handler: EventHandlerFn<TPayload, TReturn>,
  ): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler as EventHandlerFn);
    this.handlers.set(eventName, existing);
  }

  async start(): Promise<void> {
    // Nothing to initialize for in-memory
  }

  async stop(): Promise<void> {
    this.handlers.clear();
  }
}
```

### Using a Custom Provider

```typescript
const app = Ori.create()
  .events(new SimpleEventProvider())     // Swap in your custom provider
  .event(UserCreated).consumer(UserCreatedConsumer, [EmailService])
  .listen(8001);
```

No other code changes. Event definitions, consumers, and emission code work identically regardless of which provider is used. That's the power of the provider pattern.

### Provider Design Considerations

When writing a production-quality provider, consider:

- **Persistence**: In-memory providers lose events on restart. Production providers should persist to a durable store (Redis, RabbitMQ, Kafka).
- **Retry Logic**: Implement retry with backoff for failed handlers.
- **Concurrency Control**: Limit how many events are processed simultaneously.
- **Graceful Shutdown**: Wait for in-flight handlers to complete before stopping.
- **Context Propagation**: Carry `PropagationMeta` through your transport layer so correlation IDs survive the journey from emitter to handler.
- **Request-Response**: The `EventSubscription` returned by `emit()` needs to be resolved when the handler completes. For distributed providers, this requires a completion notification mechanism (BullMQ uses QueueEvents).

## Event Registry (Advanced)

For applications that build event systems programmatically (not through `Event.define()`), the lower-level `EventRegistry` provides compile-time type safety for event names:

```typescript
import { EventRegistry, createEventSystem } from '@orijs/events';

const Events = EventRegistry.create()
  .event('user.created')
  .event('order.placed')
  .event('payment.processed')
  .build();

// Type-safe: only registered event names are allowed
const events = createEventSystem(Events);
events.emit('user.created', payload);     // OK
events.emit('user.deleted', payload);     // TypeScript error!
```

The registry supports modular composition with `.use()`:

```typescript
function addUserEvents<T extends string>(reg: EventRegistryBuilder<T>) {
  return reg
    .event('user.created')
    .event('user.updated')
    .event('user.deleted');
}

function addOrderEvents<T extends string>(reg: EventRegistryBuilder<T>) {
  return reg
    .event('order.placed')
    .event('order.shipped')
    .event('order.cancelled');
}

const Events = EventRegistry.create()
  .use(addUserEvents)
  .use(addOrderEvents)
  .build();
```

This is useful for large applications where event definitions are spread across multiple modules.

## Summary

OriJS events solve the fundamental problem of decoupling request handling from background processing:

- **Event.define()** creates type-safe event definitions with TypeBox schemas and the type carrier pattern
- **IEventConsumer** provides a clean interface for handling events with lifecycle hooks
- **BullMQ provider** gives you production-ready persistent queues with per-event-type isolation, retries, and scheduled events
- **Distributed tracing** automatically propagates correlation IDs through event chains
- **EventIdempotency** prevents duplicate processing in retry scenarios
- **EventProvider interface** lets you swap BullMQ for any other queue technology

The key insight is that BullMQ is a **provider**, not the event system itself. The event definitions, consumers, and emission code are provider-agnostic. Today you use BullMQ with Redis. Tomorrow you might use Kafka for high-throughput streams. You swap the provider and everything else stays the same.

---

[Previous: Data Mapping ←](./10-data-mapping.md) | [Next: Workflows →](./12-workflows.md)
