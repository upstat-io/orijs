/**
 * Definition-based workflow types for contract tests.
 *
 * These types support the new definition-based workflow API used by
 * all workflow provider implementations.
 *
 * @module contract/workflows/definition-types
 */

import type { StepGroup, StepHandler, RollbackHandler } from '../../../src/workflow.types.ts';
import type { WorkflowContext } from '../../../src/workflow-context.ts';

/**
 * Definition-based workflow configuration returned by factory functions.
 *
 * @template TData - Input data type
 * @template TResult - Result type from onComplete
 */
export interface DefinitionWorkflowConfig<TData = unknown, TResult = unknown> {
	/** Unique workflow name */
	name: string;
	/** Step groups defining execution structure */
	stepGroups: StepGroup[];
	/** Step handlers keyed by step name */
	stepHandlers: Record<string, { execute: StepHandler<TData>; rollback?: RollbackHandler<TData> }>;
	/** Handler called when all steps complete (receives data, meta, stepResults) */
	onComplete: (data: TData, meta?: unknown, stepResults?: Record<string, unknown>) => Promise<TResult>;
	/** Handler called when a step fails (optional) */
	onError?: (
		data: TData,
		meta?: unknown,
		error?: Error,
		stepResults?: Record<string, unknown>
	) => Promise<void>;
}

/**
 * Mock workflow definition for use with execute().
 * Has the minimal structure needed to be detected as a definition.
 */
export interface MockWorkflowDefinition<TData = unknown, TResult = unknown> {
	name: string;
	dataSchema: unknown; // Marker property to identify as definition
	resultSchema: unknown;
	stepGroups: StepGroup[];
	_data: TData;
	_result: TResult;
}

/**
 * Create a mock workflow definition from a config.
 */
export function createMockDefinition<TData, TResult>(
	config: DefinitionWorkflowConfig<TData, TResult>
): MockWorkflowDefinition<TData, TResult> {
	return {
		name: config.name,
		dataSchema: {}, // Marker for definition detection
		resultSchema: {},
		stepGroups: config.stepGroups,
		_data: undefined as unknown as TData,
		_result: undefined as unknown as TResult
	};
}

/**
 * Helper to create a step group of sequential steps.
 */
export function sequential(...stepNames: string[]): StepGroup {
	return {
		type: 'sequential',
		definitions: stepNames.map((name) => ({ name }))
	};
}

/**
 * Helper to create a step group of parallel steps.
 */
export function parallel(...stepNames: string[]): StepGroup {
	return {
		type: 'parallel',
		definitions: stepNames.map((name) => ({ name }))
	};
}

/**
 * Re-export WorkflowContext for use in factories.
 */
export type { WorkflowContext };
