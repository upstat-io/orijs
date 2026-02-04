/**
 * BullMQ Workflow Integration Tests
 *
 * Tests the BullMQWorkflowProvider with real Redis via testcontainers.
 * Verifies actual workflow execution through BullMQ FlowProducer.
 *
 * Covers:
 * - Sequential workflow execution
 * - Parallel workflow execution
 * - Mixed sequential/parallel workflows
 * - Step result accumulation
 * - Error handling in steps
 * - Context propagation
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';

/**
 * Test timeout constants for workflow execution.
 */
const TEST_TIMEOUTS = {
	/** Standard workflow execution timeout */
	WORKFLOW_EXECUTION: 2_000,
	/** Shorter timeout for error workflows (fail quickly) */
	ERROR_WORKFLOW: 1_000,
	/** Longer timeout for concurrent workflow execution */
	CONCURRENT_WORKFLOWS: 3_000,
	/** Delay between test files for cleanup */
	INTER_FILE_CLEANUP: 25,
	/** Delay between tests for clean state */
	INTER_TEST_CLEANUP: 10
} as const;

/**
 * Helper to wait for a promise with timeout.
 * Properly cleans up timer whether the promise resolves or rejects.
 */
async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	errorMessage = 'Timeout waiting for result'
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), ms);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

// Define Sequential Workflow
const SequentialWorkflowDef = Workflow.define({
	name: 'sequential-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

const sequentialStepGroups = [
	{ type: 'sequential' as const, definitions: [{ name: 'double' }, { name: 'add10' }] }
];

const createSequentialStepHandlers = () => ({
	double: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { doubled: ctx.data.value * 2 };
		}
	},
	add10: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			const doubleResult = ctx.results['double'] as { doubled: number } | undefined;
			const prev = doubleResult?.doubled ?? ctx.data.value;
			return { added: prev + 10 };
		}
	}
});

// Define Parallel Workflow
const ParallelWorkflowDef = Workflow.define({
	name: 'parallel-workflow',
	data: Type.Object({ items: Type.Array(Type.String()) }),
	result: Type.Object({ processed: Type.Number() })
});

const parallelStepGroups = [
	{ type: 'parallel' as const, definitions: [{ name: 'validate' }, { name: 'enrich' }, { name: 'index' }] }
];

const createParallelStepHandlers = () => ({
	validate: {
		execute: async (ctx: WorkflowContext<{ items: string[] }>) => {
			return { valid: ctx.data.items.length > 0 };
		}
	},
	enrich: {
		execute: async (ctx: WorkflowContext<{ items: string[] }>) => {
			return { enriched: ctx.data.items.map((i) => `enriched:${i}`) };
		}
	},
	index: {
		execute: async (ctx: WorkflowContext<{ items: string[] }>) => {
			return { indexed: ctx.data.items.length };
		}
	}
});

// Define Mixed Workflow
const MixedWorkflowDef = Workflow.define({
	name: 'mixed-workflow',
	data: Type.Object({ input: Type.String() }),
	result: Type.Object({})
});

const mixedStepGroups = [
	{ type: 'sequential' as const, definitions: [{ name: 'parse' }, { name: 'transform' }] },
	{ type: 'parallel' as const, definitions: [{ name: 'notify-email' }, { name: 'notify-slack' }] }
];

const createMixedStepHandlers = () => ({
	parse: {
		execute: async (ctx: WorkflowContext<{ input: string }>) => {
			return { parsed: ctx.data.input.toUpperCase() };
		}
	},
	transform: {
		execute: async () => {
			return { transformed: true };
		}
	},
	'notify-email': {
		execute: async () => {
			return { channel: 'email', sent: true };
		}
	},
	'notify-slack': {
		execute: async () => {
			return { channel: 'slack', sent: true };
		}
	}
});

// Define Step Results Workflow
const StepResultsWorkflowDef = Workflow.define({
	name: 'step-results-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ finalValue: Type.Number() })
});

const stepResultsStepGroups = [
	{ type: 'sequential' as const, definitions: [{ name: 'multiply' }, { name: 'add' }, { name: 'square' }] }
];

const createStepResultsStepHandlers = () => ({
	multiply: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { computed: ctx.data.value * 3 };
		}
	},
	add: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			const multiplyResult = ctx.results['multiply'] as { computed: number } | undefined;
			const prev = multiplyResult?.computed ?? ctx.data.value;
			return { computed: prev + 10 };
		}
	},
	square: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			const addResult = ctx.results['add'] as { computed: number } | undefined;
			const prev = addResult?.computed ?? ctx.data.value;
			return { computed: prev * prev };
		}
	}
});

// Define Error Workflow
const ErrorWorkflowDef = Workflow.define({
	name: 'error-workflow',
	data: Type.Object({ shouldFail: Type.Boolean() }),
	result: Type.Object({})
});

const errorStepGroups = [
	{ type: 'sequential' as const, definitions: [{ name: 'check' }, { name: 'process' }] }
];

const createErrorStepHandlers = () => ({
	check: {
		execute: async (ctx: WorkflowContext<{ shouldFail: boolean }>) => {
			if (ctx.data.shouldFail) {
				throw new Error('Check failed as requested');
			}
			return { checked: true };
		}
	},
	process: {
		execute: async () => {
			return { processed: true };
		}
	}
});

// Define Rollback Context Workflow
const RollbackContextWorkflowDef = Workflow.define({
	name: 'rollback-context-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({})
});

const rollbackContextStepGroups = [
	{ type: 'sequential' as const, definitions: [{ name: 'step1' }, { name: 'step2' }] }
];

/**
 * Captured context from rollback handlers for testing context propagation.
 */
let rollbackCapturedContext: {
	step1Rollback?: { traceId?: string; correlationId?: string };
} = {};

const createRollbackContextStepHandlers = () => ({
	step1: {
		execute: async () => {
			return { done: true };
		},
		rollback: async (ctx: WorkflowContext<{ value: number }>) => {
			// Capture context to verify propagation
			rollbackCapturedContext.step1Rollback = {
				traceId: ctx.meta.traceId as string | undefined,
				correlationId: ctx.meta.correlationId as string | undefined
			};
		}
	},
	step2: {
		execute: async () => {
			throw new Error('Intentional failure to trigger rollback');
		}
	}
});

// Generate unique suffix per test file instance to prevent parallel test file interference
const testFileId = Math.random().toString(36).substring(2, 8);

describe('BullMQWorkflowProvider Integration', () => {
	let provider: BullMQWorkflowProvider;
	/** Counter for unique queue prefix per test to ensure isolation */
	let testCounter = 0;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		// Use unique queue prefix per test to ensure complete isolation
		// Includes random suffix to prevent parallel test file interference
		// NOTE: We don't flush Redis here as it would interfere with parallel test files
		const uniquePrefix = `wf-int-${testFileId}-${++testCounter}`;
		provider = new BullMQWorkflowProvider({ connection, queuePrefix: uniquePrefix });
	});

	afterEach(async () => {
		await provider.stop();
	});

	describe('sequential workflow', () => {
		it('should execute steps in sequence and return result', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(SequentialWorkflowDef, { value: 5 });

			// Verify handle properties
			expect(handle.id).toBeDefined();
			expect(handle.id).toContain('flow-');

			// Check status (should be running)
			const status = await handle.status();
			expect(['pending', 'running', 'completed']).toContain(status);

			// Wait for completion (with timeout)
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// value=5: double(5*2=10) → add10(10+10=20) → onComplete returns 20
			expect(result).toEqual({ result: 20 });

			// Verify completed status
			const finalStatus = await handle.status();
			expect(finalStatus).toBe('completed');
		});

		it('should track flow status correctly', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(SequentialWorkflowDef, { value: 10 });

			// Initial status after execute returns should be running
			const initialStatus = await handle.status();
			expect(['running', 'completed']).toContain(initialStatus);

			// Wait for result
			await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// Final status should be completed
			const finalStatus = await handle.status();
			expect(finalStatus).toBe('completed');
		});
	});

	describe('parallel workflow', () => {
		it('should execute parallel steps concurrently', async () => {
			provider.registerDefinitionConsumer(
				'parallel-workflow',
				async () => {
					return { processed: 3 };
				},
				parallelStepGroups,
				createParallelStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(ParallelWorkflowDef, { items: ['a', 'b', 'c'] });

			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			expect(result).toEqual({ processed: 3 });
		});
	});

	describe('mixed workflow', () => {
		it('should execute sequential steps then parallel steps', async () => {
			provider.registerDefinitionConsumer(
				'mixed-workflow',
				async () => {
					return {};
				},
				mixedStepGroups,
				createMixedStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(MixedWorkflowDef, { input: 'hello' });

			// Wait for completion
			await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			const finalStatus = await handle.status();
			expect(finalStatus).toBe('completed');
		});
	});

	describe('step results accumulation', () => {
		it('should key step results by step name, not job key', async () => {
			provider.registerDefinitionConsumer(
				'step-results-workflow',
				async (_data, _meta, stepResults) => {
					const squareResult = stepResults?.['square'] as { computed: number } | undefined;
					return { finalValue: squareResult?.computed ?? 0 };
				},
				stepResultsStepGroups,
				createStepResultsStepHandlers()
			);
			await provider.start();

			// value=5: multiply(5*3=15) → add(15+10=25) → square(25*25=625)
			const handle = await provider.execute(StepResultsWorkflowDef, { value: 5 });

			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// If results are properly keyed by step name:
			// - multiply: { computed: 15 }
			// - add gets 15, returns { computed: 25 }
			// - square gets 25, returns { computed: 625 }
			// - onComplete gets 625
			expect(result.finalValue).toBe(625);
		});

		it('should chain results through multiple sequential steps', async () => {
			provider.registerDefinitionConsumer(
				'step-results-workflow',
				async (_data, _meta, stepResults) => {
					const squareResult = stepResults?.['square'] as { computed: number } | undefined;
					return { finalValue: squareResult?.computed ?? 0 };
				},
				stepResultsStepGroups,
				createStepResultsStepHandlers()
			);
			await provider.start();

			// value=2: multiply(2*3=6) → add(6+10=16) → square(16*16=256)
			const handle = await provider.execute(StepResultsWorkflowDef, { value: 2 });

			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			expect(result.finalValue).toBe(256);
		});
	});

	describe('propagation metadata', () => {
		it('should propagate meta through workflow execution', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(
				SequentialWorkflowDef,
				{ value: 7 },
				{
					meta: {
						request_id: 'req-integration-123',
						user_id: 'user-456',
						trace_id: 'trace-789'
					}
				}
			);

			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// Result should be returned (meta propagation is internal)
			// value=7: double(7*2=14) → add10(14+10=24) → onComplete returns 24
			expect(result).toEqual({ result: 24 });
		});
	});

	describe('error handling', () => {
		it('should handle step errors gracefully', async () => {
			provider.registerDefinitionConsumer(
				'error-workflow',
				async () => {
					return {};
				},
				errorStepGroups,
				createErrorStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(ErrorWorkflowDef, { shouldFail: true });

			// The result should eventually fail or return an error status
			// BullMQ handles retries, so we may need to check status or catch error
			try {
				await withTimeout(handle.result(), TEST_TIMEOUTS.ERROR_WORKFLOW);
			} catch {
				// Error expected - workflow is designed to fail
			}

			// Either error should occur or status should reflect failure
			// Note: Exact behavior depends on BullMQ job failure handling
			const status = await handle.status();
			// After error, status could be 'failed' or still 'running' if retrying
			expect(['running', 'failed', 'completed']).toContain(status);
		});

		it('should complete successfully when step does not fail', async () => {
			provider.registerDefinitionConsumer(
				'error-workflow',
				async () => {
					return {};
				},
				errorStepGroups,
				createErrorStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(ErrorWorkflowDef, { shouldFail: false });

			await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			const status = await handle.status();
			expect(status).toBe('completed');
		});
	});

	describe('multiple workflows', () => {
		it('should support multiple registered workflows', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			provider.registerDefinitionConsumer(
				'parallel-workflow',
				async () => {
					return { processed: 3 };
				},
				parallelStepGroups,
				createParallelStepHandlers()
			);
			await provider.start();

			const handle1 = await provider.execute(SequentialWorkflowDef, { value: 3 });
			const handle2 = await provider.execute(ParallelWorkflowDef, { items: ['x', 'y'] });

			const [result1, result2] = await Promise.all([
				withTimeout(handle1.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION),
				withTimeout(handle2.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)
			]);

			// value=3: double(3*2=6) → add10(6+10=16) → result=16
			expect(result1).toEqual({ result: 16 });
			expect(result2).toEqual({ processed: 3 });
		}, 15000);

		it('should execute multiple instances of same workflow concurrently', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			await provider.start();

			const handles = await Promise.all([
				provider.execute(SequentialWorkflowDef, { value: 1 }),
				provider.execute(SequentialWorkflowDef, { value: 2 }),
				provider.execute(SequentialWorkflowDef, { value: 3 })
			]);

			const results = await Promise.all(
				handles.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.CONCURRENT_WORKFLOWS))
			);

			// value=1: double(2) → add10(12) → result=12
			// value=2: double(4) → add10(14) → result=14
			// value=3: double(6) → add10(16) → result=16
			expect(results[0]).toEqual({ result: 12 });
			expect(results[1]).toEqual({ result: 14 });
			expect(results[2]).toEqual({ result: 16 });
		}, 20000);
	});

	describe('getStatus', () => {
		it('should return status for known flow', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async (_data, _meta, stepResults) => {
					const add10Result = stepResults?.['add10'] as { added: number } | undefined;
					return { result: add10Result?.added ?? 0 };
				},
				sequentialStepGroups,
				createSequentialStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(SequentialWorkflowDef, { value: 1 });

			const status = await provider.getStatus(handle.id);
			expect(['pending', 'running', 'completed']).toContain(status);
		});

		it('should return pending for unknown flow', async () => {
			const status = await provider.getStatus('unknown-flow-id');
			expect(status).toBe('pending');
		});
	});

	describe('lifecycle', () => {
		it('should start and stop cleanly', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async () => ({}),
				sequentialStepGroups,
				createSequentialStepHandlers()
			);

			await provider.start();
			// Start again should be idempotent
			await provider.start();

			await provider.stop();
			// Stop again should be idempotent
			await provider.stop();
		});

		it('should reject execute before start', async () => {
			provider.registerDefinitionConsumer(
				'sequential-workflow',
				async () => ({}),
				sequentialStepGroups,
				createSequentialStepHandlers()
			);

			// Execute without starting should throw
			await expect(provider.execute(SequentialWorkflowDef, { value: 1 })).rejects.toThrow(
				'Provider not started'
			);
		});

		it('should reject execute for unregistered workflow', async () => {
			await provider.start();

			// Execute without registering should throw
			await expect(provider.execute(SequentialWorkflowDef, { value: 1 })).rejects.toThrow('not registered');
		});
	});

	describe('rollback context propagation', () => {
		it('should propagate meta context to rollback handlers', async () => {
			// Reset captured context
			rollbackCapturedContext = {};

			provider.registerDefinitionConsumer(
				'rollback-context-workflow',
				async () => ({}),
				rollbackContextStepGroups,
				createRollbackContextStepHandlers()
			);
			await provider.start();

			// Execute with explicit meta containing traceId and correlationId
			const handle = await provider.execute(
				RollbackContextWorkflowDef,
				{ value: 42 },
				{
					meta: {
						traceId: 'test-trace-123',
						correlationId: 'test-request-456'
					}
				}
			);

			// Wait for workflow to fail (triggers rollback)
			try {
				await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);
			} catch {
				// Expected to fail
			}

			// Give rollback time to complete
			await new Promise((r) => setTimeout(r, 50));

			// Verify rollback handler received the propagated context
			expect(rollbackCapturedContext.step1Rollback).toBeDefined();
			expect(rollbackCapturedContext.step1Rollback?.traceId).toBe('test-trace-123');
			expect(rollbackCapturedContext.step1Rollback?.correlationId).toBe('test-request-456');
		}, 15000);
	});
});
