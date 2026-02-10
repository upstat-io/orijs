# @orijs/logging

> Technical spec for the logging package. Source: `packages/logging/src/`

## Logger

Source: `src/logger.ts`

Structured logger with Pino-inspired design. Produces `LogObject` records routed to configurable transports.

```typescript
class Logger {
    constructor(name: string, options?: LoggerOptions, context?: Record<string, unknown>)
}
```

### Log Levels

Source: `src/levels.ts`

Pino-compatible numeric levels:

| Level | Number | Method |
|---|---|---|
| `debug` | 10 | `logger.debug(msg, data?)` |
| `info` | 20 | `logger.info(msg, data?)` |
| `warn` | 30 | `logger.warn(msg, data?)` |
| `error` | 40 | `logger.error(msg, data?)` |

Level filtering: a message is written only when `messageLevel >= loggerThreshold`. The threshold comes from the instance's `options.level` (falling back to the global level).

### LogObject

```typescript
interface LogObject {
    time: number;       // Date.now()
    level: LevelNumber; // 10 | 20 | 30 | 40
    msg: string;
    name?: string;
    [key: string]: unknown;  // context fields spread into object
}
```

Context from the logger instance and per-call `data` are spread directly into the log object (not nested under a `context` key).

### Instance Methods

| Method | Signature | Description |
|---|---|---|
| `debug()` | `(msg: string, data?: Record<string, unknown>): void` | Log at debug level |
| `info()` | `(msg: string, data?: Record<string, unknown>): void` | Log at info level |
| `warn()` | `(msg: string, data?: Record<string, unknown>): void` | Log at warn level |
| `error()` | `(msg: string, data?: Record<string, unknown>): void` | Log at error level |
| `table()` | `(msg: string, data: Record<string, unknown>[], columns?: string[]): void` | Log tabular data at info level using `Bun.inspect.table()` |
| `with()` | `(data: Record<string, unknown>): Logger` | Create child logger with merged context (immutable) |
| `child()` | `(name: string): Logger` | Create child logger with new name, inheriting context and level |
| `setMeta()` | `(meta: Record<string, unknown>): void` | Inject metadata into this logger's context; notifies `setMetaCallback` |
| `propagationHeaders()` | `(): Record<string, string>` | Returns headers for HTTP cross-service propagation |
| `propagationMeta()` | `(): Record<string, unknown>` | Returns full context for queue/event propagation |

`with()` and `child()` preserve `setMetaCallback` and explicit transports from the parent logger. Both create new `Logger` instances (immutable pattern).

### Static Methods

| Method | Signature | Description |
|---|---|---|
| `configure()` | `(options: LoggerGlobalOptions): void` | Set global defaults, register trace fields, configure async buffering. Flushes pending logs. |
| `reset()` | `(): void` | Reset all global state (level, transports, buffer, trace fields). For test isolation. |
| `flush()` | `(): void` | Synchronously flush async buffer and pending logs. |
| `shutdown()` | `(): Promise<void>` | Stop buffer timer, flush all logs, then `flush()` + `close()` all transports via `Promise.allSettled`. |
| `fromMeta()` | `(name: string, meta: Record<string, unknown>, options?: LoggerOptions): Logger` | Create logger from propagation metadata (cross-service context restoration). |
| `console()` | `(name?: string): Logger` | Create simple console logger at debug level (fallback for no-context situations). |
| `inspect()` | `(value: unknown, options?): string` | Format value using `Bun.inspect`, respects `[Bun.inspect.custom]`. |

### LoggerGlobalOptions

```typescript
interface LoggerGlobalOptions extends LoggerOptions {
    async?: boolean;              // Enable async buffering (default: true)
    flushInterval?: number;       // Buffer flush interval in ms (default: 10)
    bufferSize?: number;          // Buffer size before auto-flush (default: 4096)
    traceFields?: Record<string, TraceFieldDef>;  // Application trace fields
}
```

### Write Path

Log objects follow this path:

1. Level check: `isLevelEnabled(messageLevel, threshold)` -- returns early if below threshold
2. Build `LogObject` with `time`, `level`, `msg`, `name`, spread context and per-call data
3. Route via `writeLogObject()`:
   - If no explicit transports and `Logger.initialized === false`: buffer to `Logger.pendingLogs[]`
   - If `logBuffer.isEnabled()` and no explicit transports: buffer via `logBuffer.write()`
   - Otherwise: synchronous write to all transports

---

## Context System

Source: `src/context.ts`

### AsyncLocalStorage Integration

Uses `node:async_hooks` `AsyncLocalStorage` to maintain per-request context:

```typescript
interface RequestContextData {
    log: Logger;
    correlationId: string;
    trace?: TraceContext;
    meta?: Record<string, unknown>;
}
```

### Key Functions

| Function | Signature | Description |
|---|---|---|
| `requestContext()` | `(): RequestContextData` | Gets current context from `AsyncLocalStorage`. Falls back to a cached singleton with `Logger.console()` and empty correlationId when no store exists. |
| `runWithContext()` | `<T>(context: RequestContextData, fn: () => T \| Promise<T>): T \| Promise<T>` | Runs function within a scoped context via `storage.run()`. |
| `setMeta()` | `(meta: Record<string, unknown>): void` | Merges metadata into current context's `meta` field and updates the logger via `log.with(meta)`. No-op if no context exists. |
| `generateCorrelationId()` | `(): string` | Returns `crypto.randomUUID()`. |
| `generateSpanId()` | `(): string` | Returns first 16 hex chars of a UUID (64-bit per W3C/OpenTelemetry spec). |
| `createTraceContext()` | `(traceId?, spanId?): TraceContext` | Creates new trace context. Uses provided traceId or generates new UUID. Incoming spanId becomes `parentSpanId`. |
| `createChildTraceContext()` | `(parent: TraceContext): TraceContext` | Creates child context preserving `traceId`, generating new `spanId`, setting `parentSpanId` to parent's `spanId`. |
| `capturePropagationMeta()` | `(): PropagationMeta \| undefined` | Captures current context for cross-service propagation. Creates a child trace span. Returns `undefined` if no meaningful context exists. |

### TraceContext

```typescript
interface TraceContext {
    readonly traceId: string;       // Preserved across services
    readonly spanId: string;        // Unique per operation
    readonly parentSpanId?: string;  // Enables trace tree reconstruction
}
```

### PropagationMeta

```typescript
interface PropagationMeta {
    readonly correlationId?: string;
    readonly traceId?: string;
    readonly spanId?: string;
    readonly parentSpanId?: string;
    readonly [key: string]: unknown;  // Application-injected fields
}
```

All fields use camelCase. Compatible with `Logger.propagationMeta()` output and `Logger.fromMeta()` input.

---

## Trace Fields

Source: `src/trace-fields.ts`

Centralized handling of trace/context fields for log formatting. Fields are split into core (built-in) and application-registered.

### Core Trace Fields (always available)

| Field | Abbreviation | Color |
|---|---|---|
| `correlationId` | `corrId` | brightYellow |
| `traceId` | `trcId` | brightYellow |
| `spanId` | `spanId` | gray |
| `parentSpanId` | `pSpanId` | gray |

### Registration

```typescript
function registerTraceFields(fields: Record<string, TraceFieldDef>): void
function resetTraceFields(): void  // For testing
```

Application fields are registered at startup (typically via `Logger.configure({ traceFields })`). Stored in a module-level `appTraceFields` record separate from core fields.

### TraceFieldDef

```typescript
interface TraceFieldDef {
    readonly abbrev: string;  // Abbreviated display name
    readonly color: string;   // ANSI color code
}
```

### Utility Functions

| Function | Description |
|---|---|
| `getTraceFields()` | Returns merged core + app fields. Creates new object on each call. |
| `isTraceField(name)` | Checks if field name is in core or app trace fields. |
| `getTraceField(name)` | Returns `TraceFieldDef` or `undefined`. |
| `truncateValue(value, length?)` | Truncates string to `length` chars (default: 8). |
| `formatTraceField(name, value, useColors?)` | Formats as `abbrev:truncatedValue` with optional ANSI coloring. |
| `extractTraceFields(context)` | Splits context into `[traceFields, otherFields]` tuple. |

### ANSI_COLORS

Exported constant with standard ANSI color codes: `reset`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, `brightYellow`.

---

## Transports

Source: `src/transports/`

All transports implement the `Transport` interface:

```typescript
interface Transport {
    write(obj: LogObject): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
```

Transports are accessible both as individual exports and via the `transports` namespace object.

### transports.console() / consoleTransport()

Source: `src/transports/console.ts`

```typescript
function consoleTransport(options?: ConsoleTransportOptions): Transport

interface ConsoleTransportOptions {
    pretty?: boolean;    // Human-readable output
    json?: boolean;      // JSON output
    depth?: number;      // Object inspection depth (default: 4)
    colors?: boolean;    // ANSI colors (default: auto-detect TTY)
}
```

Mode detection priority:
1. `options.pretty` if defined
2. `!options.json` if defined
3. Auto-detect: pretty when `NODE_ENV !== 'production'`

Pretty format: `HH:MM:SS:L:Name traceFields message: otherContext`
- Level chars: `D` (debug/magenta), `I` (info/cyan), `W` (warn/yellow), `E` (error/red)
- Trace fields displayed with abbreviated names and colors
- Error objects formatted via `Bun.inspect()` with syntax-highlighted stack traces
- Non-trace context displayed as `key:value` pairs after the message

JSON format: `JSON.stringify(obj)` per line.

`flush()` and `close()` are no-ops (console writes are synchronous).

### transports.file() / fileTransport()

Source: `src/transports/file.ts`

```typescript
function fileTransport(path: string, options?: FileTransportOptions): Transport

interface FileTransportOptions {
    rotate?: FileRotateOptions;
    sync?: boolean;                   // Blocking writes (default: false)
    onError?: (error: Error) => void; // Write error callback
}

interface FileRotateOptions {
    size?: string;    // e.g., '10mb', '100kb'
    interval?: string; // e.g., '1d', '1h'
    keep?: number;    // Rotated files to keep (default: 5)
}
```

Behavior:
- Creates parent directory if missing (`mkdirSync` with `recursive: true`)
- Async mode (default): batches writes in a `writeBuffer[]`, flushes via `queueMicrotask` + `appendFile`
- Sync mode: uses `appendFileSync` per log entry
- Size-based rotation: shifts files numerically (`app.log` -> `app.log.1` -> `app.log.2` -> ...), deletes oldest beyond `keep`
- Circuit breaker: after 5 consecutive write failures, clears buffer and reports to stderr

Size parsing supports: `kb`, `mb`, `gb` suffixes (case-insensitive).

### transports.filter() / filterTransport()

Source: `src/transports/filter.ts`

```typescript
function filterTransport(transport: Transport, options: FilterOptions): Transport

interface FilterOptions {
    includeNames?: string[];  // Only log these names (empty = all)
    excludeNames?: string[];  // Never log these names
}
```

Wraps another transport, filtering by `LogObject.name`. Uses `Set` for O(1) lookup. Logic:
1. If `includeSet` exists and name is not in it: filter out
2. If `excludeSet` exists and name is in it: filter out
3. Otherwise: pass through to wrapped transport

`flush()` and `close()` delegate to the wrapped transport.

### transports.multi() / multiTransport()

Source: `src/transports/multi.ts`

```typescript
function multiTransport(transports: Transport[]): Transport
```

Fan-out transport that writes to multiple transports. Each transport's `write()` is wrapped in `try/catch` -- one failure does not prevent others from receiving the log.

`flush()` and `close()` use `Promise.allSettled` to ensure all transports complete. If any fail, throws `AggregateError` with collected rejection reasons.

---

## Log Buffer

Source: `src/log-buffer.ts`

Singleton `LogBufferManager` for sonic-boom style async buffered writes.

### Constants

| Constant | Value | Description |
|---|---|---|
| `DEFAULT_FLUSH_INTERVAL` | 10ms | Timer-based flush interval |
| `DEFAULT_BUFFER_SIZE` | 4096 bytes | Auto-flush threshold |
| `MAX_WRITE_SIZE` | 16KB | Docker buffer limit |
| `MAX_BUFFER_SIZE` | 1MB | Maximum buffer before dropping logs |

### Buffer Mechanics

- Logs are serialized to JSON strings and concatenated (sonic-boom style)
- Flush triggers: interval timer OR buffer size threshold
- Flush is re-entrant safe via a `writing` flag (JS single-threaded guarantee)
- Buffer is atomically swapped on flush -- new writes during flush go to a fresh buffer
- When buffer exceeds `maxBufferSize`, logs are dropped and a count is tracked
- On next flush, a warning log is prepended with the dropped count

### Flush Process

1. Check `writing` flag (skip if already flushing)
2. Capture and reset `droppedCount`
3. Swap buffer (`this.buffer = ''`)
4. Prepend drop warning if any logs were dropped
5. Split data by newlines, parse each back to `LogObject`
6. Write to transports (resolved via `transportResolver`)
7. Transport write errors are caught individually and reported to stderr
8. Parse errors logged to stderr with truncated line preview (100 chars)

### Timer Management

- Timer is created lazily on first `write()` call
- `flushTimer.unref()` prevents the timer from keeping the process alive
- `shutdown()` stops timer and performs final flush

---

## Configuration

Source: `src/config.ts`

Bridge between the config provider and logger setup.

### LogConfig

```typescript
interface LogConfig {
    level: LevelName;
    includeNames: string[];
    excludeNames: string[];
    fileEnabled: boolean;
    filePath: string;         // default: './logs/app.log'
    fileMaxSize: string;      // default: '10mb'
    fileMaxFiles: number;     // default: 5
    jsonFormat: boolean;
}
```

### readLogConfig()

```typescript
async function readLogConfig(config: ConfigProvider): Promise<LogConfig>
```

Reads these environment keys:

| Key | Type | Default |
|---|---|---|
| `LOG_LEVEL` | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` |
| `LOG_INCLUDE_NAMES` | Comma-separated string | `[]` |
| `LOG_EXCLUDE_NAMES` | Comma-separated string | `[]` |
| `LOG_FILE_ENABLED` | `'true' \| 'false'` | `false` |
| `LOG_FILE_PATH` | String | `'./logs/app.log'` |
| `LOG_FILE_MAX_SIZE` | Size string (e.g., `'10mb'`) | `'10mb'` |
| `LOG_FILE_MAX_COUNT` | Integer string | `5` |
| `LOG_JSON` | `'true' \| 'false'` | `false` |

Uses a local `ConfigProvider` interface to avoid circular dependency with `@orijs/config`.

### buildLoggerOptions()

```typescript
function buildLoggerOptions(config: LogConfig): LoggerOptions
```

Builds transport chain:
1. Creates console transport (pretty or JSON based on `jsonFormat`)
2. Creates file transport if `fileEnabled`
3. Wraps both in filter transport if name filtering is configured
4. If 2+ transports, wraps in `multiTransport`
5. Returns `{ level, transports }`

### createLoggerOptionsFromConfig()

```typescript
async function createLoggerOptionsFromConfig(config: ConfigProvider): Promise<LoggerOptions>
```

Convenience function: calls `readLogConfig()` then `buildLoggerOptions()`.
