# @orijs/events

Type-safe event system for OriJS with event registry, handlers, and in-process/distributed delivery.

## Installation

```bash
bun add @orijs/events
```

## Quick Start

```typescript
import { EventRegistry, createEventSystem, InProcessEventProvider } from '@orijs/events';

// Define events with typed payloads
const Events = EventRegistry.create()
  .event<{ userId: string; email: string }>('user.created')
  .event<{ orderId: string; total: number }>('order.placed')
  .build();

// Create event system with in-process provider
const events = createEventSystem(Events);

// Register handler
events.onEvent('user.created', async (ctx) => {
  console.log('User created:', ctx.data.userId);
});

// Emit event
await events.emit('user.created', { userId: '123', email: 'alice@example.com' });
```

## Features

- **Type-Safe Events** - Define events with TypeScript types
- **Event Registry** - Fluent builder for event definitions
- **Multiple Providers** - In-process, BullMQ, or custom providers
- **Idempotency** - Built-in idempotency key support
- **Event Context** - Rich context with logging and metadata

## Application Integration

```typescript
import { Ori, Event } from '@orijs/core';

// Define event using core Event helper
const UserCreated = Event.define({
  name: 'user.created',
  data: Type.Object({ userId: Type.String() })
});

// Register in application
Ori.create()
  .event(UserCreated)
    .handler(async (ctx) => {
      ctx.log.info('Processing user created event');
    })
  .listen(3000);

// Emit from request handler
r.post('/users', async (ctx) => {
  const user = await userService.create(ctx.body);
  await ctx.events.emit(UserCreated, { userId: user.id });
  return Response.json(user, { status: 201 });
});
```

## Event Subscription (Request-Response)

```typescript
import { createSubscription } from '@orijs/events';

// Create subscription for waiting on events
const subscription = createSubscription<{ orderId: string }>();

// Wait for event with timeout
const result = await subscription.waitFor(
  (data) => data.orderId === '123',
  { timeoutMs: 5000 }
);
```

## Documentation

See the [Events Guide](../../docs/guides/events.md) for more details.

## License

MIT
