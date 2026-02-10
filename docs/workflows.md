# @orijs/workflows - Technical Reference

Package: `packages/workflows/src/`

## Overview

`@orijs/workflows` provides multi-step workflow orchestration with sequential and parallel step execution, result accumulation, rollback support, and timeout handling. Like the event system, it uses Interface Segregation to separate consumer, framework, and implementation concerns.

---

## 1. WorkflowProvider Interface

Source: `workflow.types.ts`

### WorkflowExecutor (consumer interface)

What business services inject. Narrow interface prevents accidental lifecycle calls.

```typescript
interface WorkflowExecutor {
    execute<TData, TResult>(
        workflow: WorkflowDefinitionLike<TData, TResult>,
        data: TData
    ): Promise<FlowHandle<TResult>>;

    getStatus(flowId: string): Promise<FlowStatus>;
}
```

### WorkflowLifecycle (framework interface)

What the OriJS application manages during startup/shutdown. The `TOptions` generic allows provider-specific configuration (e.g., BullMQ concurrency, retry config).

```typescript
interface WorkflowLifecycle<TOptions = unknown> {
    registerDefinitionConsumer?(
        workflowName: string,
        handler: (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<unknown>,
        stepGroups?: readonly StepGroup[],
        stepHandlers?: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>,
        onError?: (data: unknown, meta?: unknown, error?: Error, stepResults?: Record<string, unknown>) => Promise<void>,
        options?: TOptions
    ): void;

    registerEmitterWorkflow?(workflowName: string): void;

    start(): Promise<void>;
    stop(): Promise<void>;
}
```

`registerDefinitionConsumer()` has two modes:

- **With stepGroups**: Provider registers step handlers, creates child jobs/tasks for each step, executes in order, then calls the handler (onComplete) after all steps complete
- **Without stepGroups**: Handler is called directly (simple workflow without steps)

`registerEmitterWorkflow()` tracks workflows that this instance can emit to without having a local consumer (for distributed deployments where consumer runs on a different instance).

### WorkflowProvider (full implementation)

```typescript
interface WorkflowProvider<TOptions = unknown> extends WorkflowExecutor, WorkflowLifecycle<TOptions> {}
```

### FlowHandle

```typescript
interface FlowHandle<TResult = unknown> {
    readonly id: string;
    status(): Promise<FlowStatus>;
    result(): Promise<TResult>;
}
```

Returned from `execute()`. The `result()` method returns a Promise that resolves when the workflow completes or rejects on failure/timeout.

### FlowStatus

```typescript
type FlowStatus =
    | 'pending'     // Created but not started
    | 'running'     // Currently executing steps
    | 'completed'   // All steps complete (or handled)
    | 'failed';     // Workflow failed (after onError handling)
```

Note: individual step failures do not automatically set the workflow to `'failed'`. The parent's `onError` handler decides whether to continue or fail.

---

## 2. InProcessWorkflowProvider

Source: `in-process-workflow-provider.ts`

Local synchronous workflow execution for development and testing.

### Configuration

```typescript
interface WorkflowProviderConfig {
    logger?: Logger;
    defaultTimeout?: number;        // Default: 30000 (30 seconds)
    parallelConcurrency?: number;   // Default: 10
}
```

The constructor accepts either a `WorkflowProviderConfig` or a `Logger` directly (backward compatibility). When a `Logger` is passed, defaults are used for timeout and concurrency.

### execute()

```typescript
async execute<TData, TResult>(
    workflow: WorkflowDefinitionLike<TData, TResult>,
    data: TData,
    timeout?: number
): Promise<FlowHandle<TResult>>
```

1. Validates provider is started (throws if not)
2. Validates workflow is registered in `definitionConsumers` map (throws if not)
3. Generates a flow ID: `flow-${Date.now()}-${random}`
4. Creates `FlowState` with `status: 'pending'`
5. Creates a result Promise via `new Promise()` with stored `resolve`/`reject`
6. Sets up timeout: `setTimeout` that rejects with `WorkflowTimeoutError` if workflow is still pending/running
7. Chains `.catch().finally()` on result promise to clear timeout
8. Starts `executeDefinitionWorkflowInternal()` asynchronously (does not await)
9. Returns `FlowHandle` immediately

### Sequential Group Execution

`executeDefinitionSequentialGroup()` iterates step definitions in order:

1. Looks up handler from `stepHandlers` map by step name
2. If not found: returns `WorkflowStepError` immediately
3. Creates `WorkflowContext` via `createWorkflowContext()`
4. Calls `executeDefinitionStepSafely()` which uses `Promise.resolve(handler(ctx)).catch()` to convert rejections to resolved marker values (avoiding double-await issues)
5. On success: adds result to `state.results` and rollback to `state.completedStepsWithRollback`
6. On failure: runs rollbacks, returns error

### Parallel Group Execution

`executeDefinitionParallelGroup()` executes steps concurrently with a configurable concurrency limit (default: 10).

The `executeWithConcurrencyLimit()` async pool implementation:

```
For each item:
  1. Create executor promise
  2. Wrap in self-removing promise, add to `executing` Set
  3. If executing.size >= limit: await Promise.race(executing)
After loop: await Promise.all(executing)
```

Results are collected with index-based ordering to preserve deterministic result positions.

After parallel execution:

1. Separates successful and failed steps
2. Adds successful results to `state.results`
3. Tracks rollbacks for successful steps
4. If any failure: runs all rollbacks and returns the first error

### Rollback Pattern

`runRollbacks()` executes rollback handlers in **LIFO order** (last completed first):

1. Reverses `completedStepsWithRollback` array
2. For each step with a rollback handler:
   - Creates a new `WorkflowContext` with step name suffixed `:rollback`
   - Executes the rollback handler
   - Logs duration
3. Rollback errors are **logged but do not stop other rollbacks** from running

### Timeout Handling

- Effective timeout: `timeout` parameter overrides `defaultTimeout`, 0 disables
- `WorkflowTimeoutError` is thrown (rejects the result promise)
- Currently executing step **continues** (no cancellation)
- Rollbacks are **NOT** triggered on timeout
- Timeout is cleared in `.finally()` when result promise settles

```typescript
class WorkflowTimeoutError extends Error {
    public readonly flowId: string;
    public readonly timeoutMs: number;
}
```

### Flow State Cleanup

Completed/failed flow states are cleaned up after `FLOW_CLEANUP_DELAY_MS` (5 minutes) via `setTimeout`. This prevents memory leaks while allowing time for status queries after completion. Cleanup timeouts are tracked in a separate Map and cleared on `stop()`.

---

## 3. WorkflowContext

Source: `workflow-context.ts`

Context passed to workflow step handlers.

### Interface

```typescript
interface WorkflowContext<TData = unknown> {
    readonly flowId: string;
    readonly data: TData;
    readonly results: Record<string, unknown>;
    readonly log: Logger;
    readonly meta: PropagationMeta;
    readonly correlationId: string;
    readonly providerId?: string;
}
```

### Result Accumulation

The `results` property accumulates results from all completed steps as `{ stepName: result, ... }`. Each step can access previous step results:

```typescript
const validation = ctx.results['validate'] as ValidationResult;
```

Results are accumulated mutably in `StepExecutionState.results` during execution but the context itself is frozen.

### DefaultWorkflowContext Class

```typescript
class DefaultWorkflowContext<TData = unknown> implements WorkflowContext<TData> {
    constructor(
        public readonly flowId: string,
        public readonly data: TData,
        public readonly results: Record<string, unknown>,
        public readonly log: Logger,
        public readonly meta: PropagationMeta,
        public readonly providerId?: string
    )
}
```

`correlationId` is extracted from `meta.correlationId`, falling back to `flowId` if not present.

### createWorkflowContext()

```typescript
function createWorkflowContext<TData>(
    flowId: string,
    data: TData,
    results: Record<string, unknown>,
    log: Logger,
    meta: PropagationMeta,
    options?: WorkflowContextOptions
): WorkflowContext<TData>
```

Behavior:

1. **Fail-fast validation**: Throws on invalid `flowId` (non-empty string), missing `log`, invalid `results` (must be plain object), invalid `meta` (must be plain object)
2. **Logger enrichment**: Adds `flowId`, `workflow`, `step`, and `providerId` to the logger via `log.with()`
3. Returns `Object.freeze(new DefaultWorkflowContext(...))` -- immutable context

### WorkflowContextOptions

```typescript
interface WorkflowContextOptions {
    workflowName?: string;   // For logging context
    stepName?: string;       // For logging context
    providerId?: string;     // For distributed tracing
}
```

---

## 4. Workflow Types

Source: `workflow.types.ts`

### WorkflowDefinitionLike

Structural type compatible with `WorkflowDefinition` from `@orijs/core` without requiring the import:

```typescript
interface WorkflowDefinitionLike<TData = unknown, TResult = unknown> {
    readonly name: string;
    readonly stepGroups: readonly StepGroup[];
    readonly _data: TData;       // Phantom type for TData inference
    readonly _result: TResult;   // Phantom type for TResult inference
}
```

### StepGroup

```typescript
interface StepGroup {
    readonly type: 'sequential' | 'parallel';
    readonly definitions: readonly StepDefinitionBase[];
}
```

### StepDefinitionBase

```typescript
interface StepDefinitionBase {
    readonly name: string;  // Unique within workflow
}
```

### StepHandler and RollbackHandler

```typescript
type StepHandler<TData = unknown, TResult = unknown> = (
    ctx: WorkflowContext<TData>
) => Promise<TResult> | TResult;

type RollbackHandler<TData = unknown> = (
    ctx: WorkflowContext<TData>
) => Promise<void> | void;
```

Rollback handlers **must be idempotent**. In distributed systems with retries, a rollback may be called multiple times for the same workflow execution.

### StepOptions

```typescript
interface StepOptions<TData = unknown, TResult = unknown> {
    execute: StepHandler<TData, TResult>;
    rollback?: RollbackHandler<TData>;
}
```

### WorkflowStepError

```typescript
class WorkflowStepError extends Error {
    public readonly stepName: string;
    public override readonly cause: Error;

    constructor(stepName: string, originalError: Error)
}
```

The `stack` property is augmented with `\n\nCaused by: ${originalError.stack}` for debugging.

### StepExecutionContext (internal)

```typescript
interface StepExecutionContext<TData = unknown> {
    readonly flowId: string;
    readonly workflowName: string;
    readonly data: TData;
    readonly results: Record<string, unknown>;
    readonly meta: PropagationMeta;
    readonly log: Logger;
}
```

Consolidates parameters needed by step execution methods, reducing parameter count.

### StepExecutionState (internal)

```typescript
interface StepExecutionState {
    results: Record<string, unknown>;
    completedStepsWithRollback: Array<{ name: string; rollback: RollbackHandler }>;
}
```

Separated from `StepExecutionContext` because this state mutates as steps complete.

---

## 5. Distributed Design Constraints

These constraints apply to all workflow provider implementations and must be honored by user code:

1. **Workflow data (`TData`) must be JSON-serializable**: No functions, no circular references, no class instances with methods. The data is serialized into job payloads for transport.

2. **Step handlers must be stateless**: No `this` references to instance state. In distributed deployments, different instances may execute different steps of the same workflow.

3. **Step results must be JSON-serializable**: Step results are stored in BullMQ job return values and retrieved via `job.getChildrenValues()`. Functions, symbols, and circular references will be lost.

4. **PropagationMeta is serialized into job data**: The `meta` object containing correlation IDs, trace IDs, etc. is included in the job payload for context propagation across process boundaries.

5. **Workflows are registered by name**: The `WorkflowDefinitionLike.name` is used as the key for distributed lookup. Worker instances use this name to find the correct handler when processing jobs from the queue.
