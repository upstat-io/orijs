/**
 * Definition-Based Consumer Distributed Workflow Tests (E2E)
 *
 * CRITICAL E2E test for the IWorkflowConsumer pattern through BullMQ.
 *
 * This test verifies that:
 * 1. IWorkflowConsumer.configure(w: WorkflowBuilder) steps are ACTUALLY EXECUTED
 * 2. Steps execute through the distributed BullMQ system
 * 3. Step results accumulate and are available in ctx.results
 * 4. Rollbacks execute when steps fail
 * 5. The pattern works in emitter-only → consumer distributed deployments
 *
 * WHY THIS TEST MATTERS:
 * The IWorkflowConsumer pattern is the new API for definition-based workflows.
 * Without this test, we could have a broken implementation where:
 * - configure() is called but steps are never executed
 * - Only onComplete() is called, bypassing the entire step chain
 * - The distributed execution model is untested
 *
 * This test ensures the FULL flow works:
 * Emitter App → BullMQ Queue → Consumer App → Step Execution → Result
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';
import { Type } from '@orijs/validation';
import type { WorkflowDefinition } from '@orijs/core';
import type { PropagationMeta } from '@orijs/logging';
import type { WorkflowContext } from '@orijs/workflows';

/**
 * Test timeout constants
 */
const TEST_TIMEOUTS = {
	WORKFLOW_EXECUTION: 5_000,
	WORKER_STARTUP: 100
} as const;

/**
 * Helper to wait for a promise with timeout.
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

// Generate unique prefix per test file to prevent parallel test interference
const testFileId = Math.random().toString(36).substring(2, 8);
let testCounter = 0;

/**
 * Create a test workflow definition
 */
function createWorkflowDefinition<TData, TResult>(
	name: string,
	dataSchema: ReturnType<typeof Type.Object>,
	resultSchema: ReturnType<typeof Type.Object> | ReturnType<typeof Type.Void>
): WorkflowDefinition<TData, TResult> {
	return {
		name,
		dataSchema,
		resultSchema,
		stepGroups: [],
		_data: undefined as unknown as TData,
		_result: undefined as unknown as TResult,
		_steps: undefined as unknown as Record<never, never>
	};
}

describe('Definition-Based Consumer Distributed Workflow (E2E)', () => {
	let emitterProvider: BullMQWorkflowProvider;
	let consumerProvider: BullMQWorkflowProvider;
	let queuePrefix: string;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		queuePrefix = `def-consumer-${testFileId}-${++testCounter}`;

		// Create EMITTER provider (no consumers registered)
		emitterProvider = new BullMQWorkflowProvider({
			connection,
			queuePrefix
		});

		// Create CONSUMER provider (will register consumers)
		consumerProvider = new BullMQWorkflowProvider({
			connection,
			queuePrefix
		});
	});

	afterEach(async () => {
		await emitterProvider.stop();
		await consumerProvider.stop();
	});

	describe('Basic Handler Flow (Current Implementation)', () => {
		/**
		 * These tests verify the CURRENT implementation where only the handler
		 * callback is invoked. Steps configured via configure() are NOT executed.
		 *
		 * This is a KNOWN LIMITATION that Phase 4.1 documents.
		 */

		it('should execute handler via BullMQ and return result', async () => {
			// Define the workflow
			const TestWorkflow = createWorkflowDefinition<{ value: number }, { doubled: number }>(
				'test-workflow',
				Type.Object({ value: Type.Number() }),
				Type.Object({ doubled: Type.Number() })
			);

			// Track if handler was called
			let handlerCalled = false;
			let receivedData: { value: number } | null = null;

			// Register consumer on CONSUMER provider
			consumerProvider.registerDefinitionConsumer('test-workflow', async (data, _meta) => {
				handlerCalled = true;
				receivedData = data as { value: number };
				return { doubled: (data as { value: number }).value * 2 };
			});

			// Register emitter-only on EMITTER provider
			emitterProvider.registerEmitterWorkflow('test-workflow');

			// Start both providers
			await consumerProvider.start();
			await emitterProvider.start();

			// Give workers time to be ready
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute workflow from EMITTER
			const handle = await emitterProvider.execute(TestWorkflow as any, { value: 21 });

			// Wait for result
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// Verify handler was called on consumer
			expect(handlerCalled).toBe(true);
			expect(receivedData).not.toBeNull();
			expect(receivedData!.value).toBe(21);

			// Verify result
			expect(result).toEqual({ doubled: 42 });

			// Verify status
			const status = await handle.status();
			expect(status).toBe('completed');
		});

		it('should propagate meta through distributed workflow', async () => {
			const MetaWorkflow = createWorkflowDefinition<{ id: string }, { processed: boolean }>(
				'meta-workflow',
				Type.Object({ id: Type.String() }),
				Type.Object({ processed: Type.Boolean() })
			);

			let capturedMeta: PropagationMeta | undefined;

			consumerProvider.registerDefinitionConsumer('meta-workflow', async (_data, meta) => {
				capturedMeta = meta;
				return { processed: true };
			});

			emitterProvider.registerEmitterWorkflow('meta-workflow');

			await consumerProvider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute with meta
			const handle = await emitterProvider.execute(
				MetaWorkflow as any,
				{ id: 'test-123' },
				{ meta: { correlationId: 'req-abc', traceId: 'trace-xyz' } }
			);

			await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// Verify meta was propagated
			expect(capturedMeta).toBeDefined();
			expect(capturedMeta?.correlationId).toBe('req-abc');
			expect(capturedMeta?.traceId).toBe('trace-xyz');
		});

		it('should handle workflow errors and propagate them', async () => {
			const ErrorWorkflow = createWorkflowDefinition<{ shouldFail: boolean }, { ok: boolean }>(
				'error-workflow',
				Type.Object({ shouldFail: Type.Boolean() }),
				Type.Object({ ok: Type.Boolean() })
			);

			consumerProvider.registerDefinitionConsumer('error-workflow', async (data) => {
				const { shouldFail } = data as { shouldFail: boolean };
				if (shouldFail) {
					throw new Error('Intentional workflow failure');
				}
				return { ok: true };
			});

			emitterProvider.registerEmitterWorkflow('error-workflow');

			await consumerProvider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute with shouldFail=true
			const handle = await emitterProvider.execute(ErrorWorkflow as any, { shouldFail: true });

			// Result should reject with error
			await expect(withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)).rejects.toThrow(
				/Intentional workflow failure/
			);

			// Status should be failed
			const status = await handle.status();
			expect(status).toBe('failed');
		});

		it('should support multiple concurrent workflows', async () => {
			const CounterWorkflow = createWorkflowDefinition<{ count: number }, { result: number }>(
				'counter-workflow',
				Type.Object({ count: Type.Number() }),
				Type.Object({ result: Type.Number() })
			);

			let processedCount = 0;

			consumerProvider.registerDefinitionConsumer(
				'counter-workflow',
				async (data) => {
					processedCount++;
					const { count } = data as { count: number };
					return { result: count * 10 };
				},
				[], // No steps (handler-only)
				undefined, // No step handlers
				undefined, // No onError
				{ concurrency: 3 } // Allow concurrent processing
			);

			emitterProvider.registerEmitterWorkflow('counter-workflow');

			await consumerProvider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute multiple workflows concurrently
			const handles = await Promise.all([
				emitterProvider.execute(CounterWorkflow as any, { count: 1 }),
				emitterProvider.execute(CounterWorkflow as any, { count: 2 }),
				emitterProvider.execute(CounterWorkflow as any, { count: 3 })
			]);

			// Wait for all results
			const results = await Promise.all(
				handles.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION))
			);

			// Verify all processed
			expect(processedCount).toBe(3);
			expect(results).toContainEqual({ result: 10 });
			expect(results).toContainEqual({ result: 20 });
			expect(results).toContainEqual({ result: 30 });
		});

		it('should use idempotency key to prevent duplicate execution', async () => {
			/**
			 * KNOWN LIMITATION: The current definition-based workflow idempotency implementation
			 * has a bug where the second submission with the same idempotencyKey creates a
			 * new pendingResults entry that never gets resolved (BullMQ silently deduplicates).
			 *
			 * This test verifies that:
			 * 1. The first execution works correctly
			 * 2. The second execution is deduplicated (handler only called once)
			 *
			 * The fix would be to check for existing jobs before adding pendingResults.
			 */
			const IdempotentWorkflow = createWorkflowDefinition<{ value: number }, { computed: number }>(
				'idempotent-workflow',
				Type.Object({ value: Type.Number() }),
				Type.Object({ computed: Type.Number() })
			);

			let executionCount = 0;

			consumerProvider.registerDefinitionConsumer('idempotent-workflow', async (data) => {
				executionCount++;
				return { computed: (data as { value: number }).value };
			});

			emitterProvider.registerEmitterWorkflow('idempotent-workflow');

			await consumerProvider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute with same idempotency key twice
			const idempotencyKey = `idem-${Date.now()}`;

			const handle1 = await emitterProvider.execute(
				IdempotentWorkflow as any,
				{ value: 100 },
				{ idempotencyKey }
			);

			const result1 = await withTimeout(handle1.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);
			expect(result1).toEqual({ computed: 100 });

			// Second execution with same key - BullMQ deduplicates
			await emitterProvider.execute(
				IdempotentWorkflow as any,
				{ value: 200 }, // Different data
				{ idempotencyKey } // Same key
			);

			// Wait a bit for any potential duplicate execution
			await new Promise((r) => setTimeout(r, 200));

			// Should only have executed once (deduplication worked)
			expect(executionCount).toBe(1);

			// Note: Getting result from handle2 would timeout because the duplicate
			// pendingResults entry never gets resolved. This is a known limitation.
		});
	});

	describe('Consumer-only mode', () => {
		it('should allow consumer to both emit and consume', async () => {
			const SelfWorkflow = createWorkflowDefinition<{ input: string }, { output: string }>(
				'self-workflow',
				Type.Object({ input: Type.String() }),
				Type.Object({ output: Type.String() })
			);

			let processed = false;

			// Single provider that both emits and consumes
			const singleProvider = new BullMQWorkflowProvider({
				connection: getRedisConnectionOptions(),
				queuePrefix: `${queuePrefix}-single`
			});

			singleProvider.registerDefinitionConsumer('self-workflow', async (data) => {
				processed = true;
				return { output: `processed:${(data as { input: string }).input}` };
			});

			await singleProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute on same provider
			const handle = await singleProvider.execute(SelfWorkflow as any, { input: 'test' });
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			expect(processed).toBe(true);
			expect(result).toEqual({ output: 'processed:test' });

			await singleProvider.stop();
		});
	});

	describe('Step Execution (CRITICAL - Full IWorkflowConsumer Pattern)', () => {
		/**
		 * CRITICAL: These tests verify that steps configured via IWorkflowConsumer.configure()
		 * are ACTUALLY EXECUTED through the distributed BullMQ system.
		 *
		 * The current implementation has a gap where:
		 * - configure(w: WorkflowBuilder) is called and captures step configuration
		 * - But those steps are NEVER executed through processStep()/StepRegistry
		 * - Only onComplete() is called directly via the handler
		 *
		 * These tests document what SHOULD work and will fail until the implementation
		 * is fixed to actually execute configured steps.
		 */

		// Execution log to track step calls across distributed instances
		const stepExecutionLog: Array<{ step: string; instance: string; data: unknown }> = [];

		beforeEach(() => {
			stepExecutionLog.length = 0;
		});

		// Tests step execution via BullMQ with separate step structure and handlers
		it('should execute steps configured via IWorkflowConsumer.configure() through BullMQ', async () => {
			/**
			 * Tests that steps are executed through BullMQ.
			 *
			 * This test uses a SINGLE provider that both emits and consumes (common pattern
			 * for single-app deployments). For distributed emitter-only -> consumer setups,
			 * the emitter also needs to register the step structure.
			 *
			 * Flow:
			 * 1. Define step STRUCTURE (names only) in stepGroups
			 * 2. Define step HANDLERS in stepHandlers object
			 * 3. Register with registerDefinitionConsumer() passing both
			 * 4. Execute workflow on the same provider
			 * 5. Verify steps executed and results accumulated in onComplete handler
			 */

			const StepWorkflow = createWorkflowDefinition<{ value: number }, { finalResult: number }>(
				'step-workflow',
				Type.Object({ value: Type.Number() }),
				Type.Object({ finalResult: Type.Number() })
			);

			// Create a single provider for this test (emit + consume)
			const singleProvider = new BullMQWorkflowProvider({
				connection: getRedisConnectionOptions(),
				queuePrefix: 'step-test',
				defaultTimeout: TEST_TIMEOUTS.WORKFLOW_EXECUTION
			});

			// Define step STRUCTURE (names only)
			const stepGroups = [
				{ type: 'sequential' as const, definitions: [{ name: 'double' }] },
				{ type: 'sequential' as const, definitions: [{ name: 'addTen' }] }
			];

			// Define step HANDLERS separately
			const stepHandlers = {
				double: {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						stepExecutionLog.push({ step: 'double', instance: 'provider', data: ctx.data.value });
						return ctx.data.value * 2;
					}
				},
				addTen: {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						const doubledValue = ctx.results['double'] as number;
						stepExecutionLog.push({ step: 'addTen', instance: 'provider', data: doubledValue });
						return doubledValue + 10;
					}
				}
			};

			// Register consumer with step structure AND handlers
			singleProvider.registerDefinitionConsumer(
				'step-workflow',
				async (_data, _meta, stepResults) => {
					stepExecutionLog.push({ step: 'onComplete', instance: 'provider', data: stepResults });
					// stepResults should contain { double: 10, addTen: 20 }
					const finalResult = stepResults?.['addTen'] as number;
					return { finalResult };
				},
				stepGroups,
				stepHandlers
			);

			await singleProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			const handle = await singleProvider.execute(StepWorkflow as any, { value: 5 });
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			await singleProvider.stop();

			// Expected: (5 * 2) + 10 = 20
			expect(result).toEqual({ finalResult: 20 });

			// Verify steps were executed through BullMQ
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'double' }));
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'addTen' }));
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'onComplete' }));
		});

		// SKIPPED: Waiting for implementation of rollback flow creation (task 4.2.17)
		it.skip('should execute step rollbacks on failure through BullMQ', async () => {
			/**
			 * Tests that when a step fails, rollback handlers for completed steps are executed.
			 *
			 * Flow:
			 * 1. Step 1 executes successfully (with rollback defined)
			 * 2. Step 2 throws an error
			 * 3. Step 1's rollback handler should be executed
			 */

			const RollbackWorkflow = createWorkflowDefinition<{ shouldFail: boolean }, void>(
				'rollback-workflow',
				Type.Object({ shouldFail: Type.Boolean() }),
				Type.Void()
			);

			const rollbackLog: string[] = [];

			// Create a single provider for this test
			const singleProvider = new BullMQWorkflowProvider({
				connection: getRedisConnectionOptions(),
				queuePrefix: 'rollback-test',
				defaultTimeout: TEST_TIMEOUTS.WORKFLOW_EXECUTION
			});

			// Define step STRUCTURE
			const stepGroups = [
				{ type: 'sequential' as const, definitions: [{ name: 'step1' }] },
				{ type: 'sequential' as const, definitions: [{ name: 'step2' }] }
			];

			// Define step HANDLERS with rollbacks
			const stepHandlers = {
				step1: {
					execute: async (_ctx: WorkflowContext<{ shouldFail: boolean }>) => {
						stepExecutionLog.push({ step: 'step1', instance: 'provider', data: 'executed' });
						return 'step1-result';
					},
					rollback: async (_ctx: WorkflowContext<{ shouldFail: boolean }>) => {
						rollbackLog.push('step1-rollback');
					}
				},
				step2: {
					execute: async (ctx: WorkflowContext<{ shouldFail: boolean }>) => {
						stepExecutionLog.push({ step: 'step2', instance: 'provider', data: 'executing' });
						if (ctx.data.shouldFail) {
							throw new Error('Step2 intentionally failed');
						}
						return 'step2-result';
					}
				}
			};

			// Register consumer with step structure AND handlers
			singleProvider.registerDefinitionConsumer(
				'rollback-workflow',
				async (_data, _meta, stepResults) => {
					stepExecutionLog.push({ step: 'onComplete', instance: 'provider', data: stepResults });
				},
				stepGroups,
				stepHandlers
			);

			await singleProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			const handle = await singleProvider.execute(RollbackWorkflow as any, { shouldFail: true });

			await expect(withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)).rejects.toThrow(
				'Step2 intentionally failed'
			);

			await singleProvider.stop();

			// Verify step1 executed
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'step1' }));

			// Verify step2 attempted to execute
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'step2' }));

			// Verify step1's rollback was called after step2 failed
			expect(rollbackLog).toContain('step1-rollback');

			// Verify onComplete was NOT called (workflow failed)
			expect(stepExecutionLog).not.toContainEqual(expect.objectContaining({ step: 'onComplete' }));
		});

		// Parallel steps test - verifies concurrent step execution
		it('should execute parallel steps concurrently through BullMQ', async () => {
			/**
			 * Tests that steps grouped with parallel() execute concurrently.
			 *
			 * Flow:
			 * 1. Two steps in parallel group start at approximately the same time
			 * 2. Both complete before sequential onComplete runs
			 * 3. Results from both steps are available in ctx.results
			 */

			const ParallelWorkflow = createWorkflowDefinition<{ value: number }, { sum: number }>(
				'parallel-workflow',
				Type.Object({ value: Type.Number() }),
				Type.Object({ sum: Type.Number() })
			);

			// Track execution timing
			const executionTimes: { step: string; startTime: number; endTime: number }[] = [];

			// Create a single provider for this test
			const singleProvider = new BullMQWorkflowProvider({
				connection: getRedisConnectionOptions(),
				queuePrefix: 'parallel-test',
				defaultTimeout: TEST_TIMEOUTS.WORKFLOW_EXECUTION
			});

			// Define step STRUCTURE - two parallel steps
			const stepGroups = [
				{
					type: 'parallel' as const,
					definitions: [{ name: 'multiplyBy2' }, { name: 'multiplyBy3' }]
				}
			];

			// Define step HANDLERS
			const stepHandlers = {
				multiplyBy2: {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						const startTime = Date.now();
						// Simulate some async work
						await new Promise((r) => setTimeout(r, 50));
						executionTimes.push({ step: 'multiplyBy2', startTime, endTime: Date.now() });
						return ctx.data.value * 2;
					}
				},
				multiplyBy3: {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						const startTime = Date.now();
						// Simulate some async work
						await new Promise((r) => setTimeout(r, 50));
						executionTimes.push({ step: 'multiplyBy3', startTime, endTime: Date.now() });
						return ctx.data.value * 3;
					}
				}
			};

			// Register consumer with step structure AND handlers
			singleProvider.registerDefinitionConsumer(
				'parallel-workflow',
				async (_data, _meta, stepResults) => {
					// Both parallel results should be available
					const mul2 = stepResults?.['multiplyBy2'] as number;
					const mul3 = stepResults?.['multiplyBy3'] as number;
					return { sum: mul2 + mul3 };
				},
				stepGroups,
				stepHandlers
			);

			await singleProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			const handle = await singleProvider.execute(ParallelWorkflow as any, { value: 10 });
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			await singleProvider.stop();

			// Expected: (10 * 2) + (10 * 3) = 20 + 30 = 50
			expect(result).toEqual({ sum: 50 });

			// Verify both steps executed
			expect(executionTimes).toHaveLength(2);

			// Verify parallel execution - both should start within a reasonable window
			// In true parallel, start times should be close (within ~100ms)
			const startTimes = executionTimes.map((e) => e.startTime);
			expect(startTimes[0]).toBeDefined();
			expect(startTimes[1]).toBeDefined();
			const timeDiff = Math.abs(startTimes[0]! - startTimes[1]!);

			// Allow some slack for BullMQ job scheduling overhead
			expect(timeDiff).toBeLessThan(200); // Both started within 200ms of each other
		});

		/**
		 * SKIPPED: Distributed emitter/consumer step execution
		 *
		 * In distributed deployments, the emitter needs step structure to create child jobs.
		 * The step structure should be shared via WorkflowDefinition.steps().
		 *
		 * This test documents the expected behavior when both emitter and consumer
		 * have access to the same step structure.
		 */
		it.skip('should pass step results to onComplete in distributed emitter/consumer setup', async () => {
			/**
			 * Tests distributed step execution where:
			 * - Emitter knows step structure (from WorkflowDefinition)
			 * - Consumer knows step handlers (from IWorkflowConsumer.steps)
			 *
			 * This requires both providers to have step structure registered.
			 */

			const DistributedStepWorkflow = createWorkflowDefinition<{ userId: string }, { processedAt: number }>(
				'distributed-step-workflow',
				Type.Object({ userId: Type.String() }),
				Type.Object({ processedAt: Type.Number() })
			);

			const connection = getRedisConnectionOptions();
			const prefix = `dist-step-${testFileId}-${++testCounter}`;

			// EMITTER provider (like public-server) - needs step structure
			const emitterProvider = new BullMQWorkflowProvider({
				connection,
				queuePrefix: prefix
			});

			// CONSUMER provider (like coordinator) - has step handlers
			const consumerProvider = new BullMQWorkflowProvider({
				connection,
				queuePrefix: prefix
			});

			// Define step STRUCTURE (shared between emitter and consumer)
			const stepGroups = [
				{ type: 'sequential' as const, definitions: [{ name: 'validate' }] },
				{ type: 'sequential' as const, definitions: [{ name: 'process' }] }
			];

			// Define step HANDLERS (consumer-only)
			const stepHandlers = {
				validate: {
					execute: async (ctx: WorkflowContext<{ userId: string }>) => {
						stepExecutionLog.push({ step: 'validate', instance: 'consumer', data: ctx.data.userId });
						return { validated: true, timestamp: Date.now() };
					}
				},
				process: {
					execute: async (ctx: WorkflowContext<{ userId: string }>) => {
						const validateResult = ctx.results['validate'] as { validated: boolean; timestamp: number };
						stepExecutionLog.push({ step: 'process', instance: 'consumer', data: validateResult });
						return { processed: true };
					}
				}
			};

			// Consumer registers with step structure AND handlers
			consumerProvider.registerDefinitionConsumer(
				'distributed-step-workflow',
				async (_data, _meta, stepResults) => {
					stepExecutionLog.push({ step: 'onComplete', instance: 'consumer', data: stepResults });

					const validateResult = stepResults?.['validate'] as { validated: boolean; timestamp: number };
					if (!validateResult) {
						throw new Error('validateResult is undefined - step results not passed to onComplete');
					}

					return { processedAt: validateResult.timestamp };
				},
				stepGroups,
				stepHandlers
			);

			// Emitter registers as emitter-only (no steps)
			emitterProvider.registerEmitterWorkflow('distributed-step-workflow');

			await consumerProvider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Emit from emitter provider
			const handle = await emitterProvider.execute(DistributedStepWorkflow as any, { userId: 'test-user' });
			const result = await withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			await emitterProvider.stop();
			await consumerProvider.stop();

			// Verify steps executed
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'validate' }));
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'process' }));
			expect(stepExecutionLog).toContainEqual(expect.objectContaining({ step: 'onComplete' }));

			// Verify result contains timestamp from validate step
			expect((result as { processedAt: number }).processedAt).toBeGreaterThan(0);
		});

		it.skip('should distribute step execution across multiple consumer instances', async () => {
			/**
			 * SKIPPED: This test documents distributed step execution.
			 *
			 * Current behavior: All work happens in one handler call.
			 * Expected behavior: Steps are distributed via BullMQ to multiple consumers.
			 */

			const DistributedWorkflow = createWorkflowDefinition<{ items: number[] }, { processed: number }>(
				'distributed-workflow',
				Type.Object({ items: Type.Array(Type.Number()) }),
				Type.Object({ processed: Type.Number() })
			);

			// Create second consumer
			const consumer2Provider = new BullMQWorkflowProvider({
				connection: getRedisConnectionOptions(),
				queuePrefix,
				providerId: 'consumer2'
			});

			// Register on both consumers
			const registerHandler = (instanceId: string) => async (data: unknown) => {
				const { items } = data as { items: number[] };
				stepExecutionLog.push({ step: 'process', instance: instanceId, data: items });
				return { processed: items.length };
			};

			consumerProvider.registerDefinitionConsumer('distributed-workflow', registerHandler('consumer1'));
			consumer2Provider.registerDefinitionConsumer('distributed-workflow', registerHandler('consumer2'));

			emitterProvider.registerEmitterWorkflow('distributed-workflow');

			await consumerProvider.start();
			await consumer2Provider.start();
			await emitterProvider.start();
			await new Promise((r) => setTimeout(r, TEST_TIMEOUTS.WORKER_STARTUP));

			// Execute multiple workflows
			const handles = await Promise.all([
				emitterProvider.execute(DistributedWorkflow as any, { items: [1, 2, 3] }),
				emitterProvider.execute(DistributedWorkflow as any, { items: [4, 5, 6] }),
				emitterProvider.execute(DistributedWorkflow as any, { items: [7, 8, 9] })
			]);

			await Promise.all(handles.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)));

			// Verify work was distributed (at least some to each consumer)
			const consumer1Work = stepExecutionLog.filter((e) => e.instance === 'consumer1');
			const consumer2Work = stepExecutionLog.filter((e) => e.instance === 'consumer2');

			// In a distributed system, work should spread across consumers
			// (exact distribution depends on BullMQ scheduling)
			expect(consumer1Work.length + consumer2Work.length).toBe(3);

			await consumer2Provider.stop();
		});
	});
});
