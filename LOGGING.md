# OriJS Logging Conventions

## Log Message Format

All log messages MUST follow these formatting rules:

### 1. Title Case for Messages

Log messages use Title Case (capitalize first letter of each significant word):

```typescript
// CORRECT
log.info('Controller Registered');
log.debug('Cache Loaded');
log.info('Triggering Example Workflow');
log.error('Database Connection Failed');

// WRONG
log.info('controller registered');
log.info('Controller registered'); // Inconsistent
log.info('CONTROLLER REGISTERED'); // ALL CAPS
```

### 2. Message Structure

Format: `Message: additional details`

```typescript
// Simple message
log.info('Server Listening');

// Message with inline details
log.info('Server Listening: http://localhost:8000');
log.debug('Controller Registered: UserController (/api/users) -> [GET /api/users, POST /api/users]');

// Message with context object (for trace IDs, etc.)
log.info('Request Completed', { traceId, accountUuid, status: 200 });
```

### 3. Arrays in Messages

Use arrow notation for arrays:

```typescript
// CORRECT
log.debug('Controller Registered: UserController (/api) -> [GET /users, POST /users]');
log.info('Cache Loaded: Monitor -> [Account, Project]');
log.debug('Event Handler Registered: AlertHandler -> [alert.triggered, alert.resolved]');

// WRONG
log.debug('Controller Registered', { name: 'UserController', routes: ['GET /users'] });
```

### 4. Context Architecture

The logging system has two layers of context fields:

#### Framework Core Fields (Built-in)

Distributed tracing fields handled automatically by the framework:

| Field           | Abbrev    | Description                                      |
| --------------- | --------- | ------------------------------------------------ |
| `requestId`     | `reqId`   | Unique ID for the HTTP request                   |
| `traceId`       | `trcId`   | Distributed trace ID (preserved across services) |
| `spanId`        | `spanId`  | Current operation span ID                        |
| `parentSpanId`  | `pSpanId` | Parent span for trace tree reconstruction        |
| `correlationId` | `trcId`   | Alias for traceId                                |

#### Application Fields (Injected)

Application-specific fields are configured via `Logger.configure()` at startup and injected via guards:

```typescript
// In application startup (e.g., app.ts)
import { Logger, ANSI_COLORS } from '@upstat/orijs';

Logger.configure({
	level: 'debug',
	traceFields: {
		accountUuid: { abbrev: 'acctId', color: ANSI_COLORS.cyan },
		projectUuid: { abbrev: 'prjId', color: ANSI_COLORS.magenta },
		userId: { abbrev: 'usrId', color: ANSI_COLORS.blue }
	}
});
```

Guards inject these fields via the logger:

```typescript
// In AuthGuard
export const JwtAuthGuard: Guard = async (ctx) => {
	const payload = await verifyJwt(ctx);

	// Inject application-specific context that persists across handoffs
	ctx.log.setMeta({
		userId: payload.userId,
		accountUuid: payload.accountUuid
	});

	return true;
};
```

#### Field Display Rules

- **All fields use camelCase** - no snake_case anywhere in the framework
- **Trace fields appear before the message** with abbreviated names
- **UUIDs are truncated to 8 characters** for readability
- **Other context fields appear after the message** as key:value pairs

```typescript
log.info('Cache Miss', {
	traceId: 'abc-123-def-456',
	accountUuid: '3df69a75-030b-4221-9f6e-eda1acdfc3e4',
	key: 'user:123'
});
// Output: 04:08:16:I:CacheService trcId:abc-123- acctId:3df69a75 Cache Miss: key:user:123
```

### 5. Log Levels

| Level | Char | Color   | Use For                                   |
| ----- | ---- | ------- | ----------------------------------------- |
| debug | D    | Magenta | Internal details, cache operations, steps |
| info  | I    | Cyan    | Key events, startup, requests completed   |
| warn  | W    | Yellow  | Recoverable issues, deprecations          |
| error | E    | Red     | Failures, exceptions                      |

### 6. Controller/Handler Logging

Use `ctx.log` in handlers - context is automatically propagated:

```typescript
export class UserController implements OriController {
	constructor(private ctx: AppContext) {}

	public configure(r: RouteBuilder): void {
		r.get('/users/:id', this.getUser);
	}

	private getUser = async (ctx: RequestContext) => {
		// Use ctx.log - requestId, traceId, etc. are automatic
		ctx.log.info('Fetching User', { userId: ctx.params.id });
		// ...
	};
}
```

### 7. Automatic Context Propagation

The framework automatically propagates ALL context (core + application fields) across service boundaries:

```typescript
// HTTP Request comes in
// -> Framework sets { requestId, traceId, spanId }

// AuthGuard runs and injects application context via ctx.log.setMeta()
ctx.log.setMeta({ userId, accountUuid });
// -> ctx.log now has { requestId, traceId, spanId, userId, accountUuid }
// -> AsyncLocalStorage context updated for propagation

// Controller calls workflow
await this.ctx.workflows.execute(ExampleWorkflow, data);
// -> Workflow automatically inherits ALL context from caller

// Workflow logs
ctx.log.info('Processing');
// -> Shows: reqId:xxx trcId:xxx usrId:xxx acctId:xxx Processing
```

**You should NOT manually pass loggers or create child loggers for context propagation.**
The framework uses `AsyncLocalStorage` and `PropagationMeta` to handle this automatically.

#### PropagationMeta

The `PropagationMeta` interface carries context across async boundaries:

```typescript
interface PropagationMeta {
	// Core framework fields (distributed tracing)
	readonly requestId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly parentSpanId?: string;

	// Application-injected fields (extensible)
	readonly [key: string]: unknown;
}
```

Framework systems (workflows, events, queues) use this automatically:

```typescript
// Framework captures context before handoff
const meta = capturePropagationMeta();
// -> { requestId, traceId, spanId, userId, accountUuid, ... }

// Framework restores context after handoff
const log = Logger.fromMeta('WorkflowName', meta);
// -> Logger with all context restored
```

### 8. Common Log Message Patterns

| Event                 | Message Format                                          |
| --------------------- | ------------------------------------------------------- |
| Server startup        | `Server Listening: http://localhost:{port}`             |
| App ready             | `Application Ready: {n} providers, {n} routes ({ms}ms)` |
| Controller registered | `Controller Registered: {Name} ({path}) -> [{routes}]`  |
| Provider loaded       | `Provider Loaded: {Name}`                               |
| Cache loaded          | `Cache Loaded: {Entity} -> [{dependencies}]`            |
| Cache hit/miss        | `Cache Hit` / `Cache Miss`                              |
| Event handler         | `Event Handler Registered: {Name} -> [{events}]`        |
| Workflow started      | `Workflow Started`                                      |
| Workflow completed    | `Workflow Completed`                                    |
| Workflow failed       | `Workflow Failed`                                       |
| Step completed        | `Step Completed`                                        |
| Step failed           | `Step Failed`                                           |
| Shutdown              | `Received Shutdown Signal: {signal}`                    |

## Output Format

```
HH:MM:SS:L:ContextName [trace-fields] Message: other-context
```

Where:

- `HH:MM:SS` - Local time
- `L` - Level character (D/I/W/E)
- `ContextName` - Logger name (controller, service, workflow)
- `[trace-fields]` - Registered trace fields with abbreviated names (truncated to 8 chars)
- `Message` - The log message in Title Case
- `other-context` - Non-trace context as key:value pairs

Example:

```
04:08:16:D:CacheService trcId:c400469f acctId:3df69a75 prjId:9994a0f3 usrId:7vlF2xp0 Cache Miss: key:Dashboard.account
04:08:16:I:OriJS Application Ready: 15 providers, 42 routes (127ms)
04:08:16:D:OriJS Controller Registered: HealthController (/internal) -> [GET /internal/health]
```
