# Logging

OriJS provides structured logging with multiple transports, context propagation, and request-scoped loggers.

---

## Overview

The logging system features:

- **Structured logging** - JSON-formatted logs with fields
- **Multiple transports** - Console, file, filtering, multi-destination
- **Context propagation** - Trace IDs flow through requests and events
- **Level-based filtering** - Debug, info, warn, error

---

## Basic Usage

### Logger Instance

```typescript
import { Logger } from '@orijs/orijs';

const log = new Logger('MyService');

log.debug('Debug message', { detail: 'value' });
log.info('Info message', { userId: 'user-123' });
log.warn('Warning message', { threshold: 80 });
log.error('Error message', { error: err.message });
```

### Log Output Format

```json
{
	"level": "info",
	"timestamp": "2026-01-09T10:30:00.000Z",
	"name": "MyService",
	"message": "Info message",
	"userId": "user-123"
}
```

---

## Application-Level Logging

Configure logging when creating your application:

```typescript
import { Ori, FileTransport, ConsoleTransport } from '@orijs/orijs';

Ori.create()
	.logger({
		level: 'info', // Minimum level to log
		transports: [new ConsoleTransport(), new FileTransport('./logs')],
		clearConsole: false // Clear console on startup
	})
	.listen(3000);
```

### Log Levels

| Level   | Value | Usage                          |
| ------- | ----- | ------------------------------ |
| `debug` | 0     | Detailed debugging information |
| `info`  | 1     | General operational messages   |
| `warn`  | 2     | Warning conditions             |
| `error` | 3     | Error conditions               |

Setting a level filters out lower levels:

```typescript
.logger({ level: 'warn' })  // Only warn and error
```

---

## Using Logger in Services

### Via AppContext

```typescript
class UserService {
	constructor(private ctx: AppContext) {}

	async createUser(data: CreateUserDto): Promise<User> {
		this.ctx.log.info('Creating user', { email: data.email });

		try {
			const user = await this.db.insertUser(data);
			this.ctx.log.info('User created', { userId: user.id });
			return user;
		} catch (error) {
			this.ctx.log.error('Failed to create user', {
				email: data.email,
				error: error.message
			});
			throw error;
		}
	}
}
```

### Via RequestContext

In route handlers, the logger includes request trace ID:

```typescript
class UserController implements OriController {
	private createUser = async (ctx: RequestContext) => {
		ctx.log.info('Create user request received');

		const data = await ctx.json<CreateUserDto>();
		ctx.log.debug('Request body', { data });

		const user = await this.userService.create(data);
		ctx.log.info('User created', { userId: user.id });

		return ctx.json(user, 201);
	};
}
```

---

## Transports

### ConsoleTransport

Outputs to stdout with colors:

```typescript
import { ConsoleTransport } from '@orijs/orijs';

const transport = new ConsoleTransport();
```

### FileTransport

Writes to rotating log files:

```typescript
import { FileTransport } from '@orijs/orijs';

const transport = new FileTransport('./logs');
// Creates files like: logs/app-2026-01-09.log
```

### FilterTransport

Filter logs by level or custom criteria:

```typescript
import { FilterTransport, ConsoleTransport, FileTransport } from '@orijs/orijs';

// Send only errors to a separate file
const errorTransport = new FilterTransport({
	transport: new FileTransport('./logs/errors'),
	filter: (entry) => entry.level === 'error'
});

// Send everything info+ to console
const consoleTransport = new FilterTransport({
	transport: new ConsoleTransport(),
	minLevel: 'info'
});
```

### MultiTransport

Fan out to multiple destinations:

```typescript
import { MultiTransport, ConsoleTransport, FileTransport } from '@orijs/orijs';

const transport = new MultiTransport([
	new ConsoleTransport(),
	new FileTransport('./logs'),
	new RemoteLogTransport('https://logs.example.com')
]);
```

---

## Structured Logging

### Adding Fields

```typescript
ctx.log.info('Order processed', {
	orderId: 'ord-123',
	userId: 'user-456',
	total: 99.99,
	items: 5,
	duration: 234
});
```

### Logging Errors

```typescript
try {
	await processPayment();
} catch (error) {
	ctx.log.error('Payment failed', {
		orderId: order.id,
		error: error.message,
		stack: error.stack // Include stack for debugging
	});
	throw error;
}
```

### Sensitive Data

Never log sensitive data:

```typescript
// BAD - logging passwords
ctx.log.info('Login attempt', { password: input.password });

// GOOD - log only safe fields
ctx.log.info('Login attempt', { username: input.username });
```

---

## Context Propagation

### Request Trace IDs

RequestContext loggers automatically include trace information:

```typescript
// In controller
ctx.log.info('Request received');
// Output: { ..., "traceId": "abc-123", "message": "Request received" }

// In service called from controller
this.ctx.log.info('Processing');
// Output: { ..., "traceId": "abc-123", "message": "Processing" }
```

### Event Trace Propagation

Events carry trace context:

```typescript
// Emitting event
ctx.event?.emit('user.created', { userId }, {
  correlationId: ctx.traceId,
});

// In event handler
private onUserCreated = async (ctx: EventContext) => {
  ctx.log.info('Handling user.created');
  // Output: { ..., "correlationId": "abc-123", "eventId": "evt-456", ... }
};
```

---

## Global Configuration

### Static Configuration

```typescript
import { Logger } from '@orijs/orijs';

Logger.configure({
	level: 'debug',
	transports: [new ConsoleTransport()]
});
```

### Runtime Level Change

```typescript
// Increase verbosity during debugging
Logger.configure({ level: 'debug' });

// Reduce noise in production
Logger.configure({ level: 'warn' });
```

---

## Logging Patterns

### Request/Response Logging

```typescript
class LoggingInterceptor implements Interceptor {
	async intercept(ctx: RequestContext, next: () => Promise<Response>): Promise<Response> {
		const { method, url } = ctx.request;
		const start = Date.now();

		ctx.log.info('Request started', { method, url });

		try {
			const response = await next();
			const duration = Date.now() - start;

			ctx.log.info('Request completed', {
				method,
				url,
				status: response.status,
				duration
			});

			return response;
		} catch (error) {
			const duration = Date.now() - start;
			ctx.log.error('Request failed', { method, url, duration, error: error.message });
			throw error;
		}
	}
}
```

### Service Operation Logging

```typescript
class OrderService {
	async processOrder(orderId: string): Promise<void> {
		const log = this.ctx.log;

		log.info('Processing order started', { orderId });

		// Log each step
		log.debug('Validating inventory', { orderId });
		await this.validateInventory(orderId);

		log.debug('Charging payment', { orderId });
		await this.chargePayment(orderId);

		log.debug('Creating shipment', { orderId });
		await this.createShipment(orderId);

		log.info('Processing order completed', { orderId });
	}
}
```

### Error Boundary Logging

```typescript
class ErrorHandler {
	handleError(error: Error, ctx: RequestContext): Response {
		// Log full error details
		ctx.log.error('Unhandled error', {
			error: error.message,
			stack: error.stack,
			url: ctx.request.url,
			method: ctx.request.method
		});

		// Return safe error to client
		return Response.json({ error: 'Internal server error' }, { status: 500 });
	}
}
```

---

## Best Practices

### 1. Use Appropriate Levels

```typescript
// DEBUG - Detailed info for debugging
log.debug('Cache lookup', { key: 'user:123', hit: false });

// INFO - Normal operations
log.info('User logged in', { userId: 'user-123' });

// WARN - Unexpected but handled conditions
log.warn('Rate limit approaching', { current: 95, limit: 100 });

// ERROR - Failures requiring attention
log.error('Database connection failed', { error: err.message });
```

### 2. Include Context

```typescript
// BAD - no context
log.error('Failed');

// GOOD - actionable context
log.error('Order creation failed', {
	orderId: 'ord-123',
	userId: 'user-456',
	error: err.message,
	step: 'payment'
});
```

### 3. Avoid Logging in Loops

```typescript
// BAD - too many logs
for (const item of items) {
	log.debug('Processing item', { item });
}

// GOOD - log summary
log.debug('Processing items', { count: items.length });
```

### 4. Don't Log Sensitive Data

```typescript
// BAD
log.info('Auth', { token: authToken });
log.info('User', { password: user.password });

// GOOD
log.info('Auth', { tokenPrefix: authToken.slice(0, 8) + '...' });
log.info('User', { userId: user.id, email: user.email });
```

### 5. Use Structured Fields

```typescript
// BAD - string interpolation
log.info(`User ${userId} created order ${orderId} for $${total}`);

// GOOD - structured fields
log.info('Order created', { userId, orderId, total });
```

---

## Testing with Logs

### Capturing Logs in Tests

```typescript
import { describe, it, expect, mock } from 'bun:test';

describe('UserService', () => {
	it('logs user creation', async () => {
		const logCapture: any[] = [];

		const mockLog = {
			info: mock((msg, fields) => logCapture.push({ level: 'info', msg, fields })),
			error: mock((msg, fields) => logCapture.push({ level: 'error', msg, fields }))
		};

		const ctx = { log: mockLog } as unknown as AppContext;
		const service = new UserService(ctx, mockDb);

		await service.createUser({ name: 'Alice', email: 'alice@test.com' });

		expect(logCapture).toContainEqual({
			level: 'info',
			msg: 'Creating user',
			fields: { email: 'alice@test.com' }
		});
	});
});
```

---

## Next Steps

- [Configuration](./configuration.md) - Configure log levels via environment
- [Testing](./testing.md) - Test logging behavior
