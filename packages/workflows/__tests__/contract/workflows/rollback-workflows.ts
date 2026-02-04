/**
 * Rollback test workflow definitions.
 *
 * Factory functions that create workflow configs for testing rollback behavior.
 * These are used by contract tests to verify all workflow provider implementations
 * handle rollback correctly.
 *
 * Uses definition-based workflow API.
 *
 * @module contract/workflows/rollback-workflows
 */

import type { DefinitionWorkflowConfig, WorkflowContext } from './definition-types';
import { sequential, parallel } from './definition-types';
import type { TestOrderData, ExecutionLog } from './types';

/**
 * Creates a workflow that tests basic rollback in reverse order.
 *
 * Steps: charge → reserve → ship (fails)
 * Expected rollback order: reserve-rollback → charge-rollback
 */
export function createBasicRollbackWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'BasicRollbackWorkflow',
		stepGroups: [sequential('charge', 'reserve', 'ship')],
		stepHandlers: {
			charge: {
				execute: async () => {
					executionLog.push('charge-execute');
					return { chargeId: 'ch_123' };
				},
				rollback: async () => {
					executionLog.push('charge-rollback');
				}
			},
			reserve: {
				execute: async () => {
					executionLog.push('reserve-execute');
					return { reservationId: 'res_456' };
				},
				rollback: async () => {
					executionLog.push('reserve-rollback');
				}
			},
			ship: {
				execute: () => {
					executionLog.push('ship-execute');
					return Promise.reject(new Error('Shipping failed'));
				},
				rollback: async () => {
					executionLog.push('ship-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow where the failing step should NOT have its rollback called.
 *
 * Steps: step1 → step2 (fails)
 * Expected: step1-rollback runs, step2-rollback does NOT run
 */
export function createNoSelfRollbackWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'NoSelfRollbackWorkflow',
		stepGroups: [sequential('step1', 'step2')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('step1-rollback');
				}
			},
			step2: {
				execute: () => {
					executionLog.push('step2-execute');
					return Promise.reject(new Error('Step 2 failed'));
				},
				rollback: async () => {
					executionLog.push('step2-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow where a rollback handler fails but other rollbacks continue.
 *
 * Steps: step1 → step2 → step3 (fails)
 * step2's rollback throws, but step1's rollback should still run.
 */
export function createRollbackErrorWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'RollbackErrorWorkflow',
		stepGroups: [sequential('step1', 'step2', 'step3')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('step1-rollback');
				}
			},
			step2: {
				execute: async () => {
					executionLog.push('step2-execute');
					return {};
				},
				rollback: () => {
					executionLog.push('step2-rollback-start');
					return Promise.reject(new Error('Rollback failed'));
				}
			},
			step3: {
				execute: () => {
					executionLog.push('step3-execute');
					return Promise.reject(new Error('Step 3 failed'));
				},
				rollback: async () => {
					executionLog.push('step3-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow with mixed steps (some with rollback, some without).
 *
 * Steps: step1 (rollback) → step2 (no rollback) → step3 (rollback) → step4 (fails)
 * Expected: step3-rollback, step1-rollback (step2 skipped - no handler)
 */
export function createMixedRollbackWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'MixedRollbackWorkflow',
		stepGroups: [sequential('step1', 'step2', 'step3', 'step4')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('step1-rollback');
				}
			},
			step2: {
				execute: async () => {
					executionLog.push('step2-execute');
					return {};
				}
				// No rollback handler
			},
			step3: {
				execute: async () => {
					executionLog.push('step3-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('step3-rollback');
				}
			},
			step4: {
				execute: () => {
					executionLog.push('step4-execute');
					return Promise.reject(new Error('Step 4 failed'));
				}
				// No rollback handler
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a successful workflow that should NOT trigger any rollbacks.
 */
export function createSuccessfulWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, string> {
	return {
		name: 'SuccessfulWorkflow',
		stepGroups: [sequential('step1', 'step2')],
		stepHandlers: {
			step1: {
				execute: async () => {
					executionLog.push('step1-execute');
					return { done: true };
				},
				rollback: async () => {
					executionLog.push('step1-rollback');
				}
			},
			step2: {
				execute: async () => {
					executionLog.push('step2-execute');
					return { done: true };
				},
				rollback: async () => {
					executionLog.push('step2-rollback');
				}
			}
		},
		onComplete: async () => {
			executionLog.push('onComplete');
			return 'success';
		}
	};
}

/**
 * Creates a parallel workflow where one step fails.
 * The completed step should have its rollback called.
 */
export function createParallelRollbackWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ParallelRollbackWorkflow',
		stepGroups: [parallel('fast-success', 'slow-fail')],
		stepHandlers: {
			'fast-success': {
				execute: async () => {
					executionLog.push('fast-success-execute');
					return { done: true };
				},
				rollback: async () => {
					executionLog.push('fast-success-rollback');
				}
			},
			'slow-fail': {
				execute: async () => {
					await new Promise((r) => setTimeout(r, 50));
					executionLog.push('slow-fail-execute');
					return Promise.reject(new Error('Slow step failed'));
				},
				rollback: async () => {
					executionLog.push('slow-fail-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a mixed sequential-parallel workflow.
 * Tests that rollback spans across group boundaries.
 */
export function createMixedGroupRollbackWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'MixedGroupRollbackWorkflow',
		stepGroups: [sequential('init'), parallel('parallel-success', 'parallel-fail')],
		stepHandlers: {
			init: {
				execute: async () => {
					executionLog.push('init-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('init-rollback');
				}
			},
			'parallel-success': {
				execute: async () => {
					executionLog.push('parallel-success-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('parallel-success-rollback');
				}
			},
			'parallel-fail': {
				execute: () => {
					executionLog.push('parallel-fail-execute');
					return Promise.reject(new Error('Parallel step failed'));
				},
				rollback: async () => {
					executionLog.push('parallel-fail-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow to test that rollback handlers receive context.
 */
export function createContextRollbackWorkflow(
	_executionLog: ExecutionLog,
	capturedContext: { data: TestOrderData | null; results: Record<string, unknown> }
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ContextRollbackWorkflow',
		stepGroups: [sequential('step1', 'step2')],
		stepHandlers: {
			step1: {
				execute: async () => {
					return { step1Result: 'value1' };
				},
				rollback: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedContext.data = ctx.data;
					capturedContext.results = { ...ctx.results };
				}
			},
			step2: {
				execute: () => Promise.reject(new Error('Step 2 failed'))
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow where the first step fails.
 * No rollbacks should run since no steps completed.
 */
export function createFirstStepFailWorkflow(
	executionLog: ExecutionLog
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'FirstStepFailWorkflow',
		stepGroups: [sequential('step1', 'step2')],
		stepHandlers: {
			step1: {
				execute: () => {
					executionLog.push('step1-execute');
					return Promise.reject(new Error('First step failed'));
				},
				rollback: async () => {
					executionLog.push('step1-rollback');
				}
			},
			step2: {
				execute: async () => {
					executionLog.push('step2-execute');
					return {};
				},
				rollback: async () => {
					executionLog.push('step2-rollback');
				}
			}
		},
		onComplete: async () => {}
	};
}
