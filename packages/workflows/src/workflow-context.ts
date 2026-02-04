/**
 * Workflow Context - Context passed to workflow steps.
 *
 * Provides steps with:
 * - Typed workflow input data
 * - Accumulated results from previous steps (Q4 decision)
 * - Logger with propagated context
 * - Metadata for context propagation
 *
 * @module workflows/workflow-context
 */

import type { Logger, PropagationMeta } from '@orijs/logging';

/**
 * Context passed to workflow steps.
 *
 * Per Q4 decision: The `results` property accumulates results
 * from all completed steps: { step1: result1, step2: result2, ... }
 *
 * @template TData - Workflow input data type
 *
 * @example
 * ```ts
 * private processStep = async (ctx: WorkflowContext<OrderData>) => {
 *   // Access workflow input
 *   const { orderId } = ctx.data;
 *
 *   // Access previous step results (Q4)
 *   const validation = ctx.results['validate'] as ValidationResult;
 *
 *   // Use logger with propagated context
 *   ctx.log.info('Processing order', { orderId });
 *
 *   return { processed: true };
 * };
 * ```
 */
export interface WorkflowContext<TData = unknown> {
	/** Unique flow ID for this workflow execution */
	readonly flowId: string;

	/** Input data for the workflow */
	readonly data: TData;

	/**
	 * Accumulated results from completed steps.
	 *
	 * Q4 decision: Results accumulate as { stepName: result, ... }
	 * Each step can access previous step results via this property.
	 */
	readonly results: Record<string, unknown>;

	/** Logger with propagated context (correlationId, traceId, etc.) */
	readonly log: Logger;

	/** Metadata for context propagation */
	readonly meta: PropagationMeta;

	/**
	 * Optional provider instance identifier.
	 *
	 * In distributed deployments, this identifies which provider instance
	 * is executing the current step. Useful for:
	 * - Distributed tracing and debugging
	 * - Multi-instance testing verification
	 * - Observability and metrics
	 *
	 * Set via provider options (e.g., `providerId` in provider configuration).
	 */
	readonly providerId?: string;
}

/**
 * Default implementation of WorkflowContext.
 *
 * Immutable - all properties are readonly.
 */
export class DefaultWorkflowContext<TData = unknown> implements WorkflowContext<TData> {
	public constructor(
		public readonly flowId: string,
		public readonly data: TData,
		public readonly results: Record<string, unknown>,
		public readonly log: Logger,
		public readonly meta: PropagationMeta,
		public readonly providerId?: string
	) {}
}

/**
 * Options for creating a workflow context.
 */
export interface WorkflowContextOptions {
	/** Workflow class name for logging context */
	workflowName?: string;
	/** Current step name for logging context */
	stepName?: string;
	/** Provider instance identifier for distributed tracing */
	providerId?: string;
}

/**
 * Creates a WorkflowContext from components.
 *
 * Automatically adds workflow context (flowId, workflowName, stepName) to the logger.
 * This is internal framework plumbing - providers just use ctx.log normally.
 *
 * @template TData - Workflow input data type
 * @param flowId - Unique flow ID (must be non-empty string)
 * @param data - Workflow input data
 * @param results - Accumulated step results (must be object)
 * @param log - Base logger (context will be added automatically)
 * @param meta - Propagation metadata (must be object)
 * @param options - Optional workflow/step context for logging
 * @returns Frozen WorkflowContext
 * @throws Error if any input is invalid
 */
export function createWorkflowContext<TData>(
	flowId: string,
	data: TData,
	results: Record<string, unknown>,
	log: Logger,
	meta: PropagationMeta,
	options?: WorkflowContextOptions
): WorkflowContext<TData> {
	// Validate inputs at boundary (fail-fast)
	if (!flowId || typeof flowId !== 'string') {
		throw new Error('flowId must be a non-empty string');
	}
	if (!log) {
		throw new Error('log (Logger) is required');
	}
	if (!results || typeof results !== 'object' || Array.isArray(results)) {
		throw new Error('results must be an object');
	}
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
		throw new Error('meta must be an object');
	}

	// Automatically add workflow context to logger (internal framework concern)
	const logContext: Record<string, unknown> = { flowId };
	if (options?.workflowName) {
		logContext.workflow = options.workflowName;
	}
	if (options?.stepName) {
		logContext.step = options.stepName;
	}
	if (options?.providerId) {
		logContext.providerId = options.providerId;
	}
	const contextualLog = log.with(logContext);

	return Object.freeze(
		new DefaultWorkflowContext(flowId, data, results, contextualLog, meta, options?.providerId)
	);
}
