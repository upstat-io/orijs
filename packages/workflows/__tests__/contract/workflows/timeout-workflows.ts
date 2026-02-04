/**
 * Timeout test workflow definitions.
 *
 * Factory functions for testing workflow timeout behavior.
 * Uses definition-based workflow API.
 *
 * @module contract/workflows/timeout-workflows
 */

import type { DefinitionWorkflowConfig } from './definition-types';
import { sequential } from './definition-types';
import type { TestOrderData } from './types';

/**
 * Creates a fast-completing workflow for testing timeout behavior.
 */
export function createFastWorkflow(): DefinitionWorkflowConfig<TestOrderData, string> {
	return {
		name: 'FastWorkflow',
		stepGroups: [sequential('fast')],
		stepHandlers: {
			fast: {
				execute: async () => ({ done: true })
			}
		},
		onComplete: async () => 'completed'
	};
}

/**
 * Creates a slow workflow that takes a configurable amount of time.
 * @param delayMs - How long the step should take
 */
export function createSlowWorkflow(delayMs: number): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'SlowWorkflow',
		stepGroups: [sequential('slow')],
		stepHandlers: {
			slow: {
				execute: async () => {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					return {};
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a slow workflow that returns a value on completion.
 * @param delayMs - How long the step should take
 */
export function createSlowSuccessWorkflow(delayMs: number): DefinitionWorkflowConfig<TestOrderData, string> {
	return {
		name: 'SlowSuccessWorkflow',
		stepGroups: [sequential('slow')],
		stepHandlers: {
			slow: {
				execute: async () => {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					return { done: true };
				}
			}
		},
		onComplete: async () => 'completed-without-timeout'
	};
}
