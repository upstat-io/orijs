# @orijs/bullmq - Technical Reference

Package: `packages/bullmq/src/`

## Overview

`@orijs/bullmq` provides production-ready distributed event and workflow execution using BullMQ queues and Redis. It implements `EventProvider` from `@orijs/events` and `WorkflowProvider` from `@orijs/workflows`, adding per-event-type queue isolation, request-response tracking via QueueEvents, scheduled/cron events, and distributed workflow execution with BullMQ FlowProducer.

Shared constant: `DEFAULT_TIMEOUT_MS = 30_000` (source: `constants.ts`)

---

## 1. BullMQEventProvider

Source: `events/bullmq-event-provider.ts`

Distributed event provider implementing `EventProvider` from `@orijs/events`.

### Composition

The provider composes three components:

- `QueueManager`: per-event-type queue and worker management
- `CompletionTracker`: request-response pattern via QueueEvents
- `ScheduledEventManager`: recurring/cron events

All three are injectable via `BullMQEventProviderOptions` for testing.

### Configuration

```typescript
interface BullMQEventProviderOptions {
    readonly connection: ConnectionOptions;
    readonly defaultTimeout?: number;                     // Default: 30000ms
    readonly defaultJobOptions?: Partial<JobsOptions>;    // BullMQ job options passthrough
    readonly defaultWorkerOptions?: Partial<WorkerOptions>; // BullMQ worker options passthrough
    readonly queueManager?: IQueueManager;
    readonly completionTracker?: ICompletionTracker;
    readonly scheduledEventManager?: IScheduledEventManager;
}
```

### Per-Event-Type Queue Strategy

Each event type gets its own BullMQ queue: `event.{eventName}` (e.g., `event.monitor.check`). This enables:

- Independent scaling (more workers for busy events)
- Isolation (one event type's issues do not block others)
- Clear monitoring (queue depth per event type)

### emit() Flow

```typescript
emit<TReturn>(eventName: string, payload: unknown, meta: PropagationMeta, options?: EmitOptions): EventSubscription<TReturn>
```

1. Creates `EventSubscription` via `createSubscription()`
2. Gets queue name from `QueueManager.getQueueName(eventName)`
3. Builds `EventMessage` with `EVENT_MESSAGE_VERSION`, `crypto.randomUUID()` for eventId, payload, meta, correlationId, causationId, timestamp
4. Builds job options: applies `delay` and `idempotencyKey` (mapped to BullMQ `jobId`)
5. Determines timeout: `options.timeout ?? defaultTimeout`
6. **Registers with CompletionTracker immediately** (not lazily on subscribe). Passes `_resolve`/`_reject` callbacks and timeout.
7. Adds job to queue via `QueueManager.addJob()` (async, not awaited)
8. On job creation success: maps `job.id` to `correlationId` via `CompletionTracker.mapJobId()`
9. On job creation failure: calls `CompletionTracker.fail()` to clean up and trigger error callback
10. Returns subscription

### subscribe() Flow

```typescript
async subscribe<TPayload, TReturn>(eventName: string, handler: EventHandlerFn<TPayload, TReturn>): Promise<void>
```

1. Wraps the handler to extract `EventMessage` from BullMQ `job.data`
2. Calls `QueueManager.registerWorker(eventName, wrappedHandler)` and **awaits** it (ensures worker is ready before returning)

### scheduleEvent() / unscheduleEvent()

```typescript
async scheduleEvent(eventName: string, options: ScheduleOptions): Promise<void>
async unscheduleEvent(eventName: string, scheduleId: string): Promise<void>
```

Delegates to `ScheduledEventManager`. Separate methods per design decision (not overloaded on `emit()`).

### Shutdown Order

Per BullMQ best practices, shutdown proceeds in order:

1. `QueueManager.stop()` -- workers first (wait for current jobs), then queues
2. `CompletionTracker.stop()` -- QueueEvents (safe since workers finished)
3. `ScheduledEventManager.stop()` -- scheduled queues last

This ensures workers finish processing before QueueEvents closes, QueueEvents receives all completion events before closing, and no pending completion callbacks are lost.

Idempotency guard: `stop()` checks `started` flag and returns immediately on double-stop.

---

## 2. QueueManager

Source: `events/queue-manager.ts`

Manages BullMQ queues and workers with per-event-type routing.

### Configuration

```typescript
interface QueueManagerOptions {
    readonly connection: ConnectionOptions;
    readonly queuePrefix?: string;           // Default: 'event'
    readonly metrics?: QueueMetrics;
    readonly defaultRetry?: RetryOptions;    // Default: 3 attempts, exponential, 1000ms delay
    readonly defaultJobOptions?: Partial<JobsOptions>;   // BullMQ passthrough
    readonly defaultWorkerOptions?: Partial<WorkerOptions>; // BullMQ passthrough
    readonly QueueClass?: ...;               // For testing
    readonly WorkerClass?: ...;              // For testing
    readonly logger?: Logger;
}
```

### Queue Name Convention

`getQueueName(eventName)` returns `${queuePrefix}.${eventName}`, e.g. `event.monitor.check`.

### getQueue()

Lazy-creates queues. If a queue for the event name already exists in the `queues` Map, returns the cached instance. Otherwise creates a new `Queue`, attaches an error handler, stores in the map, and returns it.

### addJob() -- Job Options Merging

Job options are merged in precedence order (highest last):

1. `defaultRetry` -- attempts, backoff type, backoff delay
2. `defaultJobOptions` -- full BullMQ `JobsOptions` passthrough
3. Caller `options` -- per-call overrides

```typescript
const jobOptions: JobsOptions = {
    attempts: this.defaultRetry.attempts,
    backoff: { type: this.defaultRetry.backoffType, delay: this.defaultRetry.backoffDelay },
    ...this.defaultJobOptions,
    ...options
};
```

After adding the job, calls `metrics.onJobAdded?.(eventName, job.id)` if configured.

### registerWorker()

```typescript
async registerWorker<TResult>(eventName: string, handler: JobHandler<TResult>): Promise<void>
```

1. Creates worker on the queue `${queuePrefix}.${eventName}`
2. Default worker concurrency: **10** (set via `defaultWorkerOptions.concurrency`)
3. Tracks job start times in a `Map<string, number>` for duration metrics
4. Attaches error, completed, and failed event listeners for metrics hooks
5. **Awaits `worker.waitUntilReady()`** -- critical for preventing race conditions where jobs complete before the worker is connected
6. Stores worker in `workers` Map

### Metrics Hooks

```typescript
interface QueueMetrics {
    onJobAdded?(eventName: string, jobId: string): void;
    onJobCompleted?(eventName: string, jobId: string, durationMs: number): void;
    onJobFailed?(eventName: string, jobId: string, error: Error): void;
}
```

Job duration is tracked via `Date.now()` at job start and computed at completion/failure.

### Shutdown

1. Close workers first (`worker.close()` without force waits for current jobs)
2. Then close queues

Both workers and queues get a persistent `connectionErrorHandler` attached to the underlying ioredis `_client` before calling `close()`. This is a **workaround for a BullMQ bug** where `RedisConnection.close()` removes error handlers before async operations complete, causing "Connection is closed" errors from blocking commands (like `BRPOPLPUSH`) to become unhandled.

---

## 3. CompletionTracker

Source: `events/completion-tracker.ts`

Handles the request-response pattern by routing BullMQ job completion events back to the original emitter via correlation IDs.

### Data Flow

```
1. emit() calls register(queueName, correlationId, onSuccess, onError, {timeout})
2. emit() calls QueueManager.addJob() -> returns job.id
3. emit() calls mapJobId(queueName, job.id, correlationId)
4. Worker processes job, returns result
5. QueueEvents fires 'completed' with { jobId, returnvalue }
6. CompletionTracker looks up correlationId from jobId
7. Calls onSuccess(result) which resolves EventSubscription
```

### Internal State

- `queueEvents: Map<string, IQueueEventsLike>` -- per-queue QueueEvents instances
- `pending: Map<string, Map<string, PendingCompletion>>` -- queueName -> correlationId -> callback
- `jobIdToCorrelationId: Map<string, Map<string, string>>` -- queueName -> jobId -> correlationId
- `earlyResults: Map<string, Map<string, EarlyResult>>` -- queueName -> jobId -> result (race condition buffer)

### Configuration

```typescript
interface CompletionTrackerOptions {
    readonly connection: ConnectionOptions;
    readonly defaultTimeout?: number;           // Default: 30000ms, 0 = no timeout
    readonly logger?: ILogger;
    readonly QueueEventsClass?: ...;            // For testing
}
```

### Race Condition: Early Results

A job may complete before `mapJobId()` is called (fast job processing). When QueueEvents fires `'completed'` and `getCorrelationId()` returns `undefined`:

1. The result is stored in `earlyResults` via `storeEarlyResult(queueName, jobId, { result, isFailure })`
2. When `mapJobId()` is later called, it checks `getAndRemoveEarlyResult()`
3. If an early result exists, it immediately calls `complete()` or `fail()`

The same pattern handles early failures.

### register()

```typescript
register<TResult>(
    queueName: string,
    correlationId: string,
    onSuccess: CompletionCallback<TResult>,
    onError?: ErrorCallback,
    options?: RegisterOptions
): void
```

1. Ensures QueueEvents instance exists for the queue (lazy creation)
2. Sets up timeout if `timeout > 0`: `setTimeout` that calls `fail()` with timeout error
3. Stores `PendingCompletion` in the pending map

### complete() and fail()

Both methods:

1. Look up the pending completion
2. If not found: return (no-op)
3. Clear timeout if set
4. Remove from pending map
5. Clean up jobId mapping
6. Call the appropriate callback

### QueueEvents Event Parsing

On `'completed'`:
- `returnvalue` is parsed: if `null/undefined` -> `undefined`, if `string` -> `JSON.parse()` (falls back to raw string on parse error), otherwise used directly

On `'failed'`:
- `failedReason` is wrapped in `new Error(failedReason)`

### Timeout Handling

Each registration can have an independent timeout. The timeout `setTimeout` calls `fail(queueName, correlationId, new Error('Request timeout after ${timeout}ms'))`.

### Memory Management

- `complete()` and `fail()` both clean up the pending entry, timeout handle, and jobId mapping
- `cleanupJobIdMapping()` iterates the jobId map to find and remove entries matching the correlationId

### stop()

1. Rejects all pending completions with `'CompletionTracker shutting down'` error (clears timeouts first)
2. Clears pending, jobIdToCorrelationId, and earlyResults maps
3. Adds ioredis error handler workaround (same BullMQ bug as QueueManager)
4. Closes all QueueEvents instances

---

## 4. ScheduledEventManager

Source: `events/scheduled-event-manager.ts`

Manages recurring events using BullMQ repeatable jobs.

### Schedule Types

```typescript
interface CronSchedule {
    readonly scheduleId: string;
    readonly cron: string;       // e.g., '0 * * * *'
    readonly payload: unknown;
    readonly meta?: Record<string, unknown>;
}

interface IntervalSchedule {
    readonly scheduleId: string;
    readonly every: number;      // Milliseconds
    readonly payload: unknown;
    readonly meta?: Record<string, unknown>;
}

type ScheduleOptions = CronSchedule | IntervalSchedule;
```

### Validation

- **Cron**: Must have 5-6 space-separated fields (standard cron or with seconds)
- **Interval**: Must be a positive integer
- Cannot specify both `cron` and `every`
- Must specify at least one

### Queue Strategy

Two modes based on whether `queueManager` is provided:

1. **With QueueManager** (default in `BullMQEventProvider`): Delegates `getQueue()` to `QueueManager`, so scheduled jobs land on `event.{eventName}` queues where `subscribe()` workers listen. Job data is wrapped in an `EventMessage` envelope (version, eventId, eventName, payload, meta, correlationId, timestamp).

2. **Without QueueManager** (standalone): Creates separate queues with `scheduled.{eventName}` prefix. Job data uses a simpler format: `{ payload, meta, scheduledAt }`.

### schedule()

1. Validates schedule options
2. Gets or creates queue
3. Builds `repeat` options (`{ pattern }` for cron, `{ every }` for interval)
4. Adds repeatable job with `jobId: scheduleId`
5. Stores `ScheduleInfo` including `repeatJobKey` from the job result

### unschedule()

1. Looks up `ScheduleInfo` by eventName and scheduleId
2. Calls `queue.removeRepeatableByKey(scheduleInfo.repeatJobKey)`
3. Removes from local tracking

### repeatJobKey Tracking

BullMQ returns a `repeatJobKey` when adding a repeatable job. This key is required for removal via `removeRepeatableByKey()`. The manager stores it in `ScheduleInfo` for each schedule.

### stop()

Same ioredis error handler workaround as other components. Closes all queues and clears schedule tracking.

---

## 5. BullMQWorkflowProvider

Source: `workflows/bullmq-workflow-provider.ts`

Distributed workflow execution using BullMQ FlowProducer for parent-child job hierarchies.

### Design Principles

1. **No in-memory state for step tracking** -- uses `job.getChildrenValues()` for results
2. **StepRegistry lookup for rollback handlers** -- not local storage
3. **QueueEvents for result notification** -- any instance can receive
4. **failParentOnFailure for cascade** -- step failures propagate up the job tree

### Ordering Guarantees

- **Execution order**: GUARANTEED by BullMQ job dependencies (children complete before parent)
- **Completion notification order**: NOT guaranteed (QueueEvents is pub/sub)
- Consumers should NOT rely on QueueEvents delivery order across workflows

### Configuration

```typescript
interface BullMQWorkflowProviderOptions {
    readonly connection: ConnectionOptions;
    readonly queuePrefix?: string;               // Default: 'workflow'
    readonly defaultTimeout?: number;            // Default: 30000ms
    readonly stallInterval?: number;             // Default: 5000ms, minimum: 5000ms
    readonly flowStateCleanupDelay?: number;     // Default: 300000ms (5 minutes)
    readonly maxFlowStates?: number;             // Default: 10000
    readonly stepTimeout?: number;               // Default: 0 (disabled)
    readonly providerId?: string;                // Instance identifier for distributed tracing
    readonly logger?: Logger;
    readonly FlowProducerClass?: ...;
    readonly WorkerClass?: ...;
    readonly QueueEventsClass?: ...;
    readonly QueueClass?: ...;
    readonly stepRegistry?: StepRegistry;
}
```

The `stallInterval` is validated at construction time: values below 5000ms are rejected to avoid false stall detection from GC pauses or network hiccups.

### execute() Flow

```typescript
async execute<TData, TResult>(
    workflow: WorkflowDefinitionLike<TData, TResult>,
    data: TData,
    options?: ExecuteOptions
): Promise<FlowHandle<TResult>>
```

1. Validates provider started and workflow registered (consumer or emitter)
2. Determines effective step groups (from definition or consumer registration)
3. Calls `executeDefinition()`:
   - Generates `flowId`
   - Initializes local flow state (with LRU eviction if at `maxFlowStates`)
   - Captures `PropagationMeta` from `AsyncLocalStorage`
   - Sets up QueueEvents **before** adding job
   - Creates deferred result promise
   - Builds step job retry options from defaults and consumer overrides
   - Builds flow job structure via `FlowBuilder` (or simple job if no steps)
   - **Registers pending result BEFORE adding job** (race condition prevention)
   - Adds job via `FlowProducer.add()`
   - Registers flowId in Redis registry for O(1) lookups
   - Sets up timeout and cleanup
4. Returns `FlowHandle` immediately (non-blocking)

### ExecuteOptions

```typescript
interface ExecuteOptions {
    readonly meta?: PropagationMeta;
    readonly timeout?: number;           // Default: 30000ms. Effective = base + stallInterval
    readonly idempotencyKey?: string;    // BullMQ deduplication key (no colons allowed)
}
```

### Flow Registry -- O(1) Redis Lookup

The provider stores `flowId -> workflowName` mappings in Redis for efficient status lookups:

- Key: `${queuePrefix}:fr:${Bun.hash(flowId).toString(36)}` -- compact via Bun.hash
- TTL: 15 minutes (auto-expires, no explicit cleanup)
- `registerFlowInRegistry()`: `SET key workflowName EX 900`
- `lookupFlowInRegistry()`: `GET key`
- Non-fatal: failures fall back to sequential search across all registered workflow queues

### StepRegistry

Source: `workflows/step-registry.ts`

Two-level `Map<string, Map<string, RegisteredStep>>`: workflow name -> step name -> handler info.

```typescript
interface RegisteredStep {
    readonly handler: StepHandler;
    readonly rollback?: RollbackHandler;
}
```

| Method | Signature | Behavior |
|--------|-----------|----------|
| `register(workflowName, stepName, handler, rollback?)` | void | Stores in two-level map |
| `get(workflowName, stepName)` | `StepHandler` | Throws `StepNotFoundError` if missing |
| `getStep(workflowName, stepName)` | `RegisteredStep` | Returns full info. Throws if missing. |
| `getRollback(workflowName, stepName)` | `RollbackHandler \| undefined` | Returns rollback or undefined (no throw) |
| `has(workflowName, stepName)` | boolean | Existence check |
| `getWorkflowSteps(workflowName)` | `string[]` | All step names for a workflow |
| `clear()` | void | Clears entire registry |

Step names are validated at registration time with pattern: `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`. Names starting with `__` are reserved (rejected).

### Result Accumulation via flattenChildResults()

BullMQ's `job.getChildrenValues()` returns results keyed by `queue:jobId`. The `flattenChildResults()` function extracts actual step results by detecting wrapper types:

- `StepResultWrapper`: extracts `__stepName` -> `__stepResult`, merges `__priorResults`
- `ParallelResultWrapper`: merges `__parallelResults` and `__priorResults`

Both types of results are sanitized via `Json.sanitize()` to prevent prototype pollution.

### Timeout Calculation

Effective timeout = base timeout + stall interval.

The stall interval is added to ensure that if a worker dies mid-workflow, BullMQ's stall detection has time to kick in and another worker can pick up the job before the timeout fires.

Default stall interval: 5000ms (minimum BullMQ allows). Chosen because OriJS workflows are I/O-bound, not CPU-bound -- workers can check in frequently between async operations.

Example: `timeout: 30000` + `stallInterval: 5000` = effective timeout of 35000ms.

### Local State Tracking with LRU Eviction

`localFlowStates: Map<string, LocalFlowState>` tracks status per flowId for the caller instance.

LRU eviction when `maxFlowStates` (default: 10000) is exceeded:

```typescript
private evictOldestFlowStatesIfNeeded(): void {
    while (this.localFlowStates.size >= this.maxFlowStates) {
        const oldestKey = this.localFlowStates.keys().next().value;
        // Clean up associated resources (cleanup handles)
        this.localFlowStates.delete(oldestKey);
    }
}
```

Uses `Map` insertion order as LRU proxy.

### Race Condition Prevention

#### Pending registered BEFORE job added

```typescript
this.registerPendingResult(jobId, flowId, resolve, reject);  // FIRST
await this.flowProducer!.add(job);                           // THEN
```

The pending result is registered before the job is added to BullMQ. This prevents the race where QueueEvents fires `'completed'` before the pending entry exists.

#### Atomic trySettlePending

```typescript
private trySettlePending(jobId: string): { ... } | null {
    const pending = this.pendingResults.get(jobId);
    if (!pending || pending.settled) return null;
    pending.settled = true;              // Atomic flag
    this.pendingResults.delete(jobId);
    return pending;
}
```

The `settled` boolean flag prevents race conditions between the timeout handler and the QueueEvents handler. Only one can "win" and settle the pending result.

#### Timeout with Redis check

When timeout fires, the provider checks Redis before rejecting:

1. Queries `job.getState()` from Redis
2. If `'completed'`: resolves with result (avoids false timeout)
3. If `'failed'`: lets QueueEvents handle it
4. Otherwise: proceeds with timeout rejection

This prevents false timeouts when the job completed in Redis but QueueEvents has not yet delivered the `'completed'` event.

### processStep()

Handles individual step job execution:

1. Extracts `StepJobData` from `job.data`
2. If step name starts with `__parallel__:`: delegates to `processParallelGroup()`
3. Looks up handler from `StepRegistry`
4. Gets accumulated results from `job.getChildrenValues()` + `flattenChildResults()`
5. Creates `WorkflowContext`
6. Executes handler with optional step timeout (`executeStepWithTimeout()`)
7. On success: returns `StepResultWrapper` with `__stepName`, `__stepResult`, `__priorResults`
8. On failure: runs rollbacks (LIFO via StepRegistry), calls `onError`, updates local state, rejects pending result, throws to mark BullMQ job as failed

### processParallelGroup()

1. Parses step names from `__parallel__:step1,step2` format
2. Executes all steps concurrently via `Promise.all()`
3. On any failure: runs rollbacks including successful parallel steps, calls `onError`, rejects, throws
4. On all success: returns `ParallelResultWrapper` with `__parallelResults` and `__priorResults`

### Rollback in Distributed Context

Rollbacks use `job.getChildrenValues()` to find completed steps, then `StepRegistry` to look up rollback handlers. This works across instances because:

- Step results are stored in BullMQ (Redis), not local memory
- Rollback handlers are registered in StepRegistry on the instance processing the step
- Rollbacks run in reverse order of completion

Rollback errors are logged but do not stop other rollbacks. An aggregated summary is logged after all rollbacks complete.

### Shutdown

```
1. Stop step workers (close, wait for current jobs)
2. Stop workflow workers
3. Stop QueueEvents listeners
4. Stop FlowProducer
5. Clear all timers (timeout handles, cleanup handles)
6. Clear pendingResults and localFlowStates
```

All BullMQ components get the ioredis error handler workaround before closing.

---

## 6. FlowBuilder

Source: `workflows/flow-builder.ts`

Converts step groups to BullMQ FlowProducer job structures.

### Job Data Types

Discriminated union via `type` field:

```typescript
interface WorkflowJobData {
    readonly type: 'workflow';
    readonly version: string;         // JOB_DATA_VERSION = '1'
    readonly flowId: string;
    readonly workflowData: unknown;
    readonly stepResults: Record<string, unknown>;
    readonly meta?: PropagationMeta;
}

interface StepJobData {
    readonly type: 'step';
    readonly version: string;         // JOB_DATA_VERSION = '1'
    readonly flowId: string;
    readonly stepName: string;
    readonly workflowData: unknown;
    readonly meta?: PropagationMeta;
}

type FlowJobData = WorkflowJobData | StepJobData;
```

### FlowJobDefinition

```typescript
interface FlowJobDefinition {
    readonly name: string;
    readonly queueName: string;
    readonly data: FlowJobData;
    readonly opts?: FlowJobOpts;
    readonly children?: FlowJobDefinition[];
}
```

### buildFlow() Algorithm

BullMQ flows use parent-child relationships where children run BEFORE their parent. To achieve execution order `A -> B -> C -> parent`:

```
BullMQ job tree:
    parent
      +-- step3 (child of parent, runs before parent)
            +-- step2 (child of step3, runs before step3)
                  +-- step1 (deepest child, runs first)
```

Build process:

1. Start with empty `childrenForNextGroup`
2. For each step group (in execution order):
   - **Sequential**: Chain steps as nested children. `step1` gets previous children, `step2` gets `[step1]`, `step3` gets `[step2]`, return `[step3]`
   - **Parallel**: Create a single synthetic `__parallel__:step1,step2` job wrapping the parallel step names, with previous children attached
3. Final children array attaches to the workflow parent job

### failParentOnFailure

All step jobs have `failParentOnFailure: true` in their options. When a step fails, BullMQ automatically cascades the failure up the job hierarchy to the parent workflow job.

### Idempotency Key Propagation

When an `idempotencyKey` is provided:

- Parent job: `jobId = idempotencyKey`
- Step jobs: `jobId = ${idempotencyKey}-step-${stepName}`
- Parallel group: `jobId = ${idempotencyKey}-step-__parallel__:${stepNames}`

This ensures the entire workflow tree is deduplicated. Hyphens are used as separators (not colons) because BullMQ uses colons as internal separators.

### Queue Names

| Type | Pattern | Example |
|------|---------|---------|
| Workflow | `${queuePrefix}.${workflowName}` | `workflow.OrderWorkflow` |
| Steps | `${queuePrefix}.${workflowName}.steps` | `workflow.OrderWorkflow.steps` |

### getParentJobId()

Returns the predictable job ID (`idempotencyKey ?? flowId`) **before** the job is added to BullMQ. This allows `pendingResults` to be registered before `flowProducer.add()` to prevent race conditions.

---

## 7. Workflow Result Utils

Source: `workflows/workflow-result-utils.ts`

Utilities for handling result wrapper types in distributed workflow execution.

### Wrapper Types

```typescript
const WRAPPER_VERSION = '1';

interface StepResultWrapper {
    readonly __version: string;
    readonly __stepName: string;
    readonly __stepResult: unknown;
    readonly __priorResults: Record<string, unknown>;
}

interface ParallelResultWrapper {
    readonly __version: string;
    readonly __parallelResults: Record<string, unknown>;
    readonly __priorResults: Record<string, unknown>;
}
```

`WRAPPER_VERSION` enables format evolution. If the wrapper format changes in a future version, consumers can detect and handle both formats during rolling upgrades.

### Type Guards

```typescript
function isStepResultWrapper(value: unknown): value is StepResultWrapper
function isParallelResultWrapper(value: unknown): value is ParallelResultWrapper
```

Both check for the presence of their respective discriminant fields (`__stepName`/`__stepResult` vs `__parallelResults`).

### flattenChildResults()

```typescript
function flattenChildResults(childResults: Record<string, unknown>): Record<string, unknown>
```

BullMQ's `job.getChildrenValues()` returns `{ "queue:jobId": returnvalue, ... }`. This function:

1. Iterates all child values
2. For `StepResultWrapper`: merges `__priorResults` (sanitized), then adds `__stepName: __stepResult` (sanitized)
3. For `ParallelResultWrapper`: merges `__priorResults` (sanitized), then merges `__parallelResults` (sanitized)
4. Returns flat `{ stepName: result, ... }` record

### Prototype Pollution Prevention

```typescript
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
```

All results are sanitized via `Json.sanitize()` before merging with `Object.assign()`. Step names that match dangerous keys are prefixed with `_sanitized_`:

```typescript
const stepName = DANGEROUS_KEYS.has(value.__stepName)
    ? `_sanitized_${value.__stepName}`
    : value.__stepName;
```
