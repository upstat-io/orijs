/**
 * Context propagation test workflow definitions.
 *
 * Factory functions for testing logger and metadata propagation through workflows.
 * Uses definition-based workflow API.
 *
 * @module contract/workflows/context-workflows
 */

import type { DefinitionWorkflowConfig, WorkflowContext } from './definition-types';
import { sequential, parallel } from './definition-types';
import type { TestOrderData } from './types';
import type { Logger } from '@orijs/logging';

/**
 * Creates a workflow that captures the logger received in a step.
 */
export function createLoggerCheckWorkflow(capturedLogger: {
	value: Logger | null;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'LoggerCheckWorkflow',
		stepGroups: [sequential('check')],
		stepHandlers: {
			check: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedLogger.value = ctx.log;
					return {};
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow that captures the logger from onComplete.
 * Note: In definition-based API, we capture logger in a step since onComplete doesn't have context.
 */
export function createOnCompleteLoggerWorkflow(capturedLogger: {
	value: Logger | null;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	// Store logger during step execution for retrieval in tests
	let stepLogger: Logger | null = null;
	return {
		name: 'OnCompleteLoggerWorkflow',
		stepGroups: [sequential('step')],
		stepHandlers: {
			step: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					stepLogger = ctx.log;
					return {};
				}
			}
		},
		onComplete: async () => {
			// Capture the logger from step execution
			capturedLogger.value = stepLogger;
		}
	};
}

/**
 * Creates a workflow that captures the logger from onError.
 * Note: In definition-based API, we capture logger in step since onError doesn't have context.
 */
export function createOnErrorLoggerWorkflow(capturedLogger: {
	value: Logger | null;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	let stepLogger: Logger | null = null;
	return {
		name: 'OnErrorLoggerWorkflow',
		stepGroups: [sequential('fail')],
		stepHandlers: {
			fail: {
				execute: (ctx: WorkflowContext<TestOrderData>) => {
					stepLogger = ctx.log;
					return Promise.reject(new Error('Intentional failure'));
				}
			}
		},
		onComplete: async () => {},
		onError: async () => {
			capturedLogger.value = stepLogger;
		}
	};
}

/**
 * Creates a workflow that captures loggers from multiple steps.
 */
export function createMultiStepLoggerWorkflow(
	capturedLoggers: Logger[]
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'MultiStepLoggerWorkflow',
		stepGroups: [sequential('step1', 'step2'), parallel('step3', 'step4')],
		stepHandlers: {
			step1: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedLoggers.push(ctx.log);
					return {};
				}
			},
			step2: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedLoggers.push(ctx.log);
					return {};
				}
			},
			step3: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedLoggers.push(ctx.log);
					return {};
				}
			},
			step4: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedLoggers.push(ctx.log);
					return {};
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow that captures propagation metadata from multiple steps.
 */
export function createContextCheckWorkflow(
	capturedMeta: Record<string, unknown>[]
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ContextCheckWorkflow',
		stepGroups: [sequential('step1', 'step2')],
		stepHandlers: {
			step1: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedMeta.push(ctx.log.propagationMeta());
					return {};
				}
			},
			step2: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedMeta.push(ctx.log.propagationMeta());
					return {};
				}
			}
		},
		onComplete: async () => {}
	};
}

/**
 * Creates a workflow that captures context metadata from onComplete.
 */
export function createOnCompleteContextWorkflow(capturedMeta: {
	value: Record<string, unknown> | null;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	let stepMeta: Record<string, unknown> | null = null;
	return {
		name: 'OnCompleteContextWorkflow',
		stepGroups: [sequential('step')],
		stepHandlers: {
			step: {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					stepMeta = ctx.log.propagationMeta();
					return {};
				}
			}
		},
		onComplete: async () => {
			capturedMeta.value = stepMeta;
		}
	};
}

/**
 * Creates a workflow that captures context metadata from onError.
 */
export function createOnErrorContextWorkflow(capturedMeta: {
	value: Record<string, unknown> | null;
}): DefinitionWorkflowConfig<TestOrderData, void> {
	let stepMeta: Record<string, unknown> | null = null;
	return {
		name: 'OnErrorContextWorkflow',
		stepGroups: [sequential('fail')],
		stepHandlers: {
			fail: {
				execute: (ctx: WorkflowContext<TestOrderData>) => {
					stepMeta = ctx.log.propagationMeta();
					return Promise.reject(new Error('Intentional failure'));
				}
			}
		},
		onComplete: async () => {},
		onError: async () => {
			capturedMeta.value = stepMeta;
		}
	};
}

/**
 * Creates a workflow that captures context from parallel steps.
 */
export function createParallelContextWorkflow(
	capturedMeta: Record<string, unknown>[]
): DefinitionWorkflowConfig<TestOrderData, void> {
	return {
		name: 'ParallelContextWorkflow',
		stepGroups: [parallel('parallel-a', 'parallel-b', 'parallel-c')],
		stepHandlers: {
			'parallel-a': {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedMeta.push(ctx.log.propagationMeta());
					return {};
				}
			},
			'parallel-b': {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedMeta.push(ctx.log.propagationMeta());
					return {};
				}
			},
			'parallel-c': {
				execute: async (ctx: WorkflowContext<TestOrderData>) => {
					capturedMeta.push(ctx.log.propagationMeta());
					return {};
				}
			}
		},
		onComplete: async () => {}
	};
}
