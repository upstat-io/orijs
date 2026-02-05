/**
 * In-Process Workflow Provider - Local synchronous workflow execution.
 *
 * Executes workflows synchronously within the same process.
 * Ideal for development and testing where distributed queues
 * aren't needed.
 *
 * Design:
 * - Step errors flow to onError handler; workflow continues unless re-thrown
 * - Results accumulate as { step1: result1, step2: result2 }
 * - Definition-based API via registerDefinitionConsumer()
 * - No cancellation support in initial version
 *
 * @module workflows/in-process-workflow-provider
 */

import {
	WorkflowStepError,
	type WorkflowProvider,
	type WorkflowDefinitionLike,
	type FlowHandle,
	type FlowStatus,
	type StepGroup,
	type StepDefinitionBase,
	type StepHandler,
	type RollbackHandler,
	type StepExecutionContext,
	type StepExecutionState
} from './workflow.types';
import { createWorkflowContext, type WorkflowContext } from './workflow-context';
import { Logger, type PropagationMeta, capturePropagationMeta } from '@orijs/logging';

/**
 * Configuration options for InProcessWorkflowProvider.
 */
export interface WorkflowProviderConfig {
	/**
	 * Optional logger with inherited context (correlationId, accountUuid, etc.).
	 * If not provided, creates a default logger without context propagation.
	 */
	logger?: Logger;

	/**
	 * Default timeout for workflow execution in milliseconds.
	 *
	 * **Behavior when timeout is reached:**
	 * - Workflow status changes to 'failed'
	 * - WorkflowTimeoutError is thrown (rejects the result promise)
	 * - Currently executing step continues (no cancellation)
	 * - Rollbacks are NOT triggered on timeout
	 *
	 * **Best practices:**
	 * - Set timeout based on expected workflow duration + buffer
	 * - Use per-execution timeout override for long-running workflows
	 * - Monitor timeout errors to tune default value
	 *
	 * Set to 0 to disable timeout (not recommended for production).
	 * @default 30000 (30 seconds)
	 */
	defaultTimeout?: number;

	/**
	 * Maximum number of parallel steps to execute concurrently.
	 * When a parallel group has more steps than this limit, steps are
	 * executed in batches to prevent resource exhaustion.
	 * Default: 10
	 */
	parallelConcurrency?: number;
}

/**
 * Error thrown when a workflow exceeds its execution timeout.
 */
export class WorkflowTimeoutError extends Error {
	public readonly flowId: string;
	public readonly timeoutMs: number;

	public constructor(flowId: string, timeoutMs: number) {
		super(`Workflow '${flowId}' timed out after ${timeoutMs}ms`);
		this.name = 'WorkflowTimeoutError';
		this.flowId = flowId;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Cleanup delay for completed/failed flows (5 minutes).
 * Allows time for status queries after completion while preventing memory leaks.
 */
const FLOW_CLEANUP_DELAY_MS = 5 * 60 * 1000;

/**
 * Internal flow state for tracking execution.
 */
interface FlowState<TResult> {
	readonly id: string;
	status: FlowStatus;
	result?: TResult;
	error?: Error;
	resolve?: (value: TResult) => void;
	reject?: (error: Error) => void;
}

/**
 * Creates a unique flow ID.
 */
function generateFlowId(): string {
	return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * In-process workflow provider for local execution.
 *
 * Workflows are executed synchronously within the same process.
 * Steps run in order (sequential or parallel), and results
 * accumulate for subsequent steps to access.
 *
 * @example
 * ```ts
 * const OrderWorkflow = Workflow.define({
 *   name: 'process-order',
 *   data: Type.Object({ orderId: Type.String(), amount: Type.Number() }),
 *   result: Type.Object({ success: Type.Boolean() })
 * });
 *
 * const provider = new InProcessWorkflowProvider();
 *
 * // Register consumer
 * provider.registerDefinitionConsumer(
 *   OrderWorkflow.name,
 *   async (data, meta, stepResults) => ({ success: true }),
 *   OrderWorkflow.stepGroups,
 *   stepHandlers
 * );
 *
 * await provider.start();
 *
 * // Execute workflow
 * const handle = await provider.execute(OrderWorkflow, {
 *   orderId: 'ORD-001',
 *   amount: 99.99
 * });
 *
 * // Wait for result
 * const result = await handle.result();
 * console.log('Order processed:', result);
 * ```
 */
/**
 * Registered definition-based consumer configuration.
 */
interface DefinitionConsumerConfig {
	handler: (data: unknown, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<unknown>;
	stepGroups: readonly StepGroup[];
	stepHandlers: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>;
	onError?: (
		data: unknown,
		meta?: unknown,
		error?: Error,
		stepResults?: Record<string, unknown>
	) => Promise<void>;
}

export class InProcessWorkflowProvider implements WorkflowProvider {
	private readonly definitionConsumers: Map<string, DefinitionConsumerConfig> = new Map();
	private readonly flowStates: Map<string, FlowState<unknown>> = new Map();
	private readonly cleanupTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private readonly log: Logger;
	private readonly defaultTimeout: number;
	private readonly parallelConcurrency: number;
	private started = false;

	/**
	 * Creates a new InProcessWorkflowProvider.
	 *
	 * @param configOrLogger - Configuration object or Logger for backwards compatibility.
	 *                         If Logger is passed, uses default timeout (30s).
	 *                         If config is passed, uses config.logger and config.defaultTimeout.
	 */
	public constructor(configOrLogger?: WorkflowProviderConfig | Logger) {
		// Support backwards compatibility: accept Logger directly or config object
		if (configOrLogger instanceof Logger) {
			this.log = configOrLogger;
			this.defaultTimeout = 30000; // 30 seconds default
			this.parallelConcurrency = 10; // default concurrency limit
		} else {
			const config = configOrLogger ?? {};
			this.log = config.logger ?? new Logger('WorkflowProvider');
			this.defaultTimeout = config.defaultTimeout ?? 30000; // 30 seconds default
			this.parallelConcurrency = config.parallelConcurrency ?? 10; // default concurrency limit
		}
	}

	/**
	 * Execute a workflow with input data.
	 *
	 * Returns a FlowHandle immediately without waiting for completion.
	 * Use handle.result() to await the workflow result.
	 *
	 * @template TData - Input data type for the workflow
	 * @template TResult - Result type from onComplete
	 * @param workflow - The workflow definition to execute
	 * @param data - Input data for the workflow
	 * @param timeout - Optional timeout override in milliseconds (0 to disable)
	 * @returns FlowHandle for status checking and result retrieval
	 * @throws {Error} If provider not started (call start() first)
	 * @throws {Error} If workflow not registered
	 */
	public async execute<TData, TResult>(
		workflow: WorkflowDefinitionLike<TData, TResult>,
		data: TData,
		timeout?: number
	): Promise<FlowHandle<TResult>> {
		if (!this.started) {
			throw new Error('Provider not started. Call start() before execute().');
		}

		const workflowName = workflow.name;
		if (!this.definitionConsumers.has(workflowName)) {
			throw new Error(
				`Workflow '${workflowName}' not registered. ` + `Call registerDefinitionConsumer() first.`
			);
		}
		return this.executeDefinitionWorkflow(workflowName, data, timeout);
	}

	/**
	 * Get status of a workflow.
	 *
	 * @param flowId - The unique flow ID
	 * @returns Current flow status (returns 'pending' for unknown flows)
	 */
	public async getStatus(flowId: string): Promise<FlowStatus> {
		const state = this.flowStates.get(flowId);
		return state?.status ?? 'pending';
	}

	/**
	 * Register a definition-based consumer with the provider.
	 *
	 * This is the new API for registering workflow consumers using WorkflowDefinition
	 * and a handler callback. The handler is invoked when jobs arrive.
	 *
	 * @param workflowName - Name of the workflow (from definition.name)
	 * @param handler - Callback to invoke when workflow completes (after steps if any)
	 * @param stepGroups - Optional step groups defining step structure
	 * @param stepHandlers - Optional step handlers (execute + rollback)
	 * @param onError - Optional error handler called when a step fails
	 * @param _options - Optional provider-specific options (ignored by InProcess provider)
	 */
	public registerDefinitionConsumer(
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
		_options?: unknown
	): void {
		this.definitionConsumers.set(workflowName, {
			handler,
			stepGroups: stepGroups ?? [],
			stepHandlers: stepHandlers ?? {},
			onError
		});
	}

	/**
	 * Start the workflow provider.
	 */
	public async start(): Promise<void> {
		this.started = true;
	}

	/**
	 * Stop the workflow provider.
	 * Clears all pending cleanup timeouts to prevent memory leaks.
	 */
	public async stop(): Promise<void> {
		this.started = false;

		// Clear pending cleanup timeouts
		for (const timeout of this.cleanupTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.cleanupTimeouts.clear();
		this.flowStates.clear();
	}

	/**
	 * Returns whether the provider has been started.
	 */
	public isStarted(): boolean {
		return this.started;
	}

	/**
	 * Execute items with a concurrency limit using async pool pattern.
	 *
	 * Unlike Promise.all which starts all promises immediately, this executes
	 * at most `limit` items concurrently, starting new ones as others complete.
	 */
	private async executeWithConcurrencyLimit<TItem, TResult>(
		items: readonly TItem[],
		executor: (item: TItem) => Promise<TResult>,
		limit: number
	): Promise<TResult[]> {
		const results: TResult[] = [];
		const executing: Set<Promise<void>> = new Set();

		for (const [index, item] of items.entries()) {
			// Create wrapped promise that removes itself when done
			const promise = executor(item).then((result) => {
				results[index] = result;
			});

			const wrapped = promise.then(() => {
				executing.delete(wrapped);
			});
			executing.add(wrapped);

			// When at limit, wait for one to complete before starting next
			if (executing.size >= limit) {
				await Promise.race(executing);
			}
		}

		// Wait for remaining executions to complete
		await Promise.all(executing);

		return results;
	}

	/**
	 * Run rollback handlers for completed steps in reverse order.
	 *
	 * Rollback errors are logged but don't stop other rollbacks from running.
	 */
	private async runRollbacks<TData>(
		ctx: StepExecutionContext<TData>,
		completedStepsWithRollback: Array<{ name: string; rollback: RollbackHandler }>
	): Promise<void> {
		// Run rollbacks in reverse order (last completed first)
		const stepsToRollback = [...completedStepsWithRollback].reverse();

		for (const step of stepsToRollback) {
			const rollbackCtx = createWorkflowContext(ctx.flowId, ctx.data, ctx.results, ctx.log, ctx.meta, {
				workflowName: ctx.workflowName,
				stepName: `${step.name}:rollback`
			});

			const startTime = performance.now();
			try {
				await step.rollback(rollbackCtx);
				const durationMs = Math.round(performance.now() - startTime);
				rollbackCtx.log.info('Rollback Completed', { step: step.name, durationMs });
			} catch (rollbackError) {
				const durationMs = Math.round(performance.now() - startTime);
				// Log error but continue with other rollbacks
				rollbackCtx.log.error('Rollback Failed', {
					step: step.name,
					durationMs,
					error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				});
			}
		}
	}

	/**
	 * Schedules cleanup of a flow state after a delay.
	 * Allows time for status queries after completion while preventing memory leaks.
	 */
	private scheduleCleanup(flowId: string): void {
		// Clear any existing timeout for this flow
		const existingTimeout = this.cleanupTimeouts.get(flowId);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		// Schedule new cleanup
		const timeout = setTimeout(() => {
			this.flowStates.delete(flowId);
			this.cleanupTimeouts.delete(flowId);
		}, FLOW_CLEANUP_DELAY_MS);

		this.cleanupTimeouts.set(flowId, timeout);
	}

	/**
	 * Execute a definition-based workflow with input data.
	 */
	private async executeDefinitionWorkflow<TData, TResult>(
		workflowName: string,
		data: TData,
		timeout?: number
	): Promise<FlowHandle<TResult>> {
		const flowId = generateFlowId();
		const flowState: FlowState<TResult> = {
			id: flowId,
			status: 'pending'
		};
		this.flowStates.set(flowId, flowState as FlowState<unknown>);

		// Create result promise that will resolve/reject when workflow completes
		const resultPromise = new Promise<TResult>((resolve, reject) => {
			flowState.resolve = resolve;
			flowState.reject = reject;
		});

		// Determine effective timeout (parameter overrides default, 0 disables)
		const effectiveTimeout = timeout !== undefined ? timeout : this.defaultTimeout;

		// Set up timeout if enabled
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		if (effectiveTimeout > 0) {
			timeoutHandle = setTimeout(() => {
				// Only timeout if workflow hasn't completed yet
				if (flowState.status === 'pending' || flowState.status === 'running') {
					const timeoutError = new WorkflowTimeoutError(flowId, effectiveTimeout);
					flowState.status = 'failed';
					flowState.error = timeoutError;
					if (flowState.reject) {
						flowState.reject(timeoutError);
					}
				}
			}, effectiveTimeout);
		}

		// IMPORTANT: Use chained .catch().finally() - NOT parallel handlers.
		resultPromise
			.catch(() => {})
			.finally(() => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
			});

		// Start workflow execution asynchronously (don't await)
		this.executeDefinitionWorkflowInternal(workflowName, data, flowId, flowState).catch((error) => {
			// Ensure errors are propagated to resultPromise
			if (flowState.reject) {
				flowState.reject(error);
			}
		});

		// Return handle immediately - caller uses handle.result() to await completion
		return {
			id: flowId,
			status: async () => {
				const state = this.flowStates.get(flowId);
				return state?.status ?? 'pending';
			},
			result: async () => resultPromise
		};
	}

	/**
	 * Internal execution of definition-based workflow steps and handler.
	 */
	private async executeDefinitionWorkflowInternal<TData, TResult>(
		workflowName: string,
		data: TData,
		flowId: string,
		flowState: FlowState<TResult>
	): Promise<void> {
		const config = this.definitionConsumers.get(workflowName)!;
		const { handler, stepGroups, stepHandlers } = config;

		// Capture propagation metadata from the calling context (AsyncLocalStorage)
		const capturedMeta = capturePropagationMeta();
		const meta: PropagationMeta = capturedMeta ?? {};
		const state = {
			results: {} as Record<string, unknown>,
			completedStepsWithRollback: [] as Array<{ name: string; rollback: RollbackHandler }>
		};

		// Create workflow-scoped logger with propagated context from caller
		const baseLog = capturedMeta ? Logger.fromMeta(workflowName, capturedMeta) : this.log.child(workflowName);
		const workflowLog = baseLog.with({ flowId });
		const workflowStartTime = performance.now();

		flowState.status = 'running';
		workflowLog.info('Workflow Started');

		// Create execution context for step methods
		const execCtx: StepExecutionContext<TData> = {
			flowId,
			workflowName,
			data,
			results: state.results,
			meta,
			log: baseLog
		};

		// Execute each step group in order
		for (const group of stepGroups) {
			// Update context with latest results before each group
			const currentCtx: StepExecutionContext<TData> = { ...execCtx, results: state.results };
			const stepError = await this.executeDefinitionStepGroup(group, currentCtx, state, stepHandlers);
			if (stepError) {
				const durationMs = Math.round(performance.now() - workflowStartTime);
				workflowLog.error('Workflow Failed', {
					durationMs,
					step: stepError.stepName,
					error: stepError.message
				});

				// Call onError handler if provided
				if (config.onError) {
					await config.onError(data, meta, stepError, state.results);
				}

				// Handle step error
				flowState.status = 'failed';
				flowState.error = stepError;
				if (flowState.reject) {
					flowState.reject(stepError);
				}
				this.scheduleCleanup(flowId);
				return;
			}
		}

		// All steps completed successfully - call handler (onComplete equivalent)
		const totalDurationMs = Math.round(performance.now() - workflowStartTime);

		flowState.status = 'completed';

		let result: TResult;
		try {
			result = (await handler(data, meta, state.results)) as TResult;
		} catch (handlerError) {
			flowState.status = 'failed';
			const error = handlerError instanceof Error ? handlerError : new Error(String(handlerError));
			flowState.error = error;
			if (flowState.reject) {
				flowState.reject(error);
			}
			this.scheduleCleanup(flowId);
			return;
		}

		workflowLog.info('Workflow Completed', {
			durationMs: totalDurationMs,
			steps: Object.keys(state.results).length
		});

		flowState.result = result;
		if (flowState.resolve) {
			flowState.resolve(result);
		}
		this.scheduleCleanup(flowId);
	}

	/**
	 * Execute a definition-based step group (sequential or parallel).
	 */
	private async executeDefinitionStepGroup<TData>(
		group: StepGroup,
		ctx: StepExecutionContext<TData>,
		state: StepExecutionState,
		stepHandlers: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>
	): Promise<WorkflowStepError | undefined> {
		if (group.type === 'sequential') {
			return this.executeDefinitionSequentialGroup(group.definitions, ctx, state, stepHandlers);
		} else {
			return this.executeDefinitionParallelGroup(group.definitions, ctx, state, stepHandlers);
		}
	}

	/**
	 * Execute definition-based steps sequentially.
	 */
	private async executeDefinitionSequentialGroup<TData>(
		definitions: readonly StepDefinitionBase[],
		ctx: StepExecutionContext<TData>,
		state: StepExecutionState,
		stepHandlers: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>
	): Promise<WorkflowStepError | undefined> {
		for (const stepDef of definitions) {
			const handler = stepHandlers[stepDef.name];
			if (!handler) {
				return new WorkflowStepError(
					stepDef.name,
					new Error(`No handler registered for step '${stepDef.name}'`)
				);
			}

			const stepCtx = createWorkflowContext(ctx.flowId, ctx.data, state.results, ctx.log, ctx.meta, {
				workflowName: ctx.workflowName,
				stepName: stepDef.name
			});

			const stepError = await this.executeDefinitionStepSafely(stepDef.name, handler.execute, stepCtx, state);

			if (stepError) {
				// Use current results for rollback context
				const rollbackCtx: StepExecutionContext<TData> = { ...ctx, results: state.results };
				await this.runRollbacks(rollbackCtx, state.completedStepsWithRollback);
				return stepError;
			}

			if (handler.rollback) {
				state.completedStepsWithRollback.push({
					name: stepDef.name,
					rollback: handler.rollback
				});
			}
		}
		return undefined;
	}

	/**
	 * Execute definition-based steps in parallel.
	 */
	private async executeDefinitionParallelGroup<TData>(
		definitions: readonly StepDefinitionBase[],
		ctx: StepExecutionContext<TData>,
		state: StepExecutionState,
		stepHandlers: Record<string, { execute: StepHandler; rollback?: RollbackHandler }>
	): Promise<WorkflowStepError | undefined> {
		type StepSuccess = { name: string; result: unknown; durationMs: number; rollback?: RollbackHandler };
		type StepFailure = { name: string; error: Error; durationMs: number };
		type StepOutcome = StepSuccess | StepFailure;

		// Factory function to execute a single step
		const executeStep = async (stepDef: StepDefinitionBase): Promise<StepOutcome> => {
			const handler = stepHandlers[stepDef.name];
			if (!handler) {
				return {
					name: stepDef.name,
					error: new Error(`No handler for step '${stepDef.name}'`),
					durationMs: 0
				};
			}

			const stepCtx = createWorkflowContext(ctx.flowId, ctx.data, state.results, ctx.log, ctx.meta, {
				workflowName: ctx.workflowName,
				stepName: stepDef.name
			});
			const startTime = performance.now();
			try {
				const stepResult = await handler.execute(stepCtx);
				const durationMs = Math.round(performance.now() - startTime);
				stepCtx.log.debug('Step Completed', { durationMs });
				return {
					name: stepDef.name,
					result: stepResult,
					durationMs,
					rollback: handler.rollback
				} as StepSuccess;
			} catch (err) {
				const durationMs = Math.round(performance.now() - startTime);
				const error = err instanceof Error ? err : new Error(String(err));
				stepCtx.log.debug('Step Failed', { durationMs, error: error.message });
				return { name: stepDef.name, error, durationMs } as StepFailure;
			}
		};

		// Execute with concurrency limit
		const parallelResults = await this.executeWithConcurrencyLimit(
			definitions,
			executeStep,
			this.parallelConcurrency
		);

		// Separate successful and failed steps
		const successfulSteps: StepSuccess[] = [];
		let firstError: WorkflowStepError | undefined;

		for (const item of parallelResults) {
			if ('error' in item) {
				if (!firstError) {
					firstError = new WorkflowStepError(item.name, (item as StepFailure).error);
				}
			} else {
				successfulSteps.push(item as StepSuccess);
				state.results = { ...state.results, [item.name]: (item as StepSuccess).result };
			}
		}

		// Track successful steps with rollbacks
		for (const step of successfulSteps) {
			if (step.rollback) {
				state.completedStepsWithRollback.push({
					name: step.name,
					rollback: step.rollback
				});
			}
		}

		// If there was a failure, run all rollbacks
		if (firstError) {
			const rollbackCtx: StepExecutionContext<TData> = { ...ctx, results: state.results };
			await this.runRollbacks(rollbackCtx, state.completedStepsWithRollback);
			return firstError;
		}

		return undefined;
	}

	/**
	 * Execute a single definition-based step safely.
	 */
	private async executeDefinitionStepSafely<TData>(
		stepName: string,
		handler: StepHandler,
		ctx: WorkflowContext<TData>,
		state: { results: Record<string, unknown> }
	): Promise<WorkflowStepError | undefined> {
		// Marker type for caught errors
		type CaughtError = { __stepError: true; error: unknown };

		const startTime = performance.now();

		// Use .catch() to convert rejection to resolved value BEFORE awaiting.
		const resultOrError: unknown = await Promise.resolve(handler(ctx)).catch(
			(err: unknown): CaughtError => ({ __stepError: true, error: err })
		);

		const durationMs = Math.round(performance.now() - startTime);

		// Check if we caught an error
		if (resultOrError !== null && typeof resultOrError === 'object' && '__stepError' in resultOrError) {
			const caught = resultOrError as CaughtError;
			ctx.log.debug('Step Failed', { durationMs, error: (caught.error as Error).message });
			return new WorkflowStepError(stepName, caught.error as Error);
		}

		ctx.log.debug('Step Completed', { durationMs });
		state.results = { ...state.results, [stepName]: resultOrError };
		return undefined;
	}
}
