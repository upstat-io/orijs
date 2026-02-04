import { describe, it, expect, beforeEach } from 'bun:test';
import { WorkflowCoordinator } from '../src/workflow-coordinator.ts';
import { Container } from '../src/container.ts';
import { Logger } from '@orijs/logging';
import { Workflow } from '../src/types/workflow-definition.ts';
import { Type } from '@orijs/validation';
import type { IWorkflowConsumer, WorkflowContext } from '../src/types/consumer.ts';
import type { WorkflowProvider } from '@orijs/workflows';

describe('WorkflowCoordinator', () => {
	let logger: Logger;
	let container: Container;

	beforeEach(() => {
		logger = new Logger('test');
		container = new Container();
	});

	// Test workflow definition
	const TestWorkflow = Workflow.define({
		name: 'test-workflow',
		data: Type.Object({ orderId: Type.String() }),
		result: Type.Object({ success: Type.Boolean() })
	});

	// Test consumer class
	class TestWorkflowConsumer implements IWorkflowConsumer<
		(typeof TestWorkflow)['_data'],
		(typeof TestWorkflow)['_result']
	> {
		onComplete = async (_ctx: WorkflowContext<(typeof TestWorkflow)['_data']>) => {
			return { success: true };
		};
	}

	// Helper to create a minimal mock provider
	const createMockProvider = (overrides: Partial<WorkflowProvider> = {}): WorkflowProvider =>
		({
			start: async () => {},
			stop: async () => {},
			registerWorkflow: () => {},
			execute: async () => ({ id: 'mock', status: async () => 'completed', result: async () => ({}) }),
			getStatus: async () => 'completed',
			...overrides
		}) as unknown as WorkflowProvider;

	describe('Provider Factory Injection', () => {
		it('should use injected provider factory when registering consumers', () => {
			let factoryCalled = false;
			const mockProvider = createMockProvider();

			const customFactory = () => {
				factoryCalled = true;
				return mockProvider;
			};

			const coordinator = new WorkflowCoordinator(logger, container, customFactory);

			// Register a workflow definition with consumer
			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);

			// Factory is called during registerConsumers
			coordinator.registerConsumers();

			expect(factoryCalled).toBe(true);
		});

		it('should NOT use factory when explicit provider is set', () => {
			let factoryCalled = false;
			const explicitProvider = createMockProvider();

			const customFactory = () => {
				factoryCalled = true;
				return createMockProvider();
			};

			const coordinator = new WorkflowCoordinator(logger, container, customFactory);

			// Set provider explicitly BEFORE registering consumers
			coordinator.setProvider(explicitProvider);
			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			coordinator.registerConsumers();

			expect(factoryCalled).toBe(false);
			expect(coordinator.getProvider()).toBe(explicitProvider);
		});

		it('should use default InProcessWorkflowProvider when no factory is injected', async () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			coordinator.registerConsumers();

			expect(coordinator.isConfigured()).toBe(true);
			expect(coordinator.getProvider()).not.toBeNull();

			await coordinator.start();
			await coordinator.stop();
		});
	});

	describe('Provider Lifecycle Error Handling', () => {
		it('should propagate provider.start() errors', async () => {
			const mockProvider = createMockProvider({
				start: async () => {
					throw new Error('Provider start failed');
				}
			});

			const coordinator = new WorkflowCoordinator(logger, container, () => mockProvider);
			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			coordinator.registerConsumers();

			await expect(coordinator.start()).rejects.toThrow('Provider start failed');
		});

		it('should propagate provider.stop() errors', async () => {
			let started = false;
			const mockProvider = createMockProvider({
				start: async () => {
					started = true;
				},
				stop: async () => {
					throw new Error('Provider stop failed');
				}
			});

			const coordinator = new WorkflowCoordinator(logger, container, () => mockProvider);
			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();
			expect(started).toBe(true);

			await expect(coordinator.stop()).rejects.toThrow('Provider stop failed');
		});

		it('should handle start() gracefully when no workflow system is configured', async () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			// Should not throw - just no-op
			await coordinator.start();
			expect(coordinator.isConfigured()).toBe(false);
		});

		it('should handle stop() gracefully when no workflow system is configured', async () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			// Should not throw - just no-op
			await coordinator.stop();
			expect(coordinator.isConfigured()).toBe(false);
		});
	});

	describe('Workflow Definition Registration', () => {
		it('should register workflow definition', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(TestWorkflow);

			expect(coordinator.getWorkflowDefinition('test-workflow')).toBeDefined();
			expect(coordinator.getWorkflowDefinition('test-workflow')?.name).toBe('test-workflow');
		});

		it('should throw on duplicate workflow registration', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(TestWorkflow);

			expect(() => {
				coordinator.registerWorkflowDefinition(TestWorkflow);
			}).toThrow(/duplicate/i);
		});

		it('should return undefined for unregistered workflow', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			expect(coordinator.getWorkflowDefinition('non-existent')).toBeUndefined();
		});
	});

	describe('Consumer Registration', () => {
		it('should instantiate consumer via DI during registerConsumers()', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			coordinator.registerConsumers();

			const consumer = coordinator.getConsumer('test-workflow');
			expect(consumer).toBeDefined();
			expect(consumer?.consumer).toBeInstanceOf(TestWorkflowConsumer);
		});

		it('should return registered workflow names', () => {
			const SecondWorkflow = Workflow.define({
				name: 'second-workflow',
				data: Type.Object({ id: Type.Number() }),
				result: Type.Void()
			});

			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(TestWorkflow);
			coordinator.registerWorkflowDefinition(SecondWorkflow);

			const names = coordinator.getRegisteredWorkflowNames();
			expect(names).toContain('test-workflow');
			expect(names).toContain('second-workflow');
			expect(names).toHaveLength(2);
		});
	});

	describe('Worker Registration (CRITICAL - Consumer Availability)', () => {
		// CRITICAL INVARIANT: Definition-only apps must NOT have consumers registered
		// If BullMQ sends work to an instance with no consumer, the workflow will
		// fail silently since no handler exists to process it.

		it('should NOT have consumer for definition-only registration (executor-only app)', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			// Register ONLY the workflow definition - NO consumer
			// This simulates an executor-only app that just triggers workflows
			coordinator.registerWorkflowDefinition(TestWorkflow);

			// Call registerConsumers even though we have no consumers
			coordinator.registerConsumers();

			// CRITICAL: getConsumer should return undefined
			// An executor-only app should NOT be able to process workflow work
			const consumer = coordinator.getConsumer('test-workflow');
			expect(consumer).toBeUndefined();
		});

		it('should have consumer ONLY for workflows with registered consumers', () => {
			// Define a second workflow that will have a consumer
			const ConsumerWorkflow = Workflow.define({
				name: 'consumer-workflow',
				data: Type.Object({ data: Type.String() }),
				result: Type.Void()
			});

			class ConsumerWorkflowHandler implements IWorkflowConsumer<(typeof ConsumerWorkflow)['_data'], void> {
				onComplete = async (_ctx: WorkflowContext<(typeof ConsumerWorkflow)['_data']>) => {};
			}

			const coordinator = new WorkflowCoordinator(logger, container);

			// Register TestWorkflow definition ONLY (executor-only for this workflow)
			coordinator.registerWorkflowDefinition(TestWorkflow);

			// Register ConsumerWorkflow WITH a consumer (worker for this workflow)
			coordinator.registerWorkflowDefinition(ConsumerWorkflow);
			coordinator.addWorkflowConsumer(ConsumerWorkflow, ConsumerWorkflowHandler, []);

			coordinator.registerConsumers();

			// ConsumerWorkflow should have a consumer
			const consumerWorkflowConsumer = coordinator.getConsumer('consumer-workflow');
			expect(consumerWorkflowConsumer).toBeDefined();
			expect(consumerWorkflowConsumer?.consumer).toBeInstanceOf(ConsumerWorkflowHandler);

			// TestWorkflow should NOT have a consumer - it's executor-only
			const testWorkflowConsumer = coordinator.getConsumer('test-workflow');
			expect(testWorkflowConsumer).toBeUndefined();
		});

		it('should allow executing workflows without having a consumer (executor-only pattern)', async () => {
			// Create a separate "worker" coordinator that HAS the consumer
			const workerCoordinator = new WorkflowCoordinator(logger, container);
			workerCoordinator.registerWorkflowDefinition(TestWorkflow);
			workerCoordinator.addWorkflowConsumer(TestWorkflow, TestWorkflowConsumer, []);
			workerCoordinator.registerConsumers();

			// Create an "executor-only" coordinator that only has definition
			const executorCoordinator = new WorkflowCoordinator(logger, container);
			executorCoordinator.registerWorkflowDefinition(TestWorkflow);
			executorCoordinator.registerConsumers();

			// Executor-only has definition but no consumer
			expect(executorCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();
			expect(executorCoordinator.getConsumer('test-workflow')).toBeUndefined();

			// Worker has both definition and consumer
			expect(workerCoordinator.getWorkflowDefinition('test-workflow')).toBeDefined();
			expect(workerCoordinator.getConsumer('test-workflow')).toBeDefined();

			// In a real distributed system:
			// - executorCoordinator.execute(TestWorkflow, data) would enqueue work
			// - workerCoordinator would process that work (has consumer)
			// - executorCoordinator would NOT process work (no consumer)
		});
	});

	describe('IWorkflowConsumer with Steps (New Design)', () => {
		// E2E test that verifies the NEW flow:
		// 1. Steps are defined in WorkflowDefinition via .steps()
		// 2. Consumer provides step handlers via steps property
		// 3. Workflow executes through coordinator

		// Track step execution order
		const executionLog: string[] = [];

		// Workflow with steps defined in definition (new design)
		const SequentialWorkflow = Workflow.define({
			name: 'sequential-workflow',
			data: Type.Object({ value: Type.Number() }),
			result: Type.Object({ finalValue: Type.Number() })
		}).steps((s) =>
			s
				.sequential(s.step('double', Type.Object({ doubled: Type.Number() })))
				.sequential(s.step('addTen', Type.Object({ result: Type.Number() })))
		);

		// Consumer provides step handlers via steps property (new design)
		class SequentialWorkflowConsumer implements IWorkflowConsumer<
			(typeof SequentialWorkflow)['_data'],
			(typeof SequentialWorkflow)['_result'],
			(typeof SequentialWorkflow)['_steps']
		> {
			steps = {
				double: {
					execute: async (ctx: { data: { value: number } }) => {
						executionLog.push('double');
						return { doubled: ctx.data.value * 2 };
					}
				},
				addTen: {
					execute: async (ctx: { data: { value: number }; results: Record<string, unknown> }) => {
						executionLog.push('addTen');
						const doubled =
							(ctx.results['double'] as { doubled: number } | undefined)?.doubled ?? ctx.data.value;
						return { result: doubled + 10 };
					}
				}
			};

			onComplete = async (ctx: WorkflowContext<(typeof SequentialWorkflow)['_data']>) => {
				executionLog.push('onComplete');
				const addTenResult = ctx.results['addTen'] as { result: number } | undefined;
				return { finalValue: addTenResult?.result ?? 0 };
			};
		}

		beforeEach(() => {
			executionLog.length = 0; // Clear log before each test
		});

		it('should register consumer with steps', () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(SequentialWorkflow);
			coordinator.addWorkflowConsumer(SequentialWorkflow, SequentialWorkflowConsumer, []);
			coordinator.registerConsumers();

			// Verify consumer was registered
			const consumer = coordinator.getConsumer('sequential-workflow');
			expect(consumer).toBeDefined();
			expect(consumer?.consumer).toBeInstanceOf(SequentialWorkflowConsumer);
		});

		it('should execute workflow and call onComplete handler', async () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(SequentialWorkflow);
			coordinator.addWorkflowConsumer(SequentialWorkflow, SequentialWorkflowConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			// Execute workflow via coordinator's executor
			const executor = coordinator.createExecutor();
			const handle = await executor.execute(SequentialWorkflow, { value: 5 });

			// Get result
			const result = await handle.result();

			// onComplete should be called
			expect(executionLog).toContain('onComplete');

			// Result should be returned from onComplete
			expect(result).toBeDefined();
			expect(typeof result.finalValue).toBe('number');

			await coordinator.stop();
		});

		it('should validate workflow data against schema', async () => {
			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(SequentialWorkflow);
			coordinator.addWorkflowConsumer(SequentialWorkflow, SequentialWorkflowConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			const executor = coordinator.createExecutor();

			// Execute with invalid data (string instead of number)
			await expect(
				executor.execute(SequentialWorkflow, {
					value: 'not-a-number'
				} as unknown as (typeof SequentialWorkflow)['_data'])
			).rejects.toThrow(/validation failed/i);

			await coordinator.stop();
		});

		it('should validate workflow result against schema', async () => {
			// Use a simple workflow WITHOUT steps for result validation testing
			const SimpleWorkflow = Workflow.define({
				name: 'simple-result-workflow',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Object({ finalValue: Type.Number() })
			});

			// Consumer that returns invalid result
			class InvalidResultConsumer implements IWorkflowConsumer<
				(typeof SimpleWorkflow)['_data'],
				(typeof SimpleWorkflow)['_result']
			> {
				onComplete = async (_ctx: WorkflowContext<(typeof SimpleWorkflow)['_data']>) => {
					// Return string instead of number - invalid!
					return { finalValue: 'not-a-number' as unknown as number };
				};
			}

			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(SimpleWorkflow);
			coordinator.addWorkflowConsumer(SimpleWorkflow, InvalidResultConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			const executor = coordinator.createExecutor();

			// Should fail due to result validation
			await expect(executor.execute(SimpleWorkflow, { value: 5 })).rejects.toThrow(
				/result validation failed/i
			);

			await coordinator.stop();
		});

		// Test with steps that have rollback handlers
		const RollbackWorkflow = Workflow.define({
			name: 'rollback-workflow',
			data: Type.Object({ shouldFail: Type.Boolean() }),
			result: Type.Void()
		}).steps((s) =>
			s
				.sequential(s.step('step1', Type.Object({ done: Type.Boolean() })))
				.sequential(s.step('step2', Type.Object({ processed: Type.Boolean() })))
		);

		it('should accept consumer with rollback handlers', () => {
			const rollbackLog: string[] = [];

			class RollbackWorkflowConsumer implements IWorkflowConsumer<
				(typeof RollbackWorkflow)['_data'],
				void,
				(typeof RollbackWorkflow)['_steps']
			> {
				steps = {
					step1: {
						execute: async () => ({ done: true }),
						rollback: async () => {
							rollbackLog.push('step1-rollback');
						}
					},
					step2: {
						execute: async () => ({ processed: true })
					}
				};

				onComplete = async () => {};
			}

			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(RollbackWorkflow);
			coordinator.addWorkflowConsumer(RollbackWorkflow, RollbackWorkflowConsumer, []);
			coordinator.registerConsumers();

			const consumer = coordinator.getConsumer('rollback-workflow');
			expect(consumer).toBeDefined();
			expect(consumer?.consumer).toBeInstanceOf(RollbackWorkflowConsumer);
		});

		it('should execute rollbacks in reverse order when a step fails', async () => {
			const executionLog: string[] = [];

			// Define a workflow with 3 sequential steps where step 3 fails
			const FailingWorkflow = Workflow.define({
				name: 'failing-workflow',
				data: Type.Object({ shouldFail: Type.Boolean() }),
				result: Type.Void()
			}).steps((s) =>
				s
					.sequential(s.step('step1', Type.Object({ done: Type.Boolean() })))
					.sequential(s.step('step2', Type.Object({ done: Type.Boolean() })))
					.sequential(s.step('step3', Type.Object({ done: Type.Boolean() })))
			);

			class FailingWorkflowConsumer implements IWorkflowConsumer<
				(typeof FailingWorkflow)['_data'],
				void,
				(typeof FailingWorkflow)['_steps']
			> {
				steps = {
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
					},
					step3: {
						execute: async () => {
							executionLog.push('step3-execute');
							throw new Error('Step 3 failed!');
						},
						rollback: async () => {
							executionLog.push('step3-rollback');
						}
					}
				};

				onComplete = async () => {};
			}

			const coordinator = new WorkflowCoordinator(logger, container);
			coordinator.registerWorkflowDefinition(FailingWorkflow);
			coordinator.addWorkflowConsumer(FailingWorkflow, FailingWorkflowConsumer, []);
			coordinator.registerConsumers();

			const executor = coordinator.createExecutor();

			// Execute should throw because step3 fails
			await expect(executor.execute(FailingWorkflow, { shouldFail: true })).rejects.toThrow('Step 3 failed!');

			// Verify execution order: steps 1,2,3 executed, then rollbacks in reverse (2,1)
			// Note: step3 fails during execute, so no step3-rollback (it never completed)
			expect(executionLog).toEqual([
				'step1-execute',
				'step2-execute',
				'step3-execute',
				'step2-rollback',
				'step1-rollback'
			]);
		});

		it('should continue rollbacks even if one rollback fails', async () => {
			const executionLog: string[] = [];

			const RollbackFailWorkflow = Workflow.define({
				name: 'rollback-fail-workflow',
				data: Type.Object({}),
				result: Type.Void()
			}).steps((s) =>
				s
					.sequential(s.step('step1', Type.Object({ done: Type.Boolean() })))
					.sequential(s.step('step2', Type.Object({ done: Type.Boolean() })))
					.sequential(s.step('step3', Type.Object({ done: Type.Boolean() })))
			);

			class RollbackFailConsumer implements IWorkflowConsumer<
				(typeof RollbackFailWorkflow)['_data'],
				void,
				(typeof RollbackFailWorkflow)['_steps']
			> {
				steps = {
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
							executionLog.push('step2-rollback-start');
							throw new Error('Rollback 2 failed!');
						}
					},
					step3: {
						execute: async () => {
							executionLog.push('step3-execute');
							throw new Error('Step 3 failed!');
						}
					}
				};

				onComplete = async () => {};
			}

			const coordinator = new WorkflowCoordinator(logger, container);
			coordinator.registerWorkflowDefinition(RollbackFailWorkflow);
			coordinator.addWorkflowConsumer(RollbackFailWorkflow, RollbackFailConsumer, []);
			coordinator.registerConsumers();

			const executor = coordinator.createExecutor();

			// Execute should throw the original error (step3 failure)
			await expect(executor.execute(RollbackFailWorkflow, {})).rejects.toThrow('Step 3 failed!');

			// Verify all rollbacks were attempted even though step2's rollback failed
			expect(executionLog).toEqual([
				'step1-execute',
				'step2-execute',
				'step3-execute',
				'step2-rollback-start', // step2 rollback attempted but failed
				'step1-rollback' // step1 rollback still executed
			]);
		});

		// Test parallel step configuration
		const ParallelWorkflow = Workflow.define({
			name: 'parallel-workflow',
			data: Type.Object({ items: Type.Array(Type.String()) }),
			result: Type.Object({ processed: Type.Number() })
		}).steps((s) =>
			s
				.parallel(
					s.step('validate', Type.Object({ valid: Type.Boolean() })),
					s.step('enrich', Type.Object({ enriched: Type.Boolean() }))
				)
				.sequential(s.step('index', Type.Object({ indexed: Type.Boolean() })))
		);

		// Type for parallel workflow steps
		type ParallelWorkflowSteps = {
			validate: { valid: boolean };
			enrich: { enriched: boolean };
			index: { indexed: boolean };
		};

		it('should register consumer for parallel steps', () => {
			class ParallelWorkflowConsumer implements IWorkflowConsumer<
				(typeof ParallelWorkflow)['_data'],
				(typeof ParallelWorkflow)['_result'],
				ParallelWorkflowSteps
			> {
				steps = {
					validate: { execute: async () => ({ valid: true }) },
					enrich: { execute: async () => ({ enriched: true }) },
					index: { execute: async () => ({ indexed: true }) }
				};

				onComplete = async () => {
					return { processed: 3 };
				};
			}

			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(ParallelWorkflow);
			coordinator.addWorkflowConsumer(ParallelWorkflow, ParallelWorkflowConsumer, []);
			coordinator.registerConsumers();

			const consumer = coordinator.getConsumer('parallel-workflow');
			expect(consumer).toBeDefined();
		});

		// Test mixed sequential/parallel
		it('should register consumer for mixed sequential and parallel steps', () => {
			class MixedWorkflowConsumer implements IWorkflowConsumer<
				(typeof ParallelWorkflow)['_data'],
				(typeof ParallelWorkflow)['_result'],
				ParallelWorkflowSteps
			> {
				steps = {
					validate: { execute: async () => ({ valid: true }) },
					enrich: { execute: async () => ({ enriched: true }) },
					index: { execute: async () => ({ indexed: true }) }
				};

				onComplete = async () => {
					return { processed: 4 };
				};
			}

			const coordinator = new WorkflowCoordinator(logger, container);

			coordinator.registerWorkflowDefinition(ParallelWorkflow);
			coordinator.addWorkflowConsumer(ParallelWorkflow, MixedWorkflowConsumer, []);
			coordinator.registerConsumers();

			const consumer = coordinator.getConsumer('parallel-workflow');
			expect(consumer).toBeDefined();
		});
	});
});
