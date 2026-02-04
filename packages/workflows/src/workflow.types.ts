/**
 * Workflow Types - Core interfaces for the workflow system.
 *
 * Follows interface segregation pattern:
 * - WorkflowExecutor: For business code (services inject this)
 * - WorkflowLifecycle: For framework (startup/shutdown)
 * - WorkflowProvider: Full implementation (combines both)
 *
 * Design decisions:
 * - WorkflowRegistry with type accumulation (like EventRegistry)
 * - Error handling: continue on failure, parent handles
 * - Step results accumulated: { step1: result1, step2: result2 }
 * - No cancellation support (initial version)
 *
 * Distributed Provider Requirements:
 * When implementing distributed workflows, ensure:
 * - Workflow data (TData) must be JSON-serializable
 * - Step handlers must be stateless (no `this` references to instance state)
 * - Step results must be JSON-serializable (no functions, no circular refs)
 * - PropagationMeta will be serialized into job data for context propagation
 * - Workflow class must be registered by name for job processor lookup
 *
 * @module workflows/workflow.types
 */

import type { WorkflowContext } from './workflow-context';

// --- WORKFLOW DEFINITION TYPE ---

/**
 * Minimal structural type for workflow definitions.
 *
 * This is compatible with WorkflowDefinition from @orijs/core but doesn't
 * require importing it, keeping @orijs/workflows standalone.
 *
 * Use with Workflow.define() from @orijs/core:
 * ```ts
 * const OrderWorkflow = Workflow.define({
 *   name: 'process-order',
 *   data: Type.Object({ orderId: Type.String() }),
 *   result: Type.Object({ success: Type.Boolean() })
 * });
 * ```
 */
export interface WorkflowDefinitionLike<TData = unknown, TResult = unknown> {
	readonly name: string;
	readonly stepGroups: readonly StepGroup[];
	readonly _data: TData;
	readonly _result: TResult;
}

// --- EXECUTOR INTERFACE (Business Code) ---

/**
 * Workflow executor interface (business code injects this).
 *
 * Services that need to start workflows inject this narrow interface,
 * not the full provider. This prevents business code from accidentally
 * calling lifecycle methods.
 *
 * @example
 * ```ts
 * const OrderWorkflow = Workflow.define({
 *   name: 'process-order',
 *   data: Type.Object({ orderId: Type.String() }),
 *   result: Type.Object({ success: Type.Boolean() })
 * });
 *
 * class OrderService {
 *   constructor(private workflows: WorkflowExecutor) {}
 *
 *   async onOrderPlaced(orderId: string) {
 *     await this.workflows.execute(OrderWorkflow, { orderId });
 *   }
 * }
 * ```
 */
export interface WorkflowExecutor {
	/**
	 * Execute a workflow with input data.
	 *
	 * @template TData - Input data type for the workflow
	 * @template TResult - Result type from onComplete
	 * @param workflow - The workflow definition to execute
	 * @param data - Input data for the workflow
	 * @returns FlowHandle for status checking and result retrieval
	 */
	execute<TData, TResult>(
		workflow: WorkflowDefinitionLike<TData, TResult>,
		data: TData
	): Promise<FlowHandle<TResult>>;

	/**
	 * Get status of a running workflow.
	 *
	 * @param flowId - The unique flow ID
	 * @returns Current flow status
	 */
	getStatus(flowId: string): Promise<FlowStatus>;
}

// --- LIFECYCLE INTERFACE (Framework) ---

/**
 * Workflow lifecycle interface (framework manages this).
 *
 * Used by Application to manage workflow provider lifecycle.
 * Not injected into business services.
 *
 * @template TOptions - Provider-specific options type for workflow configuration
 *
 * @example
 * ```ts
 * // Distributed provider with typed options
 * interface DistributedWorkflowOptions {
 *   concurrency?: number;
 *   retries?: number;
 * }
 *
 * class DistributedWorkflowProvider implements WorkflowLifecycle<DistributedWorkflowOptions> {
 *   registerDefinitionConsumer(
 *     workflowName: string,
 *     handler: (data, meta, stepResults) => Promise<unknown>,
 *     stepGroups?: readonly StepGroup[],
 *     stepHandlers?: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>,
 *     options?: DistributedWorkflowOptions
 *   ) {
 *     // Use options.concurrency for worker config
 *   }
 * }
 * ```
 */
export interface WorkflowLifecycle<TOptions = unknown> {
	/**
	 * Register a definition-based consumer with the provider.
	 *
	 * This is the new API for registering workflow consumers using WorkflowDefinition
	 * and a handler callback. The handler is invoked when jobs arrive.
	 *
	 * When stepGroups is provided and non-empty, the provider will:
	 * 1. Register step handlers from stepHandlers
	 * 2. Create child jobs/tasks for each step
	 * 3. Execute steps in order (sequential/parallel)
	 * 4. Call the handler (onComplete) only after all steps complete
	 *
	 * When stepGroups is empty or not provided, the handler is called directly.
	 *
	 * @param workflowName - Name of the workflow (from definition.name)
	 * @param handler - Callback to invoke when workflow completes (after steps if any).
	 *                  Receives workflow data, propagation meta, and accumulated step results.
	 * @param stepGroups - Optional step groups defining step structure (from definition.stepGroups)
	 * @param stepHandlers - Optional step handlers from consumer.steps (execute + rollback)
	 * @param onError - Optional error handler called when a step fails
	 * @param options - Optional provider-specific options
	 */
	registerDefinitionConsumer?(
		workflowName: string,
		handler: (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<unknown>,
		stepGroups?: readonly StepGroup[],
		stepHandlers?: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>,
		onError?: (
			data: unknown,
			meta?: unknown,
			error?: Error,
			stepResults?: Record<string, unknown>
		) => Promise<void>,
		options?: TOptions
	): void;

	/**
	 * Register a workflow definition for emitting only (no local consumer).
	 * Used to track which workflows this instance can emit to.
	 *
	 * @param workflowName - Name of the workflow (from definition.name)
	 */
	registerEmitterWorkflow?(workflowName: string): void;

	/**
	 * Start the workflow provider (connect to transport).
	 */
	start(): Promise<void>;

	/**
	 * Stop the workflow provider (disconnect from transport).
	 */
	stop(): Promise<void>;
}

// --- PROVIDER INTERFACE (Full Implementation) ---

/**
 * Full workflow provider interface (combines both).
 *
 * Provider implementations (InProcess, distributed) implement this.
 * Application receives this, but injects only WorkflowExecutor to services.
 *
 * @template TOptions - Provider-specific options type for workflow configuration
 *
 * @example
 * ```ts
 * // Type-safe provider with options
 * const provider: WorkflowProvider<MyProviderOptions> = new MyWorkflowProvider(config);
 * provider.registerDefinitionConsumer('my-workflow', handler, stepGroups, stepHandlers, { concurrency: 5 });
 * ```
 */
export interface WorkflowProvider<TOptions = unknown> extends WorkflowExecutor, WorkflowLifecycle<TOptions> {}

// --- FLOW HANDLE & STATUS ---

/**
 * Handle for tracking workflow execution.
 *
 * Returned from execute() to allow callers to:
 * - Track workflow status
 * - Wait for and retrieve results
 *
 * @template TResult - The result type from onComplete
 */
export interface FlowHandle<TResult = unknown> {
	/** Unique flow ID */
	readonly id: string;

	/** Get current status */
	status(): Promise<FlowStatus>;

	/** Wait for completion and get result */
	result(): Promise<TResult>;
}

/**
 * Workflow execution status.
 *
 * Note on 'failed': Per Q3 decision, individual step failures
 * don't automatically fail the workflow. The parent's onError
 * handler decides whether to continue or fail.
 */
export type FlowStatus =
	| 'pending' // Created but not started
	| 'running' // Currently executing steps
	| 'completed' // All steps complete (or handled)
	| 'failed'; // Workflow failed (after onError handling)

// --- STEP TYPES ---

/**
 * Step handler function type.
 *
 * @template TData - Workflow input data type
 * @template TResult - Step result type
 */
export type StepHandler<TData = unknown, TResult = unknown> = (
	ctx: WorkflowContext<TData>
) => Promise<TResult> | TResult;

/**
 * Rollback handler function type.
 *
 * Called when a later step fails to undo the work done by this step.
 * Receives the same context as the original step handler.
 *
 * **IMPORTANT: Rollback handlers MUST be idempotent.**
 *
 * In distributed systems with retries, a rollback handler may be called
 * multiple times for the same workflow execution. Your rollback logic
 * must handle this safely - running it twice should have the same effect
 * as running it once.
 *
 * @example
 * ```ts
 * // GOOD: Idempotent rollback - uses unique identifier
 * async function refundPayment(ctx: WorkflowContext<OrderData>) {
 *   const { chargeId } = ctx.getResult('charge');
 *   await paymentService.refund(chargeId); // Refund API is idempotent by chargeId
 * }
 *
 * // BAD: Non-idempotent rollback - creates duplicate refunds
 * async function refundPayment(ctx: WorkflowContext<OrderData>) {
 *   await paymentService.createRefund(ctx.data.amount); // New refund each time!
 * }
 * ```
 *
 * @template TData - Workflow input data type
 */
export type RollbackHandler<TData = unknown> = (ctx: WorkflowContext<TData>) => Promise<void> | void;

/**
 * Step options for the object form of step().
 *
 * Used when a step needs a rollback handler:
 * ```ts
 * builder.step('charge', { execute: chargePayment, rollback: refundPayment })
 * ```
 *
 * @template TData - Workflow input data type
 * @template TResult - Step result type
 */
export interface StepOptions<TData = unknown, TResult = unknown> {
	/** The main step handler to execute */
	execute: StepHandler<TData, TResult>;
	/** Optional rollback handler called if a later step fails */
	rollback?: RollbackHandler<TData>;
}

/**
 * Step definition - contains the step name for structure.
 *
 * Used by StepGroup in workflow definitions created via Workflow.define().steps().
 * Handlers are provided separately to registerDefinitionConsumer().
 */
export interface StepDefinitionBase {
	/** Step name (unique within workflow) */
	readonly name: string;
}

// --- STEP GROUP ---

/**
 * Step group - represents a sequential or parallel group of steps.
 *
 * Used in workflow definitions created via Workflow.define().steps().
 * Handlers are provided separately to registerDefinitionConsumer().
 */
export interface StepGroup {
	readonly type: 'sequential' | 'parallel';
	readonly definitions: readonly StepDefinitionBase[];
}

// --- EXECUTION CONTEXT (Internal) ---

/**
 * Execution context passed through workflow step execution.
 *
 * Consolidates the common parameters needed by step execution methods,
 * reducing parameter count from 7+ to a single context object.
 *
 * @template TData - Workflow input data type
 * @internal
 */
export interface StepExecutionContext<TData = unknown> {
	/** Unique flow ID */
	readonly flowId: string;
	/** Name of the workflow being executed */
	readonly workflowName: string;
	/** Input data for the workflow */
	readonly data: TData;
	/** Accumulated results from completed steps */
	readonly results: Record<string, unknown>;
	/** Propagation metadata for distributed tracing */
	readonly meta: import('@orijs/logging').PropagationMeta;
	/** Logger instance with workflow context */
	readonly log: import('@orijs/logging').Logger;
}

/**
 * Mutable state tracked during step execution.
 *
 * Separated from StepExecutionContext because this state
 * changes as steps complete (results accumulate, rollbacks queue).
 *
 * @internal
 */
export interface StepExecutionState {
	/** Accumulated results from completed steps (mutated as steps complete) */
	results: Record<string, unknown>;
	/** Steps that completed with rollback handlers (for failure recovery) */
	completedStepsWithRollback: Array<{ name: string; rollback: RollbackHandler }>;
}

// --- ERROR TYPES ---

/**
 * Error thrown when a workflow step fails.
 *
 * Includes the step name for debugging and error handling.
 * The original error is preserved as the cause.
 *
 * @example
 * ```ts
 * workflow.onError = async (ctx, error) => {
 *   if (error instanceof WorkflowStepError) {
 *     console.log(`Step '${error.stepName}' failed: ${error.message}`);
 *     // Access original error
 *     console.log('Original error:', error.cause);
 *   }
 * };
 * ```
 */
export class WorkflowStepError extends Error {
	public readonly stepName: string;
	public override readonly cause: Error;

	public constructor(stepName: string, originalError: Error) {
		super(`Step '${stepName}' failed: ${originalError.message}`);
		this.name = 'WorkflowStepError';
		this.stepName = stepName;
		this.cause = originalError;

		// Preserve original stack trace for debugging
		if (originalError.stack) {
			this.stack = `${this.stack}\n\nCaused by: ${originalError.stack}`;
		}
	}
}
