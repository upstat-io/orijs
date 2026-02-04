/**
 * Error handling test workflow definitions.
 *
 * Factory functions for testing error handling, onError callbacks, and error wrapping.
 * Uses definition-based workflow API.
 *
 * @module contract/workflows/error-workflows
 */

import type { DefinitionWorkflowConfig } from './definition-types';
import { sequential } from './definition-types';
import type { TestOrderData, ExecutionLog } from './types';

/**
 * Creates a workflow that tests onError callback when step fails.
 */
export function createErrorCallbackWorkflow(
	executionLog: ExecutionLog,
	capturedError: { value: Error | null }
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ErrorCallbackWorkflow',
		stepGroups: [sequential('step1', 'step2', 'step3')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1');
					return { done: true };
				}
			},
			step2: {
				execute: () => {
					executionLog.push('step2');
					return Promise.reject(new Error('Step 2 failed intentionally'));
				}
			},
			step3: {
				execute: async () => {
					executionLog.push('step3');
					return { done: true };
				}
			}
		},
		onComplete: async () => {},
		onError: async (_data, _meta, error) => {
			executionLog.push('onError');
			capturedError.value = error ?? null;
		}
	};
}

/**
 * Creates a workflow that preserves partial results on failure.
 */
export function createPartialResultsWorkflow(capturedResults: {
	value: Record<string, unknown>;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'PartialResultsWorkflow',
		stepGroups: [sequential('step1', 'step2', 'step3', 'step4')],
		stepHandlers: {
			step1: {
				execute: async () => {
					return { step1Result: 'first' };
				}
			},
			step2: {
				execute: async () => {
					return { step2Result: 'second' };
				}
			},
			step3: {
				execute: () => {
					return Promise.reject(new Error('Step 3 failed'));
				}
			},
			step4: {
				execute: async () => {
					return { step4Result: 'fourth' };
				}
			}
		},
		onComplete: async () => {},
		onError: async (_data, _meta, _error, stepResults) => {
			capturedResults.value = stepResults ?? {};
		}
	};
}

/**
 * Creates a workflow to test WorkflowStepError wrapping.
 */
export function createStepErrorWorkflow(): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'StepErrorWorkflow',
		stepGroups: [sequential('failing-step')],
		stepHandlers: {
			'failing-step': {
				execute: () => {
					return Promise.reject(new Error('Original error message'));
				}
			}
		},
		onComplete: async () => {}
	};
}
