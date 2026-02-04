/**
 * Execution test workflow definitions.
 *
 * Factory functions for testing sequential, parallel, and mixed execution patterns.
 * Uses definition-based workflow API.
 *
 * @module contract/workflows/execution-workflows
 */

import type { DefinitionWorkflowConfig, WorkflowContext } from './definition-types';
import { sequential, parallel } from './definition-types';
import type { TestOrderData, ExecutionLog } from './types';

/**
 * Creates a sequential workflow that tracks execution order.
 */
export function createSequentialWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, string> {
	return {
		name: 'SequentialWorkflow',
		stepGroups: [sequential('step1', 'step2', 'step3')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1');
					return { done: true };
				}
			},
			step2: {
				execute: async () => {
					executionLog.push('step2');
					return { done: true };
				}
			},
			step3: {
				execute: async () => {
					executionLog.push('step3');
					return { done: true };
				}
			}
		},
		onComplete: async () => {
			executionLog.push('onComplete');
			return 'completed';
		}
	};
}

/**
 * Creates a workflow that tests result accumulation across steps.
 */
export function createAccumulatingWorkflow(capturedResults: {
	value: Record<string, unknown>;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'AccumulatingWorkflow',
		stepGroups: [sequential('validate', 'process', 'notify')],
		stepHandlers: {
			validate: {
				execute: async () => {
					return { isValid: true };
				}
			},
			process: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					// Access previous step's result
					const validation = ctx.results['validate'] as { isValid: boolean };
					return {
						processed: validation.isValid,
						reference: 'REF-123'
					};
				}
			},
			notify: {
				execute: async () => {
					return {
						notified: true,
						channels: ['email', 'sms']
					};
				}
			}
		},
		onComplete: async (_data, _meta, stepResults) => {
			capturedResults.value = stepResults ?? {};
		}
	};
}

/**
 * Creates a parallel workflow that tracks execution timing.
 */
export function createParallelWorkflow(
	startTimes: Record<string, number>,
	endTimes: Record<string, number>
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ParallelWorkflow',
		stepGroups: [parallel('task-a', 'task-b', 'task-c')],
		stepHandlers: {
			'task-a': {
				execute: async () => {
					startTimes['task-a'] = Date.now();
					await new Promise((resolve) => setTimeout(resolve, 50));
					endTimes['task-a'] = Date.now();
					return { a: true };
				}
			},
			'task-b': {
				execute: async () => {
					startTimes['task-b'] = Date.now();
					await new Promise((resolve) => setTimeout(resolve, 50));
					endTimes['task-b'] = Date.now();
					return { b: true };
				}
			},
			'task-c': {
				execute: async () => {
					startTimes['task-c'] = Date.now();
					await new Promise((resolve) => setTimeout(resolve, 50));
					endTimes['task-c'] = Date.now();
					return { c: true };
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a parallel workflow that accumulates results.
 */
export function createParallelAccumulatingWorkflow(capturedResults: {
	value: Record<string, unknown>;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ParallelAccumulatingWorkflow',
		stepGroups: [parallel('email', 'sms', 'push')],
		stepHandlers: {
			email: {
				execute: async () => ({ emailSent: true })
			},
			sms: {
				execute: async () => ({ smsSent: true })
			},
			push: {
				execute: async () => ({ pushSent: true })
			}
		},
		onComplete: async (_data, _meta, stepResults) => {
			capturedResults.value = stepResults ?? {};
		}
	};
}

/**
 * Creates a mixed workflow (sequential then parallel then sequential).
 */
export function createMixedWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'MixedWorkflow',
		stepGroups: [sequential('init'), parallel('task-a', 'task-b'), sequential('finalize')],
		stepHandlers: {
			init: {
				execute: async () => {
					executionLog.push('init');
					return { initialized: true };
				}
			},
			'task-a': {
				execute: async () => {
					executionLog.push('task-a');
					return { a: true };
				}
			},
			'task-b': {
				execute: async () => {
					executionLog.push('task-b');
					return { b: true };
				}
			},
			finalize: {
				execute: async () => {
					executionLog.push('finalize');
					return { finalized: true };
				}
			}
		},
		onComplete: async () => {
			executionLog.push('onComplete');
		}
	};
}
