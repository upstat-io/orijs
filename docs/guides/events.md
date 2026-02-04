# Events

OriJS provides a type-safe event system for decoupling components with pub/sub patterns.

---

## Overview

The event system enables:

- **Decoupled communication** - Components don't need direct references
- **Type-safe events** - TypeBox schemas ensure correct payloads at compile and runtime
- **Distributed tracing** - Correlation and causation IDs flow through events
- **Request-response** - Await event handler results when needed
- **Scheduled events** - Cron and interval-based recurring events

---

## Defining Events

Use `Event.define()` to create type-safe event definitions with TypeBox schemas:

```typescript
import { Event } from '@orijs/core';
import { Type } from '@orijs/validation';

// Fire-and-forget event (no response expected)
export const UserCreated = Event.define({
	name: 'user.created',
	payload: Type.Object({
		userId: Type.String(),
		email: Type.String()
	}),
	response: Type.Void()
});

// Request-response event (returns a value)
export const MonitorCheck = Event.define({
	name: 'monitor.check',
	payload: Type.Object({
		monitorId: Type.String()
	}),
	response: Type.Object({
		status: Type.Union([Type.Literal('up'), Type.Literal('down')]),
		latency: Type.Number()
	})
});
```

**Naming Convention**: Use `entity.action` format (e.g., `user.created`, `order.shipped`).

---

## Understanding the Type System

### The Type Carrier Pattern

Event definitions include special fields (`_payload` and `_response`) that enable TypeScript's type system to work with TypeBox schemas. These fields are a design pattern called "type carriers."

**The Problem**: TypeBox schemas like `Type.Object({ userId: Type.String() })` are runtime objects with complex generic types. TypeScript cannot easily extract the corresponding TypeScript type from a runtime value.

**The Solution**: Type carrier fields that are:

- **Always `undefined` at runtime** (zero memory/performance cost)
- **Typed as `TPayload` / `TResponse` at compile time**
- **Extractable via `typeof MyEvent['_payload']`** or utility types

```typescript
// What Event.define() creates internally:
const UserCreated = Object.freeze({
	name: 'user.created',
	payloadSchema: Type.Object({ userId: Type.String() }), // For runtime validation
	responseSchema: Type.Void(),
	_payload: undefined as unknown as { userId: string }, // Type carrier (compile-time only)
	_response: undefined as unknown as void // Type carrier (compile-time only)
});

// At runtime: UserCreated._payload === undefined
// At compile time: typeof UserCreated['_payload'] = { userId: string }
```

### Why `as unknown as T`?

The double assertion (`undefined as unknown as T`) tells TypeScript "trust me, this value has type T for type-checking purposes." This is safe because:

1. The value is **never accessed at runtime** - it's only for the type system
2. TypeScript won't allow `undefined as { userId: string }` directly
3. The intermediate `unknown` allows any type conversion

### Using Utility Types (Recommended)

Always prefer utility types over direct property access:

```typescript
import { type Consumer, type Payload, type Response, type EventCtx } from '@orijs/core';

// ✅ RECOMMENDED: Utility types
type UserPayload = Payload<typeof UserCreated>; // { userId: string; email: string }
type UserResponse = Response<typeof UserCreated>; // void
type UserContext = EventCtx<typeof UserCreated>; // EventContext<{ userId: string; email: string }>

// ✅ GOOD: Consumer utility type (infers from definition)
class MyConsumer implements Consumer<typeof UserCreated> {
	onEvent = async (ctx) => {
		// ctx.data is fully typed as { userId: string; email: string }
	};
}

// ❌ AVOID: Direct property access (works but verbose)
type PayloadDirect = (typeof UserCreated)['_payload'];

// ❌ NEVER: Runtime access (always undefined!)
const payload = UserCreated._payload; // undefined - don't do this!
```

### TypeBox's Static<T> Utility

The type carrier pattern works in conjunction with TypeBox's `Static<T>` utility:

```typescript
import { Type, type Static } from '@orijs/validation';

const UserSchema = Type.Object({
	userId: Type.String(),
	email: Type.String({ format: 'email' })
});

// Static<T> extracts the TypeScript type from a TypeBox schema
type User = Static<typeof UserSchema>; // { userId: string; email: string }
```

When you call `Event.define()`, the factory uses `Static<T>` internally to extract the TypeScript types from your schemas and store them in the type carriers.

---

## Event Consumers

Consumers handle events when they're emitted. Use arrow function properties for correct `this` binding:

```typescript
import { type Consumer } from '@orijs/core';

class UserCreatedConsumer implements Consumer<typeof UserCreated> {
	constructor(
		private emailService: EmailService,
		private analyticsService: AnalyticsService
	) {}

	// Main handler (required) - must be arrow function
	onEvent = async (ctx) => {
		const { userId, email } = ctx.data;

		ctx.log.info('Handling user.created', { userId });

		await this.emailService.sendWelcome(email);
		await this.analyticsService.track('user_signup', { userId });

		// Return void for fire-and-forget events
	};

	// Optional: called after successful completion
	onSuccess = async (ctx, result) => {
		ctx.log.info('Event processed successfully', { eventId: ctx.eventId });
	};

	// Optional: called when onEvent throws
	onError = async (ctx, error) => {
		ctx.log.error('Event processing failed', { error: error.message });
	};
}
```

### Why Arrow Functions?

Arrow function properties capture `this` at definition time. When the framework calls `consumer.onEvent(ctx)`, regular methods would have `this` as undefined because the method reference is detached from the instance.

```typescript
class MyConsumer implements Consumer<typeof MyEvent> {
	constructor(private service: MyService) {}

	// Arrow function - this.service works correctly
	onEvent = async (ctx) => {
		await this.service.process(ctx.data);
	};

	// Regular method - this would be undefined when called
	// async onEvent(ctx) { ... }
}
```

---

## Application Registration

Register events and consumers with the fluent API:

```typescript
import { Ori } from '@orijs/core';
import { BullMQEventProvider } from '@orijs/bullmq';

Ori.create()
	// Set the event provider (BullMQ for production)
	.eventProvider(new BullMQEventProvider({ connection: { host: 'redis', port: 6379 } }))

	// Register event with consumer and dependencies
	.event(UserCreated)
	.consumer(UserCreatedConsumer, [EmailService, AnalyticsService])

	// Emitter-only: register event without consumer (for cross-service events)
	.event(OrderPlaced)

	.listen(3000);
```

### Extension Pattern

For cleaner setup, use extension functions:

```typescript
// events.ts
export function addEvents(app: Application, redis: Redis): Application {
	return app
		.eventProvider(new BullMQEventProvider({ connection: redis }))
		.event(UserCreated)
		.consumer(UserCreatedConsumer, [EmailService])
		.event(OrderPlaced)
		.consumer(OrderConsumer, [OrderService]);
}

// app.ts
Ori.create()
	.use((app) => addEvents(app, redis))
	.listen(3000);
```

---

## Emitting Events

Events are emitted using the definition object, not string names. This provides compile-time type safety.

### From Controllers

```typescript
import { UserCreated } from './event-definitions';

class UserController implements OriController {
	constructor(private userService: UserService) {}

	configure(r: RouteBuilder) {
		r.post('/users', this.createUser);
	}

	private createUser = async (ctx: RequestContext) => {
		const data = await ctx.json<CreateUserDto>();
		const user = await this.userService.create(data);

		// Type-safe emit - payload validated against TypeBox schema
		// Response is typed based on event definition
		await ctx.events.emit(UserCreated, {
			userId: user.id,
			email: user.email
		});

		return ctx.json({ user }, 201);
	};
}
```

### Request-Response Pattern

For events that return values, the response is typed:

```typescript
import { MonitorCheck } from './event-definitions';

class MonitorController implements OriController {
	private checkMonitor = async (ctx: RequestContext) => {
		const { monitorId } = ctx.params;

		// result is typed as { status: 'up' | 'down', latency: number }
		const result = await ctx.events.emit(MonitorCheck, { monitorId });

		return ctx.json({
			status: result.status,
			latency: result.latency
		});
	};
}
```

---

## EventContext

Event handlers receive an `EventContext` with payload and metadata:

```typescript
interface EventContext<TPayload> {
	/** Unique event instance ID */
	readonly eventId: string;
	/** The event payload data */
	readonly data: TPayload;
	/** Logger with propagated context */
	readonly log: Logger;
	/** Event name (matches definition) */
	readonly eventName: string;
	/** Timestamp when emitted (ms since epoch) */
	readonly timestamp: number;
	/** Request/operation correlation ID */
	readonly correlationId: string;
	/** ID of parent event (for chain tracking) */
	readonly causationId?: string;
}
```

### Accessing Context in Handlers

```typescript
onEvent = async (ctx) => {
	ctx.log.info('Processing event', {
		eventId: ctx.eventId,
		eventName: ctx.eventName,
		correlationId: ctx.correlationId
	});

	const { orderId, items } = ctx.data;
	// Process...
};
```

---

## Type Utilities

OriJS provides utility types for extracting types from event definitions:

```typescript
import { type Consumer, type Payload, type Response, type EventCtx } from '@orijs/core';

// Extract payload type
type UserPayload = Payload<typeof UserCreated>; // { userId: string; email: string }

// Extract response type
type UserResponse = Response<typeof UserCreated>; // void

// Get the consumer interface - cleaner than manual typing
type UserConsumer = Consumer<typeof UserCreated>; // IEventConsumer<UserPayload, void>

// Get typed context
type UserContext = EventCtx<typeof UserCreated>; // EventContext<UserPayload>
```

### Using Consumer Utility Type

The `Consumer<T>` utility type provides cleaner type inference than manually extracting types:

```typescript
import { type Consumer } from '@orijs/core';

// Clean: uses utility type
class UserCreatedConsumer implements Consumer<typeof UserCreated> {
	onEvent = async (ctx) => {
		// ctx.data is fully typed as { userId: string; email: string }
		const { userId, email } = ctx.data;
	};
}

// Equivalent but verbose
class UserCreatedConsumer implements IEventConsumer<
	(typeof UserCreated)['_payload'],
	(typeof UserCreated)['_response']
> {
	// ...
}
```

---

## BullMQ Provider Configuration

The `BullMQEventProvider` offers comprehensive configuration for production:

### Connection Options

```typescript
const provider = new BullMQEventProvider({
	connection: {
		host: 'redis',
		port: 6379,
		password: process.env.REDIS_PASSWORD,
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
		connectTimeout: 10000,
		tls: { rejectUnauthorized: true }
	}
});
```

### Job Options (Retries, Backoff, Cleanup)

```typescript
const provider = new BullMQEventProvider({
	connection: { host: 'redis', port: 6379 },
	defaultJobOptions: {
		attempts: 5,
		backoff: {
			type: 'exponential',
			delay: 2000
		},
		removeOnComplete: { age: 3600, count: 1000 },
		removeOnFail: false // Keep failed jobs (DLQ behavior)
	}
});
```

### Worker Options (Concurrency, Rate Limiting)

```typescript
const provider = new BullMQEventProvider({
	connection: { host: 'redis', port: 6379 },
	defaultWorkerOptions: {
		concurrency: 10,
		limiter: {
			max: 100,
			duration: 1000 // 100 jobs/second
		},
		stalledInterval: 30000
	}
});
```

---

## Scheduled Events

Schedule recurring events using cron patterns or fixed intervals.

### Cron-Based Scheduling

```typescript
const provider = new BullMQEventProvider({
	connection: { host: 'redis', port: 6379 }
});

// Hourly cleanup
await provider.scheduleEvent(CleanupRun.name, {
	scheduleId: 'hourly-cleanup',
	cron: '0 * * * *',
	payload: { type: 'expired' }
});

// Daily report at midnight
await provider.scheduleEvent(ReportGenerate.name, {
	scheduleId: 'daily-report',
	cron: '0 0 * * *',
	payload: { reportType: 'daily' }
});
```

### Cron Pattern Reference

| Pattern       | Description              |
| ------------- | ------------------------ |
| `* * * * *`   | Every minute             |
| `*/5 * * * *` | Every 5 minutes          |
| `0 * * * *`   | Every hour               |
| `0 0 * * *`   | Every day at midnight    |
| `0 0 * * 0`   | Every Sunday at midnight |
| `0 0 1 * *`   | First day of every month |

### Interval-Based Scheduling

```typescript
// Every 30 seconds
await provider.scheduleEvent(HealthPing.name, {
	scheduleId: 'health-check',
	every: 30000,
	payload: {}
});
```

### Unscheduling Events

```typescript
await provider.unscheduleEvent(CleanupRun.name, 'hourly-cleanup');
```

---

## Distributed Tracing

OriJS events automatically propagate request context for distributed observability.

When emitting events from a request handler via `ctx.events.emit()`, the request ID is automatically included as correlation metadata:

```typescript
private createUser = async (ctx: RequestContext) => {
	const user = await this.userService.create(data);

	// Request ID automatically propagated as correlationId
	await ctx.events.emit(UserCreated, { userId: user.id, email: user.email });

	return ctx.json(user);
};
```

**Trace Flow:**

```
Request (requestId: 'req-123')
  └─ user.created (eventId: 'evt-1', correlationId: 'req-123')
```

---

## Production Patterns

### Dead Letter Queue (DLQ) Handling

```typescript
const provider = new BullMQEventProvider({
	connection: { host: 'redis', port: 6379 },
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: 'exponential', delay: 1000 },
		removeOnFail: false // Keep failed jobs
	}
});

// Process failed jobs later
const queue = new Queue('events.order.placed', { connection });
const failedJobs = await queue.getFailed(0, 100);

for (const job of failedJobs) {
	console.log('Failed:', job.failedReason);
	await job.retry();
}
```

### Graceful Shutdown

The BullMQ provider handles shutdown order automatically:

```typescript
process.on('SIGTERM', async () => {
	// Stops in correct order:
	// 1. Workers (wait for current jobs)
	// 2. QueueEvents (completion tracking)
	// 3. Scheduled event queues
	await provider.stop();
	process.exit(0);
});
```

### High-Throughput Configuration

```typescript
const provider = new BullMQEventProvider({
	connection: { host: 'redis', port: 6379, maxRetriesPerRequest: 3 },
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: 'exponential', delay: 1000 },
		removeOnComplete: { count: 100 },
		removeOnFail: { count: 1000 }
	},
	defaultWorkerOptions: {
		concurrency: 50,
		limiter: { max: 1000, duration: 1000 }
	}
});
```

---

## Testing Events

### Unit Testing Consumers

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('UserCreatedConsumer', () => {
	it('sends welcome email on user.created', async () => {
		const emailService = { sendWelcome: mock(() => Promise.resolve()) };
		const analyticsService = { track: mock(() => Promise.resolve()) };

		const consumer = new UserCreatedConsumer(emailService, analyticsService);

		const ctx = {
			eventId: 'evt-1',
			data: { userId: 'user-123', email: 'test@example.com' },
			eventName: 'user.created',
			timestamp: Date.now(),
			correlationId: 'corr-1',
			log: { info: () => {}, error: () => {} }
		};

		await consumer.onEvent(ctx);

		expect(emailService.sendWelcome).toHaveBeenCalledWith('test@example.com');
		expect(analyticsService.track).toHaveBeenCalledWith('user_signup', { userId: 'user-123' });
	});
});
```

### Integration Testing with BullMQ

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer } from 'testcontainers';

describe('BullMQ Event Integration', () => {
	let redisContainer;
	let provider: BullMQEventProvider;

	beforeAll(async () => {
		redisContainer = await new GenericContainer('redis:7').withExposedPorts(6379).start();

		provider = new BullMQEventProvider({
			connection: {
				host: redisContainer.getHost(),
				port: redisContainer.getMappedPort(6379)
			}
		});
	});

	afterAll(async () => {
		await provider.stop();
		await redisContainer.stop();
	});

	it('processes events through BullMQ', async () => {
		const received: unknown[] = [];

		await provider.subscribe('test.event', async (msg) => {
			received.push(msg.payload);
			return { processed: true };
		});

		provider.emit('test.event', { data: 'test' }, {});

		await Bun.sleep(500);

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ data: 'test' });
	});
});
```

---

## Best Practices

### 1. Export Event Definitions

Define events in a shared location so both emitters and consumers can import them:

```typescript
// event-definitions.ts
export const UserCreated = Event.define({
	name: 'user.created',
	payload: Type.Object({ userId: Type.String(), email: Type.String() }),
	response: Type.Void()
});

export const OrderPlaced = Event.define({
	name: 'order.placed',
	payload: Type.Object({ orderId: Type.String(), total: Type.Number() }),
	response: Type.Void()
});
```

### 2. Use Specific Event Names

```typescript
// GOOD - specific and clear
'user.email.changed';
'order.payment.failed';
'monitor.check.completed';

// BAD - too generic
'updated';
'changed';
'done';
```

### 3. Include Enough Context

```typescript
// GOOD - enough context to process
{ orderId: 'ord-123', userId: 'user-456', totalAmount: 99.99 }

// BAD - requires additional lookups
{ orderId: 'ord-123' }
```

### 4. Make Handlers Idempotent

Events may be delivered more than once:

```typescript
onEvent = async (ctx) => {
	const order = await this.orderService.find(ctx.data.orderId);
	if (order.paymentStatus === 'paid') {
		ctx.log.info('Already paid, skipping');
		return;
	}
	await this.orderService.markPaid(ctx.data.orderId);
};
```

### 5. Log Event Processing

```typescript
onEvent = async (ctx) => {
	ctx.log.info('Processing event', {
		orderId: ctx.data.orderId,
		eventId: ctx.eventId
	});

	try {
		await this.processOrder(ctx.data);
		ctx.log.info('Order processed successfully');
	} catch (error) {
		ctx.log.error('Order processing failed', { error });
		throw error;
	}
};
```

---

## Architecture: Per-Event-Type Queues

The BullMQ provider uses **per-event-type queues** for isolation:

```
events.user.created     → [Worker 1] [Worker 2]
events.order.placed     → [Worker 1] [Worker 2]
events.payment.charged  → [Worker 1]
```

**Benefits:**

- **Isolation** - Slow handlers don't block other event types
- **Scaling** - Scale workers independently per event type
- **Monitoring** - Easy to see backlog per event type
- **Prioritization** - More workers for critical events

---

## Validation

### How Validation Works

All payloads and responses are validated at runtime using TypeBox:

1. **On Emit**: Payload validated against `payloadSchema` before queuing
2. **On Handler Return**: Response validated against `responseSchema` before completing

```typescript
// This will throw if payload doesn't match schema
await ctx.events.emit(UserCreated, {
	userId: 123, // ❌ Error: expected string, got number
	email: 'test@example.com'
});
```

### Handling Validation Errors

Validation errors include details about what failed:

```typescript
try {
	await ctx.events.emit(UserCreated, invalidPayload);
} catch (error) {
	if (error.message.includes('validation')) {
		ctx.log.warn('Invalid event payload', {
			event: 'user.created',
			error: error.message,
			payload: invalidPayload
		});
		return ctx.json({ error: 'Invalid data' }, 400);
	}
	throw error;
}
```

### Schema Design Tips

```typescript
// Use specific types for better validation
const OrderPlaced = Event.define({
	name: 'order.placed',
	payload: Type.Object({
		orderId: Type.String({ format: 'uuid' }),
		amount: Type.Number({ minimum: 0 }),
		currency: Type.Union([Type.Literal('USD'), Type.Literal('EUR'), Type.Literal('GBP')]),
		items: Type.Array(
			Type.Object({
				sku: Type.String({ minLength: 1 }),
				quantity: Type.Integer({ minimum: 1 })
			}),
			{ minItems: 1 }
		)
	}),
	response: Type.Void()
});
```

---

## Troubleshooting

### Common Errors

| Error                               | Cause                                          | Solution                                                  |
| ----------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `Cannot emit event: not registered` | Event definition not passed to `.event()`      | Add `.event(Definition)` to app setup                     |
| `No event provider configured`      | Missing `.eventProvider()` call                | Add `.eventProvider(new BullMQEventProvider(...))`        |
| `Payload validation failed`         | Data doesn't match schema                      | Check payload against `payloadSchema`                     |
| `this is undefined in handler`      | Using regular method instead of arrow function | Change `onEvent(ctx) {}` to `onEvent = async (ctx) => {}` |
| `Consumer not found`                | Consumer class not registered                  | Add `.consumer(ConsumerClass, [deps])` after `.event()`   |
| `Connection refused to Redis`       | BullMQ can't connect                           | Check Redis host/port, ensure Redis is running            |

### Debugging Events

**1. Check event registration:**

```typescript
// In your app setup, log registered events
console.log('Registered events:', app.getEventRegistry().getEventNames());
```

**2. Add logging to consumers:**

```typescript
onEvent = async (ctx) => {
	ctx.log.debug('Event received', {
		eventId: ctx.eventId,
		eventName: ctx.eventName,
		correlationId: ctx.correlationId,
		data: ctx.data
	});
	// ... process
};
```

**3. Check BullMQ queue status:**

```typescript
import { Queue } from 'bullmq';

const queue = new Queue('events.user.created', { connection });
console.log('Waiting:', await queue.getWaitingCount());
console.log('Active:', await queue.getActiveCount());
console.log('Failed:', await queue.getFailedCount());
```

### Common Mistakes

**Using string instead of definition:**

```typescript
// ❌ WRONG - string event names are not supported
await ctx.events.emit('user.created', payload);

// ✅ CORRECT - use the definition object
await ctx.events.emit(UserCreated, payload);
```

**Forgetting arrow function for handlers:**

```typescript
// ❌ WRONG - `this` will be undefined
class MyConsumer implements Consumer<typeof MyEvent> {
	async onEvent(ctx) {
		await this.service.process(ctx.data); // TypeError: Cannot read property 'process' of undefined
	}
}

// ✅ CORRECT - arrow function captures `this`
class MyConsumer implements Consumer<typeof MyEvent> {
	onEvent = async (ctx) => {
		await this.service.process(ctx.data); // Works correctly
	};
}
```

**Not handling errors in fire-and-forget:**

```typescript
// Fire-and-forget means errors don't propagate to emitter
// Use onError hook to handle failures
class MyConsumer implements Consumer<typeof MyEvent> {
	onEvent = async (ctx) => {
		throw new Error('Processing failed'); // Emitter won't see this
	};

	onError = async (ctx, error) => {
		// This WILL be called - log it, alert, etc.
		await this.alerting.send('Event processing failed', { error, eventId: ctx.eventId });
	};
}
```

### Provider Lifecycle

**Before `start()`:**

- Workers not running
- Cannot process events
- Emit calls will queue but not process

**After `start()`:**

- Workers listening to queues
- Events being processed
- QueueEvents tracking completions

**After `stop()`:**

- Workers finish current jobs
- New events queued but not processed
- Safe to shut down application

```typescript
const provider = new BullMQEventProvider({ connection });

// Provider not started - events queue but don't process
await app.events.emit(UserCreated, data); // Queued but waiting

await provider.start(); // Now workers are processing

await provider.stop(); // Graceful shutdown
```

---

## Next Steps

- [Workflows](./workflows.md) - Long-running processes with steps and compensation
- [Testing](./testing.md) - Testing event handlers
