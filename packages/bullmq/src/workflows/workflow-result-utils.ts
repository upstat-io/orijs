/**
 * Workflow result processing utilities.
 *
 * Handles result wrapper types and flattening for distributed workflow execution.
 * These utilities enable result accumulation across distributed workers where
 * each step stores its result with all prior step results.
 *
 * @module workflows/workflow-result-utils
 */

import { Json } from '@orijs/validation';

/**
 * Version identifier for result wrappers.
 * Used to detect format changes in distributed environments.
 */
export const WRAPPER_VERSION = '1';

/**
 * Keys that are dangerous for prototype pollution.
 * Used for step name validation - step names cannot be these values.
 */
export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Wrapper for step results in distributed workflow execution.
 *
 * This wrapper enables result accumulation across distributed workers:
 * - Each step stores its result with all prior step results
 * - Parent jobs use job.getChildrenValues() to retrieve child results
 * - The __priorResults field accumulates all previous step results
 * - Workers can reconstruct full workflow state without shared memory
 *
 * @internal Used by BullMQ job processors, not exposed to workflow handlers
 */
export interface StepResultWrapper {
	readonly __version: string;
	readonly __stepName: string;
	readonly __stepResult: unknown;
	readonly __priorResults: Record<string, unknown>;
}

/**
 * Wrapper for parallel step group results in distributed workflow execution.
 *
 * Similar to StepResultWrapper but for parallel step groups:
 * - __parallelResults contains results from all parallel steps
 * - __priorResults contains results from steps before the parallel group
 *
 * @internal Used by BullMQ job processors, not exposed to workflow handlers
 */
export interface ParallelResultWrapper {
	readonly __version: string;
	readonly __parallelResults: Record<string, unknown>;
	readonly __priorResults: Record<string, unknown>;
}

/**
 * Type guard for StepResultWrapper.
 */
export function isStepResultWrapper(value: unknown): value is StepResultWrapper {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__version' in value &&
		'__stepName' in value &&
		'__stepResult' in value &&
		'__priorResults' in value
	);
}

/**
 * Type guard for ParallelResultWrapper.
 */
export function isParallelResultWrapper(value: unknown): value is ParallelResultWrapper {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__version' in value &&
		'__parallelResults' in value &&
		'__priorResults' in value
	);
}

/**
 * Flatten child job results into a single record.
 *
 * BullMQ's job.getChildrenValues() returns results keyed by queue:jobId.
 * This function extracts the actual step results and merges them together,
 * handling both sequential and parallel step results.
 *
 * Security: All results are sanitized to prevent prototype pollution.
 *
 * @param childResults - Raw results from job.getChildrenValues()
 * @returns Flattened record of step name -> step result
 */
export function flattenChildResults(childResults: Record<string, unknown>): Record<string, unknown> {
	const results: Record<string, unknown> = {};

	for (const [, value] of Object.entries(childResults)) {
		if (isStepResultWrapper(value)) {
			// Sanitize prior results to prevent prototype pollution before Object.assign
			const sanitizedPrior = Json.sanitize(value.__priorResults);
			Object.assign(results, sanitizedPrior);
			// Sanitize step name and result to prevent __proto__ as step name
			const stepName = DANGEROUS_KEYS.has(value.__stepName)
				? `_sanitized_${value.__stepName}`
				: value.__stepName;
			results[stepName] = Json.sanitize(value.__stepResult);
		} else if (isParallelResultWrapper(value)) {
			// Sanitize prior results to prevent prototype pollution before Object.assign
			const sanitizedPrior = Json.sanitize(value.__priorResults);
			Object.assign(results, sanitizedPrior);
			// Sanitize parallel results before Object.assign
			const sanitizedParallel = Json.sanitize(value.__parallelResults);
			Object.assign(results, sanitizedParallel);
		}
	}

	return results;
}
