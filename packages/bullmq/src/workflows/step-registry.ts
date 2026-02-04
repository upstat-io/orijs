/**
 * StepRegistry - Manages step handler registration for workflow execution.
 *
 * Workers use the StepRegistry to look up the correct handler for each step job.
 * Handlers are registered by workflow name and step name.
 *
 * @module workflows/step-registry
 */

import type { StepHandler, RollbackHandler } from '@orijs/workflows';

/**
 * Registered step info including handler and optional rollback.
 */
export interface RegisteredStep {
	readonly handler: StepHandler;
	readonly rollback?: RollbackHandler;
}

/**
 * Error thrown when a step handler is not found.
 */
export class StepNotFoundError extends Error {
	public readonly workflowName: string;
	public readonly stepName: string;

	public constructor(workflowName: string, stepName: string) {
		super(`Step '${stepName}' not found for workflow '${workflowName}'`);
		this.name = 'StepNotFoundError';
		this.workflowName = workflowName;
		this.stepName = stepName;
	}
}

/**
 * Registry for workflow step handlers.
 *
 * Provides a two-level lookup: workflow name → step name → handler.
 * Used by BullMQ workers to execute the correct handler for each step job.
 *
 * @example
 * ```ts
 * const registry = new StepRegistry();
 *
 * // Register handlers during workflow registration
 * registry.register('OrderWorkflow', 'validate', validateHandler);
 * registry.register('OrderWorkflow', 'process', processHandler);
 *
 * // Look up handler in worker
 * const handler = registry.get(job.data.workflowName, job.data.stepName);
 * const result = await handler(ctx);
 * ```
 */
export class StepRegistry {
	/** Map of workflow name → step name → registered step info */
	private readonly steps: Map<string, Map<string, RegisteredStep>> = new Map();

	/**
	 * Register a step handler for a workflow.
	 *
	 * @param workflowName - Name of the workflow class
	 * @param stepName - Name of the step
	 * @param handler - The step handler function
	 * @param rollback - Optional rollback handler
	 */
	public register(
		workflowName: string,
		stepName: string,
		handler: StepHandler,
		rollback?: RollbackHandler
	): void {
		let workflowSteps = this.steps.get(workflowName);
		if (!workflowSteps) {
			workflowSteps = new Map();
			this.steps.set(workflowName, workflowSteps);
		}
		workflowSteps.set(stepName, { handler, rollback });
	}

	/**
	 * Get a step handler.
	 *
	 * @param workflowName - Name of the workflow class
	 * @param stepName - Name of the step
	 * @returns The step handler
	 * @throws StepNotFoundError if handler not registered
	 */
	public get(workflowName: string, stepName: string): StepHandler {
		const step = this.getStep(workflowName, stepName);
		return step.handler;
	}

	/**
	 * Get complete step info including handler and rollback.
	 *
	 * @param workflowName - Name of the workflow class
	 * @param stepName - Name of the step
	 * @returns The registered step info
	 * @throws StepNotFoundError if step not registered
	 */
	public getStep(workflowName: string, stepName: string): RegisteredStep {
		const workflowSteps = this.steps.get(workflowName);
		if (!workflowSteps) {
			throw new StepNotFoundError(workflowName, stepName);
		}

		const step = workflowSteps.get(stepName);
		if (!step) {
			throw new StepNotFoundError(workflowName, stepName);
		}

		return step;
	}

	/**
	 * Get rollback handler for a step.
	 *
	 * @param workflowName - Name of the workflow class
	 * @param stepName - Name of the step
	 * @returns The rollback handler or undefined if not registered
	 */
	public getRollback(workflowName: string, stepName: string): RollbackHandler | undefined {
		try {
			const step = this.getStep(workflowName, stepName);
			return step.rollback;
		} catch {
			return undefined;
		}
	}

	/**
	 * Check if a step handler is registered.
	 *
	 * @param workflowName - Name of the workflow class
	 * @param stepName - Name of the step
	 * @returns True if handler is registered
	 */
	public has(workflowName: string, stepName: string): boolean {
		const workflowSteps = this.steps.get(workflowName);
		if (!workflowSteps) {
			return false;
		}
		return workflowSteps.has(stepName);
	}

	/**
	 * Get all step names registered for a workflow.
	 *
	 * @param workflowName - Name of the workflow class
	 * @returns Array of step names (empty if workflow not found)
	 */
	public getWorkflowSteps(workflowName: string): string[] {
		const workflowSteps = this.steps.get(workflowName);
		if (!workflowSteps) {
			return [];
		}
		return Array.from(workflowSteps.keys());
	}

	/**
	 * Clear all registered handlers.
	 *
	 * Useful for testing or when reinitializing the registry.
	 */
	public clear(): void {
		this.steps.clear();
	}
}

/**
 * Creates a new StepRegistry instance.
 *
 * @returns New StepRegistry
 */
export function createStepRegistry(): StepRegistry {
	return new StepRegistry();
}
