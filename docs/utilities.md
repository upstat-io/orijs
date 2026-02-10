# Utility Packages

> Technical specs for @orijs/sql and @orijs/test-utils.

---

## @orijs/sql

Source: `packages/sql/src/`

Type-safe SQL interpolation wrapper around Bun's native `sql` tagged template.

### Core Concept

OriSQL distinguishes between two types of interpolated values in SQL templates:

| Syntax | Type | Handling |
|---|---|---|
| `${value}` | Parameterized value | Passed to Bun SQL as a bound parameter (SQL injection safe) |
| `${[identifier]}` | SQL identifier (table/column name) | Passed to `bunSql('identifier')` for PostgreSQL-level validation |

### SqlIdentifier

```typescript
type SqlIdentifier = readonly [string];
```

A single-element string array. Detection via `isIdentifier()`:

```typescript
function isIdentifier(value: unknown): value is SqlIdentifier {
    return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string';
}
```

O(1) check: `Array.isArray` + length + type check.

### createOriSql()

```typescript
interface BunSqlFunction {
    (strings: TemplateStringsArray, ...values: unknown[]): unknown;  // Tagged template
    (identifier: string): unknown;  // Identifier mode
}

function createOriSql(bunSql: BunSqlFunction): OriSqlFactory
```

Returns a tagged template function that:
1. Maps over template values
2. Converts `SqlIdentifier` values to `bunSql(value[0])` (native identifier handling)
3. Leaves other values as-is (parameterized by Bun's SQL driver)
4. Passes the template to `bunSql(strings, ...convertedValues)`

### OriSqlFactory

```typescript
type OriSqlFactory = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> & T;
```

Returns `Promise<T> & T` to match Bun's SQL thenable pattern:
- Can be awaited: `const rows = await oriSql<User[]>\`...\``
- Can access array properties directly on the thenable

The generic `T` has no default -- callers must specify the expected return type.

### Security Model

- **Values** (`${value}`): parameterized by Bun's SQL driver. Safe from SQL injection by design.
- **Identifiers** (`${[name]}`): passed to `bunSql('identifier')` which provides:
  - Automatic quoting of reserved words (e.g., `user` -> `"user"`)
  - PostgreSQL-level validation (invalid identifiers rejected with error code `42703` or `42601`)
  - SQL injection attempts rejected by PostgreSQL

Identifiers should come from trusted sources (e.g., `Mapper.defineTables()` output), never from user input.

### Error Propagation

Errors from Bun's SQL driver propagate directly. Common PostgreSQL error codes:

| Code | Meaning |
|---|---|
| `42703` | Undefined column (invalid identifier) |
| `42601` | Syntax error |
| `23505` | Unique violation |
| `23503` | Foreign key violation |

---

## @orijs/test-utils

Source: `packages/test-utils/src/`

Test infrastructure for OriJS framework packages, providing Redis testcontainers and async helpers.

### BaseContainerManager

Source: `src/core/base-container-manager.ts`

Abstract base class for testcontainer lifecycle management.

```typescript
abstract class BaseContainerManager {
    constructor(packageName: string)
    async start(): Promise<StartedTestContainer>
    async stop(): Promise<void>
    isReady(): boolean
    async healthCheck(): Promise<boolean>
    async forceStop(): Promise<void>

    protected abstract createContainer(): Promise<StartedTestContainer>;
    protected abstract performHealthCheck(): Promise<boolean>;
    protected abstract getContainerImage(): string;
    protected abstract getContainerType(): string;
}
```

#### Retry Logic

`start()` calls `executeWithRetry()` with:
- Max retries: 3
- Per-attempt timeout: 60 seconds
- 1-second delay between retries (no exponential backoff)
- Aggressive cleanup between retries (Docker CLI-based)

#### Health Verification

After container start, `verifyContainerHealth()` polls:
- Max checks: 10
- Check interval: 300ms
- Per-check timeout: 3 seconds

#### Circuit Breaker

Prevents repeated start attempts after persistent failures:
- Threshold: 5 consecutive failures
- Timeout: 30 seconds (circuit resets after this period)
- `start()` throws immediately when circuit is open

#### Health Check Caching

`healthCheck()` caches results for 30 seconds to avoid redundant checks.

#### Container Cleanup

Uses Docker CLI (`execSync`) to clean up:
- Dead containers matching the container image with `org.testcontainers=true` label
- Exited containers matching the container image
- Package-scoped aggressive cleanup using `POSTGRES_DB` env var filter (avoids killing parallel test containers)

### RedisContainerManager

Source: `src/core/redis-container-manager.ts`

Extends `BaseContainerManager` for Redis-specific lifecycle.

```typescript
class RedisContainerManager extends BaseContainerManager
```

Container configuration:
- Image: `redis:7.2`
- Command: `redis-server --maxmemory-policy noeviction --save "" --appendonly no`
- Startup timeout: 60 seconds
- Container reuse enabled by default (disabled in CI or when `TESTCONTAINERS_REUSE=false`)

| Method | Description |
|---|---|
| `getConnectionConfig()` | Returns `{ host, port, connectionString }` |
| `createRedisClient()` | Creates new `ioredis` client with connection config |
| `getRedisClient()` | Returns the primary client created during `start()` |
| `setupNestJSEnvironment()` | Sets `SECRET_REDIS_HOST` and `SECRET_REDIS_PORT` env vars |
| `flushAll()` | Calls `FLUSHALL` on the primary client |
| `createQueue(name)` | Creates BullMQ queue with `${packageName}-${name}` prefix |
| `waitForJobCompletion(name, timeout?)` | Waits for BullMQ job completion via `QueueEvents` |
| `waitForEvent(channel, timeout?)` | Waits for Redis pub/sub message with package-prefixed channel |
| `cleanup()` | Obliterates all queues, flushes Redis data |

Queue names are automatically prefixed with the package name for isolation between parallel test suites.

`stop()` override adds timeout-protected cleanup:
1. Cleanup queues and flush data (3-second timeout)
2. Quit Redis client (2-second timeout, falls back to `disconnect()`)
3. Call `super.stop()` for container shutdown

### createRedisTestHelper()

Source: `src/factories/redis-test-helper-factory.ts`

```typescript
function createRedisTestHelper(packageName: string): RedisTestHelper
```

Factory that creates a package-isolated Redis test helper facade. Manages a global `Map<string, RedisContainerManager>` to share containers within a package and across test files.

The `RedisTestHelper` interface exposes the same methods as `RedisContainerManager` without requiring direct access to the manager:

```typescript
interface RedisTestHelper {
    isReady(): boolean;
    healthCheck(): Promise<boolean>;
    getConnectionConfig(): RedisContainerConfig;
    createRedisClient(): Redis;
    setupNestJSEnvironment(): { host: string; port: number };
    flushAll(): Promise<void>;
    createQueue(queueName: string): Queue;
    waitForJobCompletion(queueName: string, timeout?: number): Promise<Job>;
    waitForEvent(channel: string, timeout?: number): Promise<string>;
    getPackageName(): string;
}
```

Additional lifecycle functions:
- `startRedisTestContainer(packageName)` -- starts container and stores global reference
- `stopRedisTestContainer(packageName)` -- stops and removes from global map
- `stopAllRedisTestContainers()` -- emergency cleanup of all managed containers

Process signal handlers (`SIGINT`, `SIGTERM`, `exit`) automatically clean up containers.

### createBunTestPreload()

Source: `src/factories/bun-test-setup-factory.ts`

```typescript
function createBunTestPreload(options: BunTestSetupOptions): () => Promise<void>

interface BunTestSetupOptions {
    packageName: string;
    dependencies: ('postgres' | 'redis')[];
    runMigrations?: boolean;
    migrationsPath?: string;
    timeout?: number;
}
```

Returns an async function intended for Bun test preload scripts. Starts containers in parallel based on declared dependencies.

```typescript
async function teardownBunTest(packageName: string): Promise<void>
```

Companion teardown function for `afterAll()` hooks. Stops all containers for the package via `Promise.allSettled`.

### Async Test Helpers

Source: `src/helpers/async-test-helpers.ts`

#### waitFor()

```typescript
async function waitFor(condition: () => boolean, options?: WaitForOptions): Promise<void>

interface WaitForOptions {
    readonly timeout?: number;   // default: 5000
    readonly interval?: number;  // default: 50
    readonly message?: string;
}
```

Polls a synchronous condition function at `interval` until it returns `true` or `timeout` is exceeded. Throws `Error` with custom or default message on timeout.

#### waitForAsync()

```typescript
async function waitForAsync(condition: () => Promise<boolean>, options?: WaitForOptions): Promise<void>
```

Same as `waitFor()` but the condition function can be async. Useful for conditions that require database queries or API calls.

#### withTimeout()

```typescript
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message?: string): Promise<T>
```

Wraps a promise with `Promise.race` against a timeout. Clears the timeout timer in `finally` to prevent leaks. Default message: `'Operation timed out'`.

#### delay()

```typescript
function delay(ms: number): Promise<void>
```

Simple `setTimeout` wrapper. Use sparingly -- prefer `waitFor()` with a condition for deterministic waiting.
