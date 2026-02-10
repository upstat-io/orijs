# Chapter 10: Events

Events are how OriJS applications handle asynchronous processing. When something happens in your system (a user signs up, a monitor detects an outage, a payment processes), you emit an event, and one or more consumers handle it independently.

## Why Events?

Consider a user registration flow without events:

```typescript
class UserService {
  async register(input: CreateUserInput) {
    const user = await this.userRepo.create(input);
    await this.emailService.sendWelcomeEmail(user);      // Blocks the response
    await this.analyticsService.trackSignup(user);        // Blocks further
    await this.billingService.createFreePlan(user);       // Blocks even more
    await this.slackService.notifyTeam(user);             // And more blocking
    return user;
  }
}
```

Problems:
1. **Slow responses.** The user waits for all downstream actions to complete.
2. **Tight coupling.** `UserService` knows about emails, analytics, billing, and Slack.
3. **Fragile.** If Slack is down, user registration fails.
4. **Hard to extend.** Adding a new action means modifying `UserService`.

With events:

```typescript
class UserService {
  constructor(private ctx: AppContext) {}

  async register(input: CreateUserInput) {
    const user = await this.userRepo.create(input);

    // Fire and forget — returns immediately
    await this.ctx.events.emit(UserRegistered, {
      userId: user.uuid,
      email: user.email,
      name: user.name,
    });

    return user;  // Responds in milliseconds
  }
}
```

Now the consumers handle each concern independently:

```typescript
class WelcomeEmailConsumer implements OriConsumer<typeof UserRegistered> {
  event = UserRegistered;

  async handle(ctx: EventContext<typeof UserRegistered>) {
    await this.emailService.sendWelcome(ctx.data.email, ctx.data.name);
  }
}

class SignupAnalyticsConsumer implements OriConsumer<typeof UserRegistered> {
  event = UserRegistered;

  async handle(ctx: EventContext<typeof UserRegistered>) {
    await this.analytics.track('user_signup', { userId: ctx.data.userId });
  }
}
```

Benefits:
1. **Fast responses.** The event is enqueued and the handler returns immediately.
2. **Loose coupling.** `UserService` doesn't know about emails, analytics, or anything downstream.
3. **Resilient.** If the email service is down, the event stays in the queue and retries.
4. **Extensible.** Add a new consumer without touching `UserService`.

## Defining Events

Events are defined using `Event.define()` with a TypeBox schema:

```typescript
import { Event } from '@orijs/events';
import { Type } from '@orijs/validation';

const UserRegistered = Event.define({
  name: 'user.registered',
  schema: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    email: Type.String({ format: 'email' }),
    name: Type.String(),
    registeredAt: Type.String({ format: 'date-time' }),
  }),
});
```

The `Event.define()` call creates an **event definition** that carries:
- **`name`**: A unique string identifier for the event. Use dot-notation namespacing (`domain.action`) for clarity.
- **`schema`**: A TypeBox schema that defines the event payload. This is validated when the event is emitted, ensuring consumers always receive valid data.

The event definition is a **type carrier** — it carries the TypeScript type of the payload without being an instance of anything. Think of it as a typed key that both producers and consumers use to agree on the data shape.

### Why Type Carriers?

Other frameworks define events as classes:

```typescript
// NestJS / class-based approach
class UserRegisteredEvent {
  constructor(
    public userId: string,
    public email: string,
    public name: string,
  ) {}
}
```

OriJS uses type carriers instead because:

1. **Serialization is automatic.** Event payloads must be serialized to cross process boundaries (queues, Redis, etc.). TypeBox schemas are already JSON-compatible, while classes require custom serialization.
2. **Validation is built in.** The schema validates the payload when emitted, catching errors at the source instead of in consumers.
3. **No class inheritance issues.** Class-based events often lead to complex inheritance hierarchies. Type carriers are flat and composable.

## Emitting Events

Emit events through `AppContext` or `EventContext`:

```typescript
// In a service (via AppContext)
class OrderService {
  constructor(private ctx: AppContext) {}

  async placeOrder(input: PlaceOrderInput) {
    const order = await this.orderRepo.create(input);

    await this.ctx.events.emit(OrderPlaced, {
      orderId: order.uuid,
      customerId: input.customerId,
      total: order.total,
      placedAt: new Date().toISOString(),
    });

    return order;
  }
}

// In an event consumer (via EventContext)
class OrderFulfillmentConsumer implements OriConsumer<typeof OrderPlaced> {
  event = OrderPlaced;

  async handle(ctx: EventContext<typeof OrderPlaced>) {
    // Process the order...
    await this.fulfillmentService.process(ctx.data.orderId);

    // Emit a follow-up event
    await ctx.events.emit(OrderFulfilled, {
      orderId: ctx.data.orderId,
      fulfilledAt: new Date().toISOString(),
    });
  }
}
```

The `emit()` method:
1. Validates the payload against the event's TypeBox schema
2. Enqueues the event with the configured provider (BullMQ)
3. Returns a promise that resolves when the event is enqueued (not when it's processed)

## Consuming Events

A consumer is a class that implements `OriConsumer<TEvent>`:

```typescript
import type { OriConsumer, EventContext } from '@orijs/events';

class OrderNotificationConsumer implements OriConsumer<typeof OrderPlaced> {
  event = OrderPlaced;  // Which event this consumer handles

  constructor(private notificationService: NotificationService) {}

  async handle(ctx: EventContext<typeof OrderPlaced>) {
    const { orderId, customerId } = ctx.data;  // Fully typed!

    ctx.log.info('Sending order notification', { orderId, customerId });

    await this.notificationService.sendOrderConfirmation(orderId, customerId);
  }
}
```

Register consumers with the application:

```typescript
Ori.create()
  .events({ provider: bullmqProvider })
  .consumer(OrderNotificationConsumer, [NotificationService])
  .consumer(OrderFulfillmentConsumer, [FulfillmentService])
  .listen(3000);
```

### Multiple Consumers per Event

Multiple consumers can listen to the same event. Each runs independently:

```typescript
// All three consumers run when UserRegistered is emitted
app
  .consumer(WelcomeEmailConsumer, [EmailService])
  .consumer(SignupAnalyticsConsumer, [AnalyticsService])
  .consumer(BillingSetupConsumer, [BillingService]);
```

Each consumer gets its own copy of the event data and runs in its own BullMQ job. If one consumer fails, the others are unaffected.

## BullMQ Provider

OriJS uses BullMQ for event processing. BullMQ provides:

- **Persistent queues** backed by Redis — events survive process restarts
- **Automatic retries** with configurable backoff strategies
- **Concurrency control** — process N events in parallel per worker
- **Rate limiting** — prevent overwhelming downstream services
- **Job scheduling** — delay event processing or schedule for specific times

### Configuration

```typescript
import { createBullMQProvider } from '@orijs/bullmq';

const bullmqProvider = createBullMQProvider({
  connection: {
    host: 'localhost',
    port: 6379,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,  // 1s, 2s, 4s
    },
    removeOnComplete: { age: 3600 },  // Clean up after 1 hour
    removeOnFail: { age: 86400 },     // Keep failed jobs for 1 day
  },
});

Ori.create()
  .events({ provider: bullmqProvider })
  // ...
```

### Per-Event-Type Queues

OriJS creates a **separate BullMQ queue for each event type**. This is a significant architectural decision:

```
Queue: "events:user.registered"    → WelcomeEmailConsumer, AnalyticsConsumer
Queue: "events:order.placed"       → NotificationConsumer, FulfillmentConsumer
Queue: "events:payment.completed"  → ReceiptConsumer, RevenueConsumer
```

**Why per-event-type queues?**

Most event systems (including basic BullMQ usage) put all events on a single queue. This creates problems at scale:

1. **Head-of-line blocking.** A slow consumer processing `payment.completed` events blocks `user.registered` events in the same queue.
2. **No independent scaling.** You can't add more workers for a specific high-volume event type.
3. **No independent retry policies.** A payment event might need 10 retries, while a notification event might need 3.
4. **Monitoring is harder.** Queue length tells you nothing about which event types are backed up.

Per-event-type queues solve all of these. Each event type has its own queue, its own worker, and its own retry policy. You can scale, monitor, and tune each event type independently.

## Scheduled Events

Emit events that should be processed at a future time:

```typescript
// Send a follow-up email 24 hours after signup
await ctx.events.emit(SendFollowUpEmail, {
  userId: user.uuid,
  email: user.email,
}, {
  delay: 24 * 60 * 60 * 1000,  // 24 hours in milliseconds
});

// Or use a specific date
await ctx.events.emit(SubscriptionRenewalReminder, {
  userId: user.uuid,
  renewalDate: subscription.renewsAt,
}, {
  delay: new Date(subscription.renewsAt).getTime() - Date.now() - 72 * 60 * 60 * 1000,
  // 72 hours before renewal
});
```

BullMQ stores the delayed job in Redis and processes it when the delay expires. This is more reliable than `setTimeout` — the delay survives process restarts.

## Distributed Tracing

OriJS automatically propagates trace context through event chains:

```
HTTP Request (requestId: abc-123)
  → Emit UserRegistered (traceId: abc-123)
    → WelcomeEmailConsumer (traceId: abc-123)
      → Emit WelcomeEmailSent (traceId: abc-123)
    → AnalyticsConsumer (traceId: abc-123)
```

The `traceId` links all events in a chain back to the originating request. Consumers receive it automatically in `ctx.traceId`:

```typescript
async handle(ctx: EventContext<typeof UserRegistered>) {
  ctx.log.info('Processing signup', {
    userId: ctx.data.userId,
    traceId: ctx.traceId,  // abc-123 — from the original HTTP request
  });
}
```

This makes it possible to trace a user action through the entire system, across multiple services and event hops, using a single trace ID.

## Error Handling

### Consumer Errors

If a consumer throws an error, BullMQ retries the job according to the configured retry policy:

```typescript
class PaymentConsumer implements OriConsumer<typeof OrderPlaced> {
  event = OrderPlaced;

  async handle(ctx: EventContext<typeof OrderPlaced>) {
    const result = await this.paymentService.charge(ctx.data.orderId);

    if (!result.success) {
      // Throwing causes BullMQ to retry
      throw new Error(`Payment failed: ${result.error}`);
    }
  }
}
```

After all retries are exhausted, the job moves to the "failed" state in Redis, where you can inspect it via BullMQ's dashboard or API.

### Idempotency

Because events can be retried, consumers **must be idempotent** — processing the same event twice should produce the same result as processing it once:

```typescript
class PaymentConsumer implements OriConsumer<typeof OrderPlaced> {
  event = OrderPlaced;

  async handle(ctx: EventContext<typeof OrderPlaced>) {
    // Idempotency check — don't charge twice
    const existingPayment = await this.paymentRepo.findByOrderId(ctx.data.orderId);
    if (existingPayment) {
      ctx.log.info('Payment already processed, skipping', { orderId: ctx.data.orderId });
      return;
    }

    await this.paymentService.charge(ctx.data.orderId);
  }
}
```

## Testing Events

### Unit Testing Consumers

```typescript
import { createMockEventContext } from '@orijs/test-utils';

describe('WelcomeEmailConsumer', () => {
  it('should send welcome email', async () => {
    const emailService = { sendWelcome: vi.fn() };
    const consumer = new WelcomeEmailConsumer(emailService);

    const ctx = createMockEventContext(UserRegistered, {
      userId: 'user-123',
      email: 'alice@example.com',
      name: 'Alice',
      registeredAt: new Date().toISOString(),
    });

    await consumer.handle(ctx);

    expect(emailService.sendWelcome).toHaveBeenCalledWith(
      'alice@example.com',
      'Alice',
    );
  });
});
```

### Integration Testing

For testing that events flow correctly end-to-end, use a test BullMQ connection:

```typescript
describe('User Registration Flow', () => {
  it('should emit UserRegistered event on signup', async () => {
    const emittedEvents: unknown[] = [];

    // Capture emitted events instead of processing them
    const testProvider = createTestEventProvider({
      onEmit: (event, data) => emittedEvents.push({ event, data }),
    });

    const app = Ori.create()
      .events({ provider: testProvider })
      .provider(UserService, [UserRepository, AppContext])
      .listen(0);

    const userService = app.getContainer().resolve(UserService);
    await userService.register({ email: 'test@example.com', name: 'Test' });

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      event: UserRegistered,
      data: { email: 'test@example.com', name: 'Test' },
    });

    await app.stop();
  });
});
```

## Summary

OriJS's event system provides:

1. **Type-safe event definitions** with TypeBox schemas and type carrier pattern
2. **BullMQ-backed processing** with persistent queues, retries, and scheduling
3. **Per-event-type queues** for independent scaling, monitoring, and retry policies
4. **Distributed tracing** that automatically propagates trace IDs through event chains
5. **Scheduled events** for delayed processing without `setTimeout`
6. **Testable design** with mock contexts and test providers

Events are the foundation for building loosely-coupled, resilient systems. The next chapter builds on events to introduce workflows — coordinated multi-step processes.

[Previous: Configuration ←](./08-configuration.md) | [Next: Workflows →](./11-workflows.md)
