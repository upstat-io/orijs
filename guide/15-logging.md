# Chapter 15: Logging

[Previous: Caching <-](./14-caching.md) | [Next: Testing ->](./16-testing.md)

---

Logging is the first thing you reach for when something goes wrong in production. If your logs are unstructured strings, you will spend more time parsing them than fixing the bug. If your logs lack request context, you cannot trace a failure back to the request that caused it. If your logging system drops messages under load or blocks your application while writing, it becomes part of the problem.

OriJS's logging system is inspired by Pino -- the fastest Node.js logger -- but designed from the ground up for Bun and OriJS's provider-based architecture. It produces structured JSON objects, writes through configurable transports, propagates context across services via AsyncLocalStorage, and buffers writes asynchronously to avoid blocking your application.

## The Transport Provider Architecture

Like every infrastructure component in OriJS, the logging system is built on **transports** -- pluggable output destinations that implement a simple interface. The framework ships with four built-in transports:

| Transport | Purpose |
|-----------|---------|
| `consoleTransport` | Pretty-printed (dev) or JSON (prod) console output |
| `fileTransport` | JSON logs to file with rotation |
| `filterTransport` | Wraps another transport with name-based filtering |
| `multiTransport` | Writes to multiple transports simultaneously |

You can swap these out, combine them, or write your own transport for any destination -- Datadog, ELK, CloudWatch, a WebSocket dashboard, or a database.

### The Transport Interface

```typescript
interface Transport {
  /** Write a structured log object */
  write(obj: LogObject): void;

  /** Flush any buffered logs (awaited on shutdown) */
  flush(): Promise<void>;

  /** Cleanup resources (awaited on shutdown) */
  close(): Promise<void>;
}
```

Three methods. That is the entire contract. `write()` is synchronous for performance -- you do not want to `await` on every log line. `flush()` and `close()` are async because they may need to wait for I/O (flushing a file buffer, closing a network connection).

### The Log Object

Every log entry is a structured `LogObject`:

```typescript
interface LogObject {
  time: number;          // Unix timestamp (milliseconds)
  level: LevelNumber;    // 10=debug, 20=info, 30=warn, 40=error
  msg: string;           // The log message
  name?: string;         // Logger name (e.g., 'MonitorService')
  [key: string]: unknown; // Additional structured context
}
```

This is the universal format. Every transport receives the same object. Whether you format it as pretty-printed text for development or newline-delimited JSON for production is the transport's concern, not the logger's.

## Basic Usage

### Creating a Logger

```typescript
import { Logger } from '@orijs/logging';

// Create a named logger
const log = new Logger('MonitorService');

// Log at different levels
log.debug('Checking monitor status', { monitorUuid: 'abc-123' });
log.info('Monitor check completed', { monitorUuid: 'abc-123', responseTime: 245 });
log.warn('Response time above threshold', { monitorUuid: 'abc-123', responseTime: 2450, threshold: 2000 });
log.error('Monitor check failed', { monitorUuid: 'abc-123', error: 'Connection refused' });
```

### Log Levels

OriJS uses Pino-compatible log levels:

| Level | Number | When to Use |
|-------|--------|-------------|
| `debug` | 10 | Detailed diagnostic information. Disabled in production. |
| `info` | 20 | Normal operational events. Service started, request completed, cache hit. |
| `warn` | 30 | Something unexpected but recoverable. Slow response, fallback used, retry needed. |
| `error` | 40 | Something failed that should not have. Database error, unhandled exception, data corruption. |

The numeric values follow Pino's convention, which makes it easy to integrate with Pino-compatible tooling. A log level acts as a threshold -- setting the level to `warn` means only `warn` and `error` messages are written. `debug` and `info` are silently dropped.

### Structured Data, Not String Interpolation

This is fundamental to the philosophy: always pass data as a structured object, never interpolate it into the message string.

```typescript
// WRONG: String interpolation
log.info(`User ${userId} logged in from ${ipAddress} at ${new Date().toISOString()}`);
// Result: "User abc-123 logged in from 192.168.1.1 at 2024-01-15T10:30:00Z"
// Problem: How do you search for all logins from 192.168.1.1?

// RIGHT: Structured data
log.info('User logged in', { userId, ipAddress });
// Result: { time: 1705312200000, level: 20, msg: "User logged in", userId: "abc-123", ipAddress: "192.168.1.1" }
// Now you can: grep userId=abc-123, filter by ipAddress, aggregate by field
```

Why this matters:

- **Searchable.** Your log aggregation tool (Datadog, ELK, Grafana Loki) can index structured fields. You can search `userId:abc-123` instead of regex-matching against a freeform string.
- **Aggregatable.** You can compute "average response time" by aggregating the `responseTime` field across all entries. You cannot do that with `"Response time was 245ms"`.
- **Parseable.** Structured JSON can be automatically parsed by any tool. String messages require custom parsers for each format variation.
- **Filterable.** You can set up alerts on `level >= 40 AND service == 'PaymentService'`. Try doing that with unstructured text.

## Global Configuration

Configure logging once at application startup:

```typescript
import { Logger, consoleTransport, fileTransport, multiTransport } from '@orijs/logging';

Logger.configure({
  level: 'info',
  transports: [
    consoleTransport({ pretty: true }),
    fileTransport('./logs/app.log', {
      rotate: { size: '10mb', keep: 5 }
    })
  ]
});
```

All Logger instances created after `configure()` automatically use the global settings. Instances created before `configure()` buffer their log entries and flush them through the configured transports once `configure()` is called. This solves the initialization ordering problem -- services can create loggers during construction, before the application has fully configured its logging.

### Configuration Options

```typescript
interface LoggerGlobalOptions {
  /** Log level threshold: 'debug' | 'info' | 'warn' | 'error' */
  level?: LevelName;

  /** Output transports */
  transports?: Transport[];

  /** Enable async buffered writes (default: true) */
  async?: boolean;

  /** Buffer flush interval in ms when async (default: 10) */
  flushInterval?: number;

  /** Buffer size before auto-flush (default: 4096) */
  bufferSize?: number;

  /** Application-specific trace fields for log formatting */
  traceFields?: Record<string, TraceFieldDef>;
}
```

### Async Buffered Writes

By default, log writes are buffered asynchronously using a sonic-boom style buffer. This means `log.info()` does not directly call `transport.write()` -- it appends to an in-memory buffer that is flushed periodically (every 10ms by default) or when the buffer reaches a size threshold.

This is critical for performance. Synchronous writes to console or file block the event loop. At high log volumes (thousands of entries per second), this blocking becomes the bottleneck. Async buffering lets your application continue processing while logs are written in the background.

The trade-off: if the process crashes, the last few milliseconds of logs may be lost. For this reason, `Logger.shutdown()` awaits a full flush before returning -- always call it during graceful shutdown.

## Child Loggers with .with()

Create child loggers with additional context that is automatically included in every log entry:

```typescript
const log = new Logger('MonitorService');

// Create a child logger with account context
const accountLog = log.with({ accountUuid: 'abc-123' });

accountLog.info('Processing monitors');
// { time: ..., level: 20, msg: "Processing monitors", name: "MonitorService", accountUuid: "abc-123" }

// Child of child -- contexts are merged
const projectLog = accountLog.with({ projectUuid: 'def-456' });

projectLog.info('Checking monitor', { monitorUuid: 'ghi-789' });
// { time: ..., level: 20, msg: "Checking monitor", name: "MonitorService",
//   accountUuid: "abc-123", projectUuid: "def-456", monitorUuid: "ghi-789" }
```

Child loggers are **immutable** -- calling `.with()` creates a new logger instance. The parent logger is not modified. This is important for concurrent request handling: each request gets its own child logger with request-specific context, and they do not interfere with each other.

### Named Child Loggers

Create a child with a different name (for tracing through a call chain):

```typescript
const parentLog = new Logger('IncidentController');
const serviceLog = parentLog.child('IncidentClientService');
const repoLog = serviceLog.child('IncidentRepository');

// Each logger has a different name but inherits parent's context
```

## Automatic Request Context

OriJS uses `AsyncLocalStorage` to automatically attach request-specific context to every log entry within a request's lifecycle. You do not need to pass loggers through your call stack.

### How It Works

When OriJS receives an HTTP request, it creates a `RequestContextData` and stores it in AsyncLocalStorage:

```typescript
interface RequestContextData {
  log: Logger;
  correlationId: string;
  trace?: TraceContext;
  meta?: Record<string, unknown>;
}
```

Every log entry within that request automatically includes the `correlationId`, trace IDs, and any metadata set by guards.

### Accessing the Logger from Services

```typescript
import { requestContext } from '@orijs/logging';

class MonitorClientService {
  async checkMonitor(monitorUuid: string) {
    const { log } = requestContext();

    log.info('Starting monitor check', { monitorUuid });

    // ... do work ...

    log.info('Monitor check completed', { monitorUuid, responseTime: 245 });
  }
}
```

The `requestContext()` function returns the context for the current async execution context. If called outside a request (in unit tests, scripts, or event handlers), it falls back to a console logger -- your code never crashes from a missing logger.

### Injecting Metadata via Guards

Guards and middleware can add metadata that persists for the entire request:

```typescript
class FirebaseAuthGuard {
  async canActivate(ctx: RequestContext): Promise<boolean> {
    const user = await this.authService.verifyToken(ctx.headers.authorization);

    if (!user) return false;

    // These fields are now included in every log entry for this request
    ctx.log.setMeta({
      userId: user.uuid,
      accountUuid: user.accountUuid
    });

    return true;
  }
}
```

After the guard runs, every `log.info()`, `log.error()`, etc. within that request automatically includes `userId` and `accountUuid` -- even in deeply nested service calls that use `requestContext()`.

### Distributed Tracing

The logging system supports W3C-compatible distributed tracing across services:

```typescript
interface TraceContext {
  traceId: string;       // Preserved across all services in the chain
  spanId: string;        // Unique per operation
  parentSpanId?: string; // Links to the parent operation
}
```

When OriJS emits an event, starts a workflow, or makes an HTTP call to another service, the trace context is automatically propagated:

```typescript
// Capture propagation metadata (creates a child span)
const meta = capturePropagationMeta();

// meta = {
//   correlationId: 'abc-123',
//   traceId: 'trace-uuid',
//   spanId: 'new-span-id',
//   parentSpanId: 'original-span-id',
//   userId: 'user-uuid',
//   accountUuid: 'account-uuid'
// }

// On the receiving end, restore the context
const log = Logger.fromMeta('EventConsumer', meta);
log.info('Processing event');
// Automatically includes traceId, spanId, parentSpanId, userId, accountUuid
```

This enables you to trace a single user action from the HTTP request through event processing, workflow execution, and background jobs -- all connected by the same `traceId`.

## Built-in Transports

### Console Transport

The default transport. Auto-detects mode based on environment:

```typescript
import { consoleTransport } from '@orijs/logging';

// Auto-detect: pretty in dev, JSON in production
const transport = consoleTransport();

// Force pretty mode with colors
const prettyTransport = consoleTransport({ pretty: true, colors: true });

// Force JSON mode for production
const jsonTransport = consoleTransport({ json: true });

// Custom object inspection depth
const deepTransport = consoleTransport({ depth: 6 });
```

**Pretty mode** produces human-readable output with colors, abbreviated trace fields, and Bun's syntax-highlighted error stack traces:

```
10:30:45:I:MonitorService acctId:abc1 projId:def4 Starting monitor check: monitorUuid:ghi-789
10:30:45:I:MonitorService acctId:abc1 projId:def4 Monitor check completed: monitorUuid:ghi-789 responseTime:245
10:30:46:E:MonitorService acctId:abc1 projId:def4 Monitor check failed: monitorUuid:ghi-789
  ConnectionError: Connection refused
    at MonitorDbService.checkEndpoint (/src/monitor.db.ts:42:11)
```

**JSON mode** produces newline-delimited JSON for log aggregation tools:

```json
{"time":1705312245000,"level":20,"msg":"Starting monitor check","name":"MonitorService","accountUuid":"abc-123","monitorUuid":"ghi-789"}
{"time":1705312245245,"level":20,"msg":"Monitor check completed","name":"MonitorService","accountUuid":"abc-123","monitorUuid":"ghi-789","responseTime":245}
```

### Trace Fields

Register application-specific fields that get special formatting in pretty mode:

```typescript
import { Logger, ANSI_COLORS } from '@orijs/logging';

Logger.configure({
  traceFields: {
    accountUuid:  { abbrev: 'acctId',  color: ANSI_COLORS.cyan },
    projectUuid:  { abbrev: 'projId',  color: ANSI_COLORS.blue },
    correlationId: { abbrev: 'trcId',  color: ANSI_COLORS.gray },
    userId:       { abbrev: 'usrId',   color: ANSI_COLORS.green },
  },
  // ... other options
});
```

Trace fields are displayed compactly in pretty mode (`acctId:abc1` instead of `accountUuid:abc-123-def-456`), with values truncated and color-coded. This keeps log lines readable while preserving the full values in JSON mode.

### File Transport

Writes JSON logs to a file with optional rotation:

```typescript
import { fileTransport } from '@orijs/logging';

const transport = fileTransport('./logs/app.log', {
  rotate: {
    size: '10mb',    // Rotate when file reaches 10 MB
    keep: 5          // Keep 5 rotated files (app.log.1 through app.log.5)
  },
  sync: false        // Async writes (default, recommended)
});
```

The file transport:
- Creates the log directory if it does not exist
- Uses async batched writes by default (microtask-level batching for high throughput)
- Rotates files when they reach the configured size
- Implements a circuit breaker -- after 5 consecutive write failures, it clears the buffer to prevent memory exhaustion and logs a critical warning to stderr
- Supports sync mode for debugging (blocks on every write)

### Filter Transport

Wraps another transport to include or exclude specific logger names:

```typescript
import { filterTransport, consoleTransport } from '@orijs/logging';

// Only log from specific services
const filtered = filterTransport(consoleTransport(), {
  includeNames: ['AuthService', 'PaymentService']
});

// Exclude noisy loggers
const quiet = filterTransport(consoleTransport(), {
  excludeNames: ['HealthCheck', 'MetricsCollector']
});
```

Filter transport is useful during development when you want to focus on specific services without changing log levels globally.

### Multi Transport

Writes to multiple transports simultaneously. Each transport is wrapped in try/catch so one failing transport does not prevent others from receiving the log:

```typescript
import { multiTransport, consoleTransport, fileTransport } from '@orijs/logging';

const transport = multiTransport([
  consoleTransport({ pretty: true }),
  fileTransport('./logs/app.log', { rotate: { size: '10mb', keep: 5 } })
]);
```

## Writing Custom Transports

This is where the provider architecture shines. Writing a custom transport is implementing three methods.

### Example: Send to External Service

```typescript
import type { Transport, LogObject } from '@orijs/logging';

function datadogTransport(apiKey: string, options: { batchSize?: number; flushInterval?: number } = {}): Transport {
  const batchSize = options.batchSize ?? 100;
  const flushInterval = options.flushInterval ?? 5000;
  let buffer: LogObject[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sendBatch(logs: LogObject[]): Promise<void> {
    if (logs.length === 0) return;

    await fetch('https://http-intake.logs.datadoghq.com/api/v2/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey
      },
      body: JSON.stringify(logs.map(log => ({
        message: log.msg,
        level: getLevelName(log.level),
        service: log.name,
        timestamp: new Date(log.time).toISOString(),
        ...log  // Include all structured fields
      })))
    });
  }

  // Start periodic flush
  timer = setInterval(async () => {
    if (buffer.length > 0) {
      const batch = buffer;
      buffer = [];
      await sendBatch(batch).catch(() => {
        // Silently drop on failure -- logging should not crash the app
      });
    }
  }, flushInterval);

  return {
    write(obj: LogObject): void {
      buffer.push(obj);
      if (buffer.length >= batchSize) {
        const batch = buffer;
        buffer = [];
        sendBatch(batch).catch(() => {});
      }
    },

    async flush(): Promise<void> {
      const batch = buffer;
      buffer = [];
      await sendBatch(batch);
    },

    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      await this.flush();
    }
  };
}
```

### Example: WebSocket Dashboard Transport

```typescript
function websocketDashboardTransport(wsUrl: string): Transport {
  let ws: WebSocket | null = null;
  let queue: string[] = [];

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      for (const msg of queue) ws!.send(msg);
      queue = [];
    };
    ws.onclose = () => {
      ws = null;
      setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    write(obj: LogObject): void {
      const message = JSON.stringify(obj);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      } else {
        queue.push(message);
        if (queue.length > 1000) queue.shift(); // Keep bounded
      }
    },

    async flush(): Promise<void> {
      // WebSocket sends are immediate (buffered by the WebSocket itself)
    },

    async close(): Promise<void> {
      if (ws) ws.close();
    }
  };
}
```

### Example: ELK Stack Transport

```typescript
function elasticsearchTransport(esUrl: string, indexPrefix: string): Transport {
  let buffer: LogObject[] = [];
  const BATCH_SIZE = 200;

  async function sendBulk(logs: LogObject[]): Promise<void> {
    if (logs.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const index = `${indexPrefix}-${today}`;

    // Elasticsearch bulk format: alternating action + document lines
    const body = logs.flatMap(log => [
      JSON.stringify({ index: { _index: index } }),
      JSON.stringify({
        '@timestamp': new Date(log.time).toISOString(),
        level: getLevelName(log.level),
        message: log.msg,
        logger: log.name,
        ...log
      })
    ]).join('\n') + '\n';

    await fetch(`${esUrl}/_bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body
    });
  }

  return {
    write(obj: LogObject): void {
      buffer.push(obj);
      if (buffer.length >= BATCH_SIZE) {
        const batch = buffer;
        buffer = [];
        sendBulk(batch).catch(() => {});
      }
    },

    async flush(): Promise<void> {
      const batch = buffer;
      buffer = [];
      await sendBulk(batch);
    },

    async close(): Promise<void> {
      await this.flush();
    }
  };
}
```

## Environment-Based Configuration

OriJS provides utilities for configuring logging from environment variables, integrating with the config provider:

```typescript
import { readLogConfig, buildLoggerOptions } from '@orijs/logging';

// Read from config provider (environment variables)
const logConfig = await readLogConfig(configProvider);
const loggerOptions = buildLoggerOptions(logConfig);

Logger.configure(loggerOptions);
```

Supported environment variables:

| Variable | Values | Default |
|----------|--------|---------|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_JSON` | `true`, `false` | `false` |
| `LOG_INCLUDE_NAMES` | Comma-separated logger names | (all) |
| `LOG_EXCLUDE_NAMES` | Comma-separated logger names | (none) |
| `LOG_FILE_ENABLED` | `true`, `false` | `false` |
| `LOG_FILE_PATH` | File path | `./logs/app.log` |
| `LOG_FILE_MAX_SIZE` | Size with unit (`10mb`) | `10mb` |
| `LOG_FILE_MAX_COUNT` | Number | `5` |

Or use the convenience function:

```typescript
import { createLoggerOptionsFromConfig } from '@orijs/logging';

const loggerOptions = await createLoggerOptionsFromConfig(configProvider);
Logger.configure(loggerOptions);
```

## Tabular Logging

For administrative and diagnostic output, the logger supports tabular data using Bun's built-in table formatting:

```typescript
log.table('Active Monitors', [
  { name: 'API Health', status: 'up', responseTime: 120 },
  { name: 'Database', status: 'up', responseTime: 45 },
  { name: 'CDN', status: 'degraded', responseTime: 890 }
]);

// Output (pretty mode):
// 10:30:45:I:App Active Monitors
// ┌─────────────┬──────────┬──────────────┐
// │ name        │ status   │ responseTime │
// ├─────────────┼──────────┼──────────────┤
// │ API Health  │ up       │ 120          │
// │ Database    │ up       │ 45           │
// │ CDN         │ degraded │ 890          │
// └─────────────┴──────────┴──────────────┘

// With specific columns
log.table('Users', users, ['name', 'email']);
```

## Shutdown Protocol

Proper shutdown ensures no logs are lost:

```typescript
// In your application shutdown handler
process.on('SIGTERM', async () => {
  log.info('Shutting down gracefully...');

  // 1. Stop accepting new requests
  server.stop();

  // 2. Shutdown logger -- flushes all buffers and closes transports
  await Logger.shutdown();

  process.exit(0);
});
```

`Logger.shutdown()` performs these steps in order:

1. Stops the async buffer timer
2. Flushes the async buffer to transports synchronously
3. Flushes any pre-initialization pending logs
4. Awaits `flush()` on all transports in parallel (writes remaining buffered data)
5. Awaits `close()` on all transports in parallel (closes file handles, connections)

Uses `Promise.allSettled()` to ensure all transports complete shutdown regardless of individual failures -- one failing transport does not block the others.

## Cross-Service Context Propagation

When OriJS emits events, starts workflows, or triggers background jobs, the logging context is automatically propagated:

```typescript
// In the HTTP request handler (source)
log.setMeta({ userId: 'user-123', accountUuid: 'acct-456' });

// When an event is emitted, OriJS captures propagation metadata
const meta = capturePropagationMeta();
// meta = { correlationId: '...', traceId: '...', spanId: '...', userId: '...', accountUuid: '...' }

// In the event consumer (destination)
const consumerLog = Logger.fromMeta('IncidentConsumer', meta);
consumerLog.info('Processing incident event');
// Output includes: correlationId, traceId, spanId (with parentSpanId linking to source), userId, accountUuid
```

This propagation is handled automatically by OriJS's event system and workflow engine. You do not need to manually capture or restore context -- the framework does it for you. But the utilities are available if you need manual propagation for custom integrations.

### Propagation Headers for HTTP Calls

For service-to-service HTTP calls, the logger can generate propagation headers:

```typescript
const headers = log.propagationHeaders();
// headers = {
//   'x-request-id': 'correlation-uuid',
//   'x-correlation-context': '{"userId":"user-123","accountUuid":"acct-456"}'
// }

await fetch('https://other-service/api/data', { headers });
```

## Log Levels: When to Use Each

Choosing the right log level is a skill. Here is a practical guide:

### debug -- Diagnostic Details

Use for information that is only useful when actively debugging a problem. These should be **disabled in production** to avoid overwhelming your log storage.

```typescript
log.debug('Cache key generated', { key: 'cache:7h5g8k2m4n1p', entity: 'Monitor', params: { monitorUuid } });
log.debug('SQL query executed', { query: 'SELECT ...', duration: 12 });
log.debug('WebSocket message received', { type: 'heartbeat', socketId });
```

### info -- Normal Operations

Use for events that confirm the system is working correctly. A healthy production system should have a steady stream of info logs.

```typescript
log.info('Server started', { port: 8001, environment: 'production' });
log.info('Monitor check completed', { monitorUuid, status: 'up', responseTime: 245 });
log.info('User logged in', { userId, ipAddress });
log.info('Cache invalidated', { entity: 'Monitor', params: { accountUuid, projectUuid } });
```

### warn -- Unexpected but Recoverable

Use when something unexpected happened but the system recovered or used a fallback. Warns should be investigated but are not urgent.

```typescript
log.warn('Response time above threshold', { monitorUuid, responseTime: 2450, threshold: 2000 });
log.warn('Cache miss, serving stale data', { entity: 'Dashboard', staleAge: 120 });
log.warn('Retry attempt', { operation: 'sendEmail', attempt: 2, maxRetries: 3 });
log.warn('Redis connection lost, using fallback', { error: 'ECONNREFUSED' });
```

### error -- Something Broke

Use when an operation failed and could not recover. Errors should trigger alerts and be investigated promptly.

```typescript
log.error('Database query failed', { error: err.message, query: 'findMonitors' });
log.error('Payment processing failed', { userId, amount, error: err.message });
log.error('Unhandled exception in request handler', { error: err.stack, path: '/api/monitors' });
log.error('Data integrity violation', { entity: 'Monitor', expected: 'active', found: 'deleted' });
```

### A Rule of Thumb

If you would wake someone up at 3 AM for it, it is `error`. If you would want to know about it on Monday morning, it is `warn`. If it is just normal operations, it is `info`. If it is only useful when debugging, it is `debug`.

## Best Practices

### Log at Boundaries

Log at the boundaries of your system -- where data enters and exits. Controller entry/exit, service calls, database queries, external API calls, event emission/consumption.

```typescript
class MonitorController {
  async getMonitor(ctx: RequestContext) {
    ctx.log.info('GET /monitors/:uuid', { monitorUuid: ctx.params.uuid });

    const monitor = await this.service.getMonitor(ctx.params.uuid);

    ctx.log.info('Monitor retrieved', { monitorUuid: ctx.params.uuid, status: monitor.status });
    return ctx.json(monitor);
  }
}
```

### Include Just Enough Context

Include enough context to reconstruct what happened, but not so much that logs become unreadable or expensive to store.

```typescript
// Too little -- useless for debugging
log.error('Something failed');

// Too much -- expensive to store, hard to read
log.error('Monitor check failed', {
  monitor: entireMonitorObject,  // 200 fields
  config: entireConfigObject,    // 50 fields
  response: entireHttpResponse   // Could be megabytes
});

// Just right -- actionable context
log.error('Monitor check failed', {
  monitorUuid: monitor.uuid,
  url: config.url,
  statusCode: response.status,
  error: err.message
});
```

### Never Log Secrets

```typescript
// NEVER
log.info('Auth attempt', { token: request.headers.authorization });
log.debug('Database connected', { connectionString: process.env.DATABASE_URL });

// ALWAYS redact
log.info('Auth attempt', { tokenPrefix: token.substring(0, 8) + '...' });
log.debug('Database connected', { host: dbConfig.host, database: dbConfig.database });
```

### Test Cleanup

If your tests configure the logger, always reset in `afterEach`:

```typescript
import { Logger } from '@orijs/logging';

describe('MyService', () => {
  afterEach(() => {
    Logger.reset(); // Required if any test calls Logger.configure()
  });

  it('should log at debug level', () => {
    Logger.configure({ level: 'debug' });
    // ... test code
  });
});
```

## Complete Application Setup

Here is a production logging setup for a monitoring application:

```typescript
// logging-setup.ts
import {
  Logger,
  consoleTransport,
  fileTransport,
  filterTransport,
  multiTransport,
  ANSI_COLORS
} from '@orijs/logging';

export function configureLogging(isProduction: boolean) {
  // Console transport -- pretty in dev, JSON in prod
  const console = consoleTransport({
    pretty: !isProduction,
    json: isProduction
  });

  // Build transport list
  const transports = [console];

  // File transport in production
  if (isProduction) {
    transports.push(
      fileTransport('./logs/app.log', {
        rotate: { size: '50mb', keep: 10 }
      })
    );
  }

  Logger.configure({
    level: isProduction ? 'info' : 'debug',
    transports,

    // Application-specific trace fields
    traceFields: {
      correlationId: { abbrev: 'trcId',  color: ANSI_COLORS.gray },
      accountUuid:   { abbrev: 'acctId', color: ANSI_COLORS.cyan },
      projectUuid:   { abbrev: 'projId', color: ANSI_COLORS.blue },
      userId:        { abbrev: 'usrId',  color: ANSI_COLORS.green },
    },

    // Async buffering for production performance
    async: isProduction,
    flushInterval: isProduction ? 10 : 0,
  });
}
```

```typescript
// main.ts
import { configureLogging } from './logging-setup';

const isProduction = process.env.NODE_ENV === 'production';
configureLogging(isProduction);

const log = new Logger('Application');
log.info('Starting application', { environment: isProduction ? 'production' : 'development' });

// ... application setup ...

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('Received SIGTERM, shutting down...');
  await Logger.shutdown();
  process.exit(0);
});
```

## Summary

OriJS's logging system gives you production-grade structured logging without sacrificing developer experience:

- **Transport-based architecture** -- swap console for Datadog, ELK, or custom destinations
- **Structured data** -- every log entry is a searchable, aggregatable JSON object
- **Automatic request context** -- correlationId, traceId, and user metadata propagated via AsyncLocalStorage
- **Async buffered writes** -- sonic-boom inspired buffering that does not block your application
- **Child loggers** -- immutable context inheritance via `.with()` and `.child()`
- **Distributed tracing** -- W3C-compatible trace context propagated across services
- **Pretty dev output** -- colored, abbreviated trace fields, syntax-highlighted stack traces
- **Custom transports** -- three methods to implement for any destination
- **Environment configuration** -- configurable via environment variables or config provider
- **Graceful shutdown** -- `Logger.shutdown()` ensures all buffered logs are written

The logging system follows the same provider philosophy as every other OriJS infrastructure component. The framework gives you production-ready defaults, and you replace them when your needs change.

---

[Previous: Caching <-](./14-caching.md) | [Next: Testing ->](./16-testing.md)
