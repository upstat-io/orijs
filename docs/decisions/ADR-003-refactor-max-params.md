# ADR-003: Refactor Functions with Too Many Parameters

## Status

Implemented

## Context

The oxlint `max-params` rule flagged 6 functions exceeding the 6-parameter limit. These functions pass workflow execution context through multiple layers, resulting in parameter bloat.

Additionally, `bullmq-workflow-provider.ts` exceeds the 500-line limit at 704 lines.

## Warnings

### 1. `handleWorkflowError` (9 params)

**File:** `packages/workflows/src/in-process-workflow-provider.ts:383`

```typescript
private async handleWorkflowError<TData, TResult>(
    workflow: WorkflowInstance<TData, TResult>,
    flowState: FlowState<TResult>,
    error: Error,
    flowId: string,
    workflowName: string,
    data: TData,
    results: Record<string, unknown>,
    meta: PropagationMeta,
    log: Logger
): Promise<void>
```

**Suggested refactor:** Create `WorkflowExecutionContext` object:

```typescript
interface WorkflowExecutionContext<TData> {
    flowId: string;
    workflowName: string;
    data: TData;
    results: Record<string, unknown>;
    meta: PropagationMeta;
    log: Logger;
}

private async handleWorkflowError<TData, TResult>(
    workflow: WorkflowInstance<TData, TResult>,
    flowState: FlowState<TResult>,
    error: Error,
    ctx: WorkflowExecutionContext<TData>
): Promise<void>
```

---

### 2. `executeStepGroup` (7 params)

**File:** `packages/workflows/src/in-process-workflow-provider.ts:416`

```typescript
private async executeStepGroup<TData>(
    group: StepGroup,
    flowId: string,
    workflowName: string,
    data: TData,
    state: { results: Record<string, unknown>; completedStepsWithRollback: Array<...> },
    meta: PropagationMeta,
    log: Logger
): Promise<WorkflowStepError | undefined>
```

**Suggested refactor:** Same `WorkflowExecutionContext` + pass `state` separately:

```typescript
private async executeStepGroup<TData>(
    group: StepGroup,
    ctx: WorkflowExecutionContext<TData>,
    state: StepExecutionState
): Promise<WorkflowStepError | undefined>
```

---

### 3. `executeSequentialGroup` (7 params)

**File:** `packages/workflows/src/in-process-workflow-provider.ts:437`

Same pattern as `executeStepGroup`. Use `WorkflowExecutionContext`.

---

### 4. `executeParallelGroup` (7 params)

**File:** `packages/workflows/src/in-process-workflow-provider.ts:474`

Same pattern as `executeStepGroup`. Use `WorkflowExecutionContext`.

---

### 5. `runRollbacks` (7 params)

**File:** `packages/workflows/src/in-process-workflow-provider.ts:589`

```typescript
private async runRollbacks<TData>(
    flowId: string,
    data: TData,
    results: Record<string, unknown>,
    completedStepsWithRollback: Array<{ name: string; rollback: RollbackHandler }>,
    meta: PropagationMeta,
    log: Logger,
    workflowName: string
): Promise<void>
```

**Suggested refactor:** Use `WorkflowExecutionContext` + rollback list:

```typescript
private async runRollbacks<TData>(
    ctx: WorkflowExecutionContext<TData>,
    completedStepsWithRollback: Array<{ name: string; rollback: RollbackHandler }>
): Promise<void>
```

---

### 6. `handleParallelFailure` (8 params)

**File:** `packages/bullmq/src/workflows/bullmq-workflow-provider.ts:766`

```typescript
private async handleParallelFailure(
    job: Job,
    workflowName: string,
    flowId: string,
    workflowData: unknown,
    outcomes: Array<{ name: string; result?: unknown; error?: Error }>,
    existingResults: Record<string, unknown>,
    failure: { name: string; error?: Error },
    meta?: PropagationMeta
): Promise<never>
```

**Suggested refactor:** Create `ParallelFailureContext`:

```typescript
interface ParallelFailureContext {
    workflowName: string;
    flowId: string;
    workflowData: unknown;
    outcomes: Array<{ name: string; result?: unknown; error?: Error }>;
    existingResults: Record<string, unknown>;
    failure: { name: string; error?: Error };
    meta?: PropagationMeta;
}

private async handleParallelFailure(
    job: Job,
    ctx: ParallelFailureContext
): Promise<never>
```

---

### 7. `bullmq-workflow-provider.ts` (704 lines)

**File:** `packages/bullmq/src/workflows/bullmq-workflow-provider.ts`

**Suggested refactor:** Extract into separate files:

1. **`flow-state-manager.ts`** - Local flow state tracking, cleanup scheduling
2. **`step-executor.ts`** - Step execution logic, parallel/sequential handlers
3. **`rollback-handler.ts`** - Rollback execution and error handling
4. **`bullmq-workflow-provider.ts`** - Main provider, job processing, public API

---

## Decision

Create a shared `WorkflowExecutionContext<TData>` type and refactor all workflow execution methods to use it. This:

1. Reduces parameter count from 7-9 to 2-3
2. Makes the "execution context" concept explicit
3. Simplifies adding new context fields in the future
4. Improves readability at call sites

For the BullMQ provider, extract cohesive responsibilities into separate files.

## Consequences

**Positive:**

- Cleaner function signatures
- Easier to extend context with new fields
- Better separation of concerns
- Improved testability (can mock context object)

**Negative:**

- One-time refactoring effort
- Need to update all call sites
- Slightly more indirection

## Implementation Plan

1. Define `WorkflowExecutionContext<TData>` interface in `workflow-types.ts`
2. Refactor `in-process-workflow-provider.ts` methods to use it
3. Define `ParallelFailureContext` for BullMQ provider
4. Refactor `bullmq-workflow-provider.ts` methods
5. Extract BullMQ provider into multiple files
6. Update tests
