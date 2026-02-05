# @orijs/logging

Structured logging for OriJS with Pino-inspired API, child loggers, and multiple transports.

## Installation

```bash
bun add @orijs/logging
```

## Quick Start

```typescript
import { Logger } from '@orijs/logging';

const log = new Logger('MyService');

log.info('User created', { userId: '123' });
log.error('Failed to connect', { host: 'db.example.com' });
log.debug('Processing request', { requestId: 'abc' });
log.warn('Rate limit approaching', { current: 95, limit: 100 });
```

## Features

- **Structured Logging** - Log messages with typed metadata
- **Child Loggers** - Create loggers with inherited context
- **Multiple Transports** - Console, JSON, file, and custom transports
- **Request Context** - Automatic correlation IDs via AsyncLocalStorage
- **Trace Propagation** - Propagate trace context across services

## Child Loggers

```typescript
const log = new Logger('OrderService');
const orderLog = log.with({ orderId: '456' });

orderLog.info('Processing order');
// INFO [OrderService] Processing order {"orderId":"456"}

orderLog.info('Payment received', { amount: 99.99 });
// INFO [OrderService] Payment received {"orderId":"456","amount":99.99}
```

## Transports

```typescript
import { Logger, consoleTransport, jsonTransport } from '@orijs/logging';

Logger.configure({
  level: 'info',
  transports: [
    consoleTransport({ pretty: true }),  // Colored console output
    jsonTransport()                       // JSON for log aggregators
  ]
});
```

## Request Context

Every request automatically gets a logger with correlation ID:

```typescript
class UserController {
  configure(r: RouteBuilder) {
    r.get('/:id', (ctx) => {
      ctx.log.info('Fetching user', { id: ctx.params.id });
      // INFO [Request] Fetching user {"requestId":"abc123","id":"42"}
      return this.users.findById(ctx.params.id);
    });
  }
}
```

## Log Levels

| Level | Method | When to Use |
|-------|--------|-------------|
| debug | `log.debug()` | Development debugging |
| info  | `log.info()` | Normal operations |
| warn  | `log.warn()` | Potential issues |
| error | `log.error()` | Errors and failures |

## Documentation

See the [Logging Guide](../../docs/guides/logging.md) for more details.

## License

MIT
