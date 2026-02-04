/**
 * WorkflowProvider Contract Tests
 *
 * Shared test suite that runs against the WorkflowProvider interface.
 * All workflow provider implementations must pass these tests.
 *
 * This ensures feature parity across providers and catches gaps like missing
 * rollback implementation.
 *
 * Uses definition-based workflow API.
 *
 * @module contract/workflow-provider.contract
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { WorkflowProvider } from '../../src/workflow.types.ts';
import { WorkflowStepError } from '../../src/workflow.types.ts';
import { WorkflowTimeoutError } from '../../src/in-process-workflow-provider.ts';
import type { TestOrderData, ExecutionLog, DefinitionWorkflowConfig } from './workflows/index';
import { createMockDefinition } from './workflows/definition-types';
import { Logger } from '@orijs/logging';

// Execution workflows
import {
	createSequentialWorkflow,
	createAccumulatingWorkflow,
	createParallelWorkflow,
	createParallelAccumulatingWorkflow,
	createMixedWorkflow
} from './workflows/execution-workflows';

// Error workflows
import {
	createErrorCallbackWorkflow,
	createPartialResultsWorkflow,
	createStepErrorWorkflow
} from './workflows/error-workflows';

// Rollback workflows
import {
	createBasicRollbackWorkflow,
	createNoSelfRollbackWorkflow,
	createRollbackErrorWorkflow,
	createMixedRollbackWorkflow,
	createSuccessfulWorkflow,
	createParallelRollbackWorkflow,
	createMixedGroupRollbackWorkflow,
	createContextRollbackWorkflow,
	createFirstStepFailWorkflow
} from './workflows/rollback-workflows';

// Timeout workflows
import {
	createFastWorkflow,
	createSlowWorkflow,
	createSlowSuccessWorkflow
} from './workflows/timeout-workflows';

// Context workflows
import {
	createLoggerCheckWorkflow,
	createOnCompleteLoggerWorkflow,
	createOnErrorLoggerWorkflow,
	createMultiStepLoggerWorkflow,
	createContextCheckWorkflow,
	createOnCompleteContextWorkflow,
	createOnErrorContextWorkflow,
	createParallelContextWorkflow
} from './workflows/context-workflows';

/**
 * Provider configuration options.
 */
export interface ProviderConfig {
	/** Default workflow timeout in milliseconds */
	timeoutMs?: number;
	/** Logger to use for workflows */
	logger?: Logger;
}

/**
 * Configuration for contract tests.
 */
export interface ContractTestConfig {
	/** Factory to create a fresh provider instance with default config */
	createProvider: () => Promise<WorkflowProvider>;
	/** Factory to create a provider with custom config (for timeout/logger tests) */
	createProviderWithConfig: (config: ProviderConfig) => Promise<WorkflowProvider>;
	/** Cleanup after all tests */
	cleanup: () => Promise<void>;
	/** Provider name for test descriptions */
	providerName: string;
	/** Timeout for async operations (ms) - distributed providers may need longer */
	timeout?: number;
	/**
	 * Additional time (ms) the provider adds to user-specified timeouts.
	 *
	 * For distributed providers, the effective timeout is typically:
	 * effectiveTimeout = userTimeout + stallInterval (for worker crash recovery)
	 *
	 * This allows timeout contract tests to set workflows that exceed the effective timeout.
	 * @default 0
	 */
	timeoutOverhead?: number;
}

/**
 * Helper to register and execute a definition-based workflow.
 */
function registerAndGetDefinition<TData, TResult>(
	provider: WorkflowProvider,
	config: DefinitionWorkflowConfig<TData, TResult>
) {
	// Register the consumer with onError if provided
	provider.registerDefinitionConsumer!(
		config.name,
		config.onComplete as (
			data: unknown,
			meta?: unknown,
			stepResults?: Record<string, unknown>
		) => Promise<unknown>,
		config.stepGroups,
		config.stepHandlers as Record<
			string,
			{ execute: (ctx: unknown) => Promise<unknown>; rollback?: (ctx: unknown) => Promise<void> }
		>,
		config.onError as
			| ((
					data: unknown,
					meta?: unknown,
					error?: Error,
					stepResults?: Record<string, unknown>
			  ) => Promise<void>)
			| undefined
	);

	// Return mock definition for execute()
	return createMockDefinition(config);
}

/**
 * Runs the complete WorkflowProvider contract test suite.
 *
 * @example
 * ```typescript
 * // For InProcessWorkflowProvider
 * workflowProviderContractTests({
 *   providerName: 'InProcessWorkflowProvider',
 *   createProvider: async () => new InProcessWorkflowProvider(),
 *   cleanup: async () => {},
 * });
 *
 * // For a distributed provider
 * workflowProviderContractTests({
 *   providerName: 'DistributedWorkflowProvider',
 *   createProvider: async () => {
 *     const provider = new DistributedWorkflowProvider({ connection: redisOptions });
 *     return provider;
 *   },
 *   cleanup: async () => { ... },
 *   timeout: 10000,
 * });
 * ```
 */
export function workflowProviderContractTests(config: ContractTestConfig): void {
	const {
		createProvider,
		createProviderWithConfig,
		cleanup,
		providerName,
		timeout = 5000,
		timeoutOverhead = 0
	} = config;

	describe(`WorkflowProvider Contract: ${providerName}`, () => {
		let provider: WorkflowProvider;

		beforeAll(async () => {
			provider = await createProvider();
		}, 30000);

		afterAll(async () => {
			await provider.stop();
			await cleanup();
		}, 30000);

		// ============================================================
		// SEQUENTIAL EXECUTION
		// ============================================================
		describe('sequential execution', () => {
			it(
				'should execute steps in order',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createSequentialWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-001',
						amount: 100
					});

					const result = await handle.result();

					expect(result).toBe('completed');
					expect(executionLog).toEqual(['step1', 'step2', 'step3', 'onComplete']);
				},
				timeout
			);

			it(
				'should accumulate step results (Q4)',
				async () => {
					const capturedResults = { value: {} as Record<string, unknown> };
					const workflowConfig = createAccumulatingWorkflow(capturedResults);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-002', amount: 50 });
					await handle.result();

					expect(capturedResults.value['validate']).toEqual({ isValid: true });
					expect(capturedResults.value['process']).toEqual({
						processed: true,
						reference: 'REF-123'
					});
					expect(capturedResults.value['notify']).toEqual({
						notified: true,
						channels: ['email', 'sms']
					});
				},
				timeout
			);
		});

		// ============================================================
		// PARALLEL EXECUTION
		// ============================================================
		describe('parallel execution', () => {
			it(
				'should execute parallel steps concurrently',
				async () => {
					const startTimes: Record<string, number> = {};
					const endTimes: Record<string, number> = {};
					const workflowConfig = createParallelWorkflow(startTimes, endTimes);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-003', amount: 75 });
					await handle.result();

					// Parallel tasks should start at nearly the same time (within 100ms for distributed)
					const startA = startTimes['task-a']!;
					const startB = startTimes['task-b']!;
					const startC = startTimes['task-c']!;

					// Use a wider tolerance for distributed systems
					expect(Math.abs(startA - startB)).toBeLessThan(100);
					expect(Math.abs(startB - startC)).toBeLessThan(100);
				},
				timeout
			);

			it(
				'should accumulate parallel step results',
				async () => {
					const capturedResults = { value: {} as Record<string, unknown> };
					const workflowConfig = createParallelAccumulatingWorkflow(capturedResults);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-004', amount: 25 });
					await handle.result();

					expect(capturedResults.value['email']).toEqual({ emailSent: true });
					expect(capturedResults.value['sms']).toEqual({ smsSent: true });
					expect(capturedResults.value['push']).toEqual({ pushSent: true });
				},
				timeout
			);
		});

		// ============================================================
		// MIXED EXECUTION
		// ============================================================
		describe('mixed sequential and parallel', () => {
			it(
				'should execute groups in order',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createMixedWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-005', amount: 200 });
					await handle.result();

					// init must come first
					expect(executionLog.indexOf('init')).toBe(0);

					// task-a and task-b come after init (order between them may vary)
					expect(executionLog.indexOf('task-a')).toBeGreaterThan(0);
					expect(executionLog.indexOf('task-b')).toBeGreaterThan(0);

					// finalize comes after parallel tasks
					expect(executionLog.indexOf('finalize')).toBeGreaterThan(executionLog.indexOf('task-a'));
					expect(executionLog.indexOf('finalize')).toBeGreaterThan(executionLog.indexOf('task-b'));

					// onComplete is last
					expect(executionLog.indexOf('onComplete')).toBe(executionLog.length - 1);
				},
				timeout
			);
		});

		// ============================================================
		// ERROR HANDLING
		// ============================================================
		describe('error handling', () => {
			it(
				'should call onError when step fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const capturedError = { value: null as Error | null };
					const workflowConfig = createErrorCallbackWorkflow(executionLog, capturedError);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-ERR-1', amount: 0 });

					await handle.result().catch(() => {});

					expect(executionLog).toContain('step1');
					expect(executionLog).toContain('step2');
					expect(executionLog).not.toContain('step3'); // Not reached
					expect(executionLog).toContain('onError');
					expect(capturedError.value).not.toBeNull();
				},
				timeout
			);

			it(
				'should preserve partial results on failure (Q3)',
				async () => {
					const capturedResults = { value: {} as Record<string, unknown> };
					const workflowConfig = createPartialResultsWorkflow(capturedResults);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-ERR-2', amount: 0 });

					await handle.result().catch(() => {});

					// step1 and step2 completed, step3 failed, step4 not reached
					expect(capturedResults.value['step1']).toEqual({ step1Result: 'first' });
					expect(capturedResults.value['step2']).toEqual({ step2Result: 'second' });
					expect(capturedResults.value['step3']).toBeUndefined();
					expect(capturedResults.value['step4']).toBeUndefined();
				},
				timeout
			);

			it(
				'should wrap errors in WorkflowStepError',
				async () => {
					const workflowConfig = createStepErrorWorkflow();
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-ERR-3', amount: 0 });

					const error = await handle.result().catch((e) => e);

					expect(error).toBeInstanceOf(WorkflowStepError);
					expect((error as WorkflowStepError).stepName).toBe('failing-step');
					expect((error as Error).message).toContain('failing-step');
				},
				timeout
			);
		});

		// ============================================================
		// ROLLBACK
		// ============================================================
		describe('rollback on step failure', () => {
			it(
				'should run rollbacks in reverse order when step fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createBasicRollbackWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-1',
						amount: 100
					});

					const error = await handle.result().catch((e) => e);
					expect(error).toBeInstanceOf(WorkflowStepError);
					expect((error as Error).message).toContain('ship');

					// Verify execution order: charge, reserve, ship (fails), then rollbacks in reverse
					expect(executionLog).toEqual([
						'charge-execute',
						'reserve-execute',
						'ship-execute',
						'reserve-rollback', // Last completed first
						'charge-rollback' // First completed last
					]);
				},
				timeout
			);

			it(
				'should not run rollback for the step that failed',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createNoSelfRollbackWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-2',
						amount: 0
					});

					await handle.result().catch(() => {});

					// step2's rollback should NOT run because step2 itself failed
					expect(executionLog).toEqual(['step1-execute', 'step2-execute', 'step1-rollback']);
				},
				timeout
			);

			it(
				'should continue other rollbacks even if one rollback fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createRollbackErrorWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-3',
						amount: 0
					});

					await handle.result().catch(() => {});

					// step2's rollback fails but step1's rollback should still run
					expect(executionLog).toEqual([
						'step1-execute',
						'step2-execute',
						'step3-execute',
						'step2-rollback-start', // Fails but continues
						'step1-rollback' // Still runs
					]);
				},
				timeout
			);

			it(
				'should work with steps that have no rollback handlers',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createMixedRollbackWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-4',
						amount: 0
					});

					await handle.result().catch(() => {});

					// Only steps with rollback handlers should have rollbacks run
					expect(executionLog).toEqual([
						'step1-execute',
						'step2-execute',
						'step3-execute',
						'step4-execute',
						'step3-rollback',
						'step1-rollback'
						// step2 has no rollback, so nothing for it
					]);
				},
				timeout
			);

			it(
				'should not run any rollbacks when all steps succeed',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createSuccessfulWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-5',
						amount: 0
					});

					const result = await handle.result();
					expect(result).toBe('success');

					// No rollbacks should run
					expect(executionLog).toEqual(['step1-execute', 'step2-execute', 'onComplete']);
				},
				timeout
			);

			it(
				'should rollback completed parallel steps when one fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createParallelRollbackWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-6',
						amount: 0
					});

					await handle.result().catch(() => {});

					// fast-success completes, slow-fail fails
					// Only fast-success should have rollback called
					expect(executionLog).toContain('fast-success-execute');
					expect(executionLog).toContain('slow-fail-execute');
					expect(executionLog).toContain('fast-success-rollback');
					expect(executionLog).not.toContain('slow-fail-rollback');
				},
				timeout
			);

			it(
				'should rollback steps from previous sequential group when parallel fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createMixedGroupRollbackWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-7',
						amount: 0
					});

					await handle.result().catch(() => {});

					// init and parallel-success should be rolled back
					expect(executionLog).toContain('init-execute');
					expect(executionLog).toContain('parallel-success-execute');
					expect(executionLog).toContain('parallel-fail-execute');
					expect(executionLog).toContain('parallel-success-rollback');
					expect(executionLog).toContain('init-rollback');
					expect(executionLog).not.toContain('parallel-fail-rollback');
				},
				timeout
			);

			it(
				'should pass workflow context to rollback handlers',
				async () => {
					const executionLog: ExecutionLog = [];
					const capturedContext = {
						data: null as TestOrderData | null,
						results: {} as Record<string, unknown>
					};
					const workflowConfig = createContextRollbackWorkflow(executionLog, capturedContext);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-CTX-ROLLBACK',
						amount: 999
					});

					await handle.result().catch(() => {});

					// Rollback handler should receive workflow context
					expect(capturedContext.data!.orderId).toBe('ORD-CTX-ROLLBACK');
					expect(capturedContext.data!.amount).toBe(999);
					expect(capturedContext.results['step1']).toEqual({ step1Result: 'value1' });
				},
				timeout
			);

			it(
				'should not run rollbacks when first step fails',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createFirstStepFailWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-ROLLBACK-8',
						amount: 0
					});

					await handle.result().catch(() => {});

					// No rollbacks should run because no steps completed successfully
					expect(executionLog).toEqual(['step1-execute']);
				},
				timeout
			);
		});

		// ============================================================
		// FLOW STATUS
		// ============================================================
		describe('flow status', () => {
			it(
				'should track status through lifecycle',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createSequentialWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-STATUS-1', amount: 0 });

					// Wait for completion
					await handle.result();

					const finalStatus = await handle.status();
					expect(finalStatus).toBe('completed');
				},
				timeout
			);

			it(
				'should return completed status after successful workflow',
				async () => {
					const executionLog: ExecutionLog = [];
					const workflowConfig = createSuccessfulWorkflow(executionLog);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, { orderId: 'ORD-STATUS-2', amount: 0 });

					await handle.result();

					const status = await handle.status();
					expect(status).toBe('completed');
				},
				timeout
			);
		});

		// ============================================================
		// WORKFLOW TIMEOUT
		// ============================================================
		describe('workflow execution timeout', () => {
			it(
				'should complete fast workflows without timeout',
				async () => {
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: 5000 });
					const workflowConfig = createFastWorkflow();
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-1',
							amount: 0
						});

						const result = await handle.result();
						expect(result).toBe('completed');
					} finally {
						await timeoutProvider.stop();
					}
				},
				timeout
			);

			it(
				'should timeout workflow that exceeds configured timeout',
				async () => {
					const userTimeout = 50;
					// Effective timeout includes overhead (e.g., distributed provider's stallInterval)
					const effectiveTimeout = userTimeout + timeoutOverhead;
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: userTimeout });

					// Workflow must take longer than effective timeout
					const workflowConfig = createSlowWorkflow(effectiveTimeout + 200);
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-2',
							amount: 0
						});

						const error = await handle.result().catch((e) => e);
						expect(error).toBeInstanceOf(WorkflowTimeoutError);
						expect((error as Error).message).toContain('timed out');

						const status = await handle.status();
						expect(status).toBe('failed');
					} finally {
						await timeoutProvider.stop();
					}
				},
				// Test needs enough time for timeout to fire
				Math.max(timeout, timeoutOverhead + 500)
			);

			it(
				'should include flowId and timeoutMs in WorkflowTimeoutError',
				async () => {
					const userTimeout = 30;
					// Effective timeout includes overhead (e.g., distributed provider's stallInterval)
					const effectiveTimeout = userTimeout + timeoutOverhead;
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: userTimeout });

					// Workflow must take longer than effective timeout to trigger timeout
					const workflowConfig = createSlowWorkflow(effectiveTimeout + 100);
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-3',
							amount: 0
						});

						const error = await handle.result().catch((e) => e);
						expect(error).toBeInstanceOf(WorkflowTimeoutError);
						const timeoutError = error as WorkflowTimeoutError;
						expect(timeoutError.flowId).toMatch(/^flow-/);
						// Error reports the effective timeout (includes provider's overhead)
						expect(timeoutError.timeoutMs).toBe(effectiveTimeout);
					} finally {
						await timeoutProvider.stop();
					}
				},
				// Test needs enough time for the slow workflow to start + timeout to fire
				Math.max(timeout, timeoutOverhead + 500)
			);

			it(
				'should disable timeout when set to 0',
				async () => {
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: 0 });
					const workflowConfig = createSlowSuccessWorkflow(50);
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-4',
							amount: 0
						});

						const result = await handle.result();
						expect(result).toBe('completed-without-timeout');
					} finally {
						await timeoutProvider.stop();
					}
				},
				timeout
			);

			it(
				'should clear timeout on successful completion',
				async () => {
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: 500 });
					const workflowConfig = createFastWorkflow();
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-5',
							amount: 0
						});

						const result = await handle.result();
						expect(result).toBe('completed');

						// Wait to ensure no late timeout fires
						await new Promise((resolve) => setTimeout(resolve, 100));

						const status = await handle.status();
						expect(status).toBe('completed');
					} finally {
						await timeoutProvider.stop();
					}
				},
				timeout
			);

			it(
				'should clear timeout on workflow error',
				async () => {
					const timeoutProvider = await createProviderWithConfig({ timeoutMs: 500 });
					const workflowConfig = createStepErrorWorkflow();
					const definition = registerAndGetDefinition(timeoutProvider, workflowConfig);
					await timeoutProvider.start();

					try {
						const handle = await timeoutProvider.execute(definition, {
							orderId: 'ORD-TIMEOUT-6',
							amount: 0
						});

						const error = await handle.result().catch((e) => e);
						expect(error).toBeInstanceOf(WorkflowStepError);

						// Wait to ensure no late timeout fires
						await new Promise((resolve) => setTimeout(resolve, 100));

						const status = await handle.status();
						expect(status).toBe('failed');
					} finally {
						await timeoutProvider.stop();
					}
				},
				timeout
			);
		});

		// ============================================================
		// LOGGER CONTEXT PROPAGATION
		// ============================================================
		describe('logger context propagation', () => {
			it(
				'should use default logger when none provided',
				async () => {
					const capturedLogger = { value: null as Logger | null };
					const workflowConfig = createLoggerCheckWorkflow(capturedLogger);
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-LOG-1',
						amount: 0
					});
					await handle.result();

					expect(capturedLogger.value).toBeInstanceOf(Logger);
				},
				timeout
			);

			it(
				'should use injected logger when provided',
				async () => {
					const customLogger = new Logger('CustomContext');
					const loggerProvider = await createProviderWithConfig({ logger: customLogger });

					const capturedLogger = { value: null as Logger | null };
					const workflowConfig = createLoggerCheckWorkflow(capturedLogger);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-LOG-2',
							amount: 0
						});
						await handle.result();

						expect(capturedLogger.value).not.toBeNull();
						expect(capturedLogger.value).toBeInstanceOf(Logger);
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate logger to onComplete context',
				async () => {
					const customLogger = new Logger('OnCompleteContext');
					const loggerProvider = await createProviderWithConfig({ logger: customLogger });

					const capturedLogger = { value: null as Logger | null };
					const workflowConfig = createOnCompleteLoggerWorkflow(capturedLogger);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-LOG-3',
							amount: 0
						});
						await handle.result();

						expect(capturedLogger.value).not.toBeNull();
						expect(capturedLogger.value).toBeInstanceOf(Logger);
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate logger to onError context',
				async () => {
					const customLogger = new Logger('OnErrorContext');
					const loggerProvider = await createProviderWithConfig({ logger: customLogger });

					const capturedLogger = { value: null as Logger | null };
					const workflowConfig = createOnErrorLoggerWorkflow(capturedLogger);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-LOG-4',
							amount: 0
						});

						await handle.result().catch(() => {});

						expect(capturedLogger.value).not.toBeNull();
						expect(capturedLogger.value).toBeInstanceOf(Logger);
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate logger to all steps in workflow',
				async () => {
					const customLogger = new Logger('AllStepsContext');
					const loggerProvider = await createProviderWithConfig({ logger: customLogger });

					const capturedLoggers: Logger[] = [];
					const workflowConfig = createMultiStepLoggerWorkflow(capturedLoggers);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-LOG-5',
							amount: 0
						});
						await handle.result();

						expect(capturedLoggers).toHaveLength(4);
						for (const logger of capturedLoggers) {
							expect(logger).toBeInstanceOf(Logger);
						}
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate correlationId context through workflow steps',
				async () => {
					const baseLogger = new Logger('ContextTest');
					const loggerWithContext = baseLogger.with({
						correlationId: 'req-abc-123',
						accountUuid: 'acc-xyz-789',
						userId: 'user-456'
					});

					const loggerProvider = await createProviderWithConfig({ logger: loggerWithContext });

					const capturedMeta: Record<string, unknown>[] = [];
					const workflowConfig = createContextCheckWorkflow(capturedMeta);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-CTX-1',
							amount: 0
						});
						await handle.result();

						expect(capturedMeta).toHaveLength(2);
						expect(capturedMeta[0]!.correlationId).toBe('req-abc-123');
						expect(capturedMeta[0]!.accountUuid).toBe('acc-xyz-789');
						expect(capturedMeta[0]!.userId).toBe('user-456');
						expect(capturedMeta[1]!.correlationId).toBe('req-abc-123');
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate context to onComplete callback',
				async () => {
					const loggerWithContext = new Logger('OnCompleteCtx').with({
						correlationId: 'req-complete-001',
						traceId: 'trace-complete-001'
					});

					const loggerProvider = await createProviderWithConfig({ logger: loggerWithContext });

					const capturedMeta = { value: null as Record<string, unknown> | null };
					const workflowConfig = createOnCompleteContextWorkflow(capturedMeta);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-CTX-2',
							amount: 0
						});
						await handle.result();

						expect(capturedMeta.value).not.toBeNull();
						expect(capturedMeta.value!.correlationId).toBe('req-complete-001');
						expect(capturedMeta.value!.traceId).toBe('trace-complete-001');
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate context to onError callback',
				async () => {
					const loggerWithContext = new Logger('OnErrorCtx').with({
						correlationId: 'req-error-001',
						spanId: 'span-error-001'
					});

					const loggerProvider = await createProviderWithConfig({ logger: loggerWithContext });

					const capturedMeta = { value: null as Record<string, unknown> | null };
					const workflowConfig = createOnErrorContextWorkflow(capturedMeta);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-CTX-3',
							amount: 0
						});

						await handle.result().catch(() => {});

						expect(capturedMeta.value).not.toBeNull();
						expect(capturedMeta.value!.correlationId).toBe('req-error-001');
						expect(capturedMeta.value!.spanId).toBe('span-error-001');
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);

			it(
				'should propagate context to parallel steps',
				async () => {
					const loggerWithContext = new Logger('ParallelCtx').with({
						correlationId: 'corr-parallel-001'
					});

					const loggerProvider = await createProviderWithConfig({ logger: loggerWithContext });

					const capturedMeta: Record<string, unknown>[] = [];
					const workflowConfig = createParallelContextWorkflow(capturedMeta);
					const definition = registerAndGetDefinition(loggerProvider, workflowConfig);
					await loggerProvider.start();

					try {
						const handle = await loggerProvider.execute(definition, {
							orderId: 'ORD-CTX-4',
							amount: 0
						});
						await handle.result();

						expect(capturedMeta).toHaveLength(3);
						for (const meta of capturedMeta) {
							expect(meta.correlationId).toBe('corr-parallel-001');
						}
					} finally {
						await loggerProvider.stop();
					}
				},
				timeout
			);
		});

		// ============================================================
		// FLOW HANDLE
		// ============================================================
		describe('flow handle', () => {
			it(
				'should return handle with correct id',
				async () => {
					const workflowConfig = createFastWorkflow();
					const definition = registerAndGetDefinition(provider, workflowConfig);
					await provider.start();

					const handle = await provider.execute(definition, {
						orderId: 'ORD-HANDLE',
						amount: 0
					});

					expect(handle.id).toBeDefined();
					expect(handle.id.startsWith('flow-')).toBe(true);

					const result = await handle.result();
					expect(result).toBe('completed');
				},
				timeout
			);
		});

		// ============================================================
		// LIFECYCLE
		// ============================================================
		describe('lifecycle', () => {
			it(
				'should start and stop cleanly',
				async () => {
					const lifecycleProvider = await createProvider();

					// start() and stop() should not throw
					await lifecycleProvider.start();
					await lifecycleProvider.stop();

					// Should be idempotent (can call multiple times)
					await lifecycleProvider.stop();
				},
				timeout
			);

			it(
				'should be idempotent for start()',
				async () => {
					const lifecycleProvider = await createProvider();

					// Can call start() multiple times
					await lifecycleProvider.start();
					await lifecycleProvider.start();

					await lifecycleProvider.stop();
				},
				timeout
			);
		});
	});
}
