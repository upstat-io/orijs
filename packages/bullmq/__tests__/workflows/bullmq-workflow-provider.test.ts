/**
 * BullMQWorkflowProvider Functional Tests
 *
 * Tests the BullMQWorkflowProvider with mocked BullMQ components.
 * Verifies correct integration of FlowBuilder, StepRegistry, and BullMQ.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';
import {
	BullMQWorkflowProvider,
	createBullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions
} from '../../src/workflows/bullmq-workflow-provider.ts';

/**
 * Mock FlowProducer for testing
 */
interface MockFlowProducer {
	add: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
}

/**
 * Mock Redis client for testing internal connections
 */
interface MockRedisClient {
	on: ReturnType<typeof mock>;
}

/**
 * Mock Redis connection for testing
 */
interface MockRedisConnection {
	_client: MockRedisClient;
}

/**
 * Create mock Redis connection
 */
function createMockRedisConnection(): MockRedisConnection {
	return { _client: { on: mock(() => {}) } };
}

/**
 * Mock Worker for testing
 */
interface MockWorker {
	close: ReturnType<typeof mock>;
	on: ReturnType<typeof mock>;
	connection: MockRedisConnection;
	blockingConnection: MockRedisConnection;
}

/**
 * Create mock FlowProducer class
 */
function createMockFlowProducerClass(mockFlowProducer: MockFlowProducer) {
	return class MockFlowProducerClass {
		public add = mockFlowProducer.add;
		public close = mockFlowProducer.close;
	};
}

/**
 * Create mock Worker class
 */
function createMockWorkerClass(mockWorker: MockWorker) {
	return class MockWorkerClass {
		public close = mockWorker.close;
		public on = mockWorker.on;
		public connection = mockWorker.connection;
		public blockingConnection = mockWorker.blockingConnection;
	};
}

/**
 * Create mock Worker class that captures the step processor for testing.
 * This allows tests to verify how steps are processed with specific job data.
 *
 * @param onStepProcessor - Callback that receives the captured step processor function
 */
function createCapturingWorkerClass(
	onStepProcessor: (processor: (job: unknown) => Promise<unknown>) => void
) {
	return class CapturingWorkerClass {
		public close = mock(() => Promise.resolve());
		public on = mock(() => this);
		public connection = createMockRedisConnection();
		public blockingConnection = createMockRedisConnection();

		constructor(queueName: string, processor: (job: unknown) => Promise<unknown>, _opts: unknown) {
			if (queueName.endsWith('.steps')) {
				onStepProcessor(processor);
			}
		}
	};
}

// Define TestWorkflow using definition-based API
const TestWorkflowDef = Workflow.define({
	name: 'TestWorkflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ doubled: Type.Number() })
});

// Step groups for TestWorkflow
const testStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'double' }]
	}
];

// Step handlers for TestWorkflow
const createTestStepHandlers = () => ({
	double: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { result: ctx.data.value * 2 };
		}
	}
});

// onComplete handler for TestWorkflow
const testOnComplete = async (
	_data: unknown,
	_meta: Record<string, unknown> | undefined,
	stepResults: Record<string, unknown> | undefined
): Promise<{ doubled: number }> => {
	const doubleResult = stepResults?.['double'] as { result: number } | undefined;
	return { doubled: doubleResult?.result ?? 0 };
};

// Define MultiStepWorkflow using definition-based API
const MultiStepWorkflowDef = Workflow.define({
	name: 'MultiStepWorkflow',
	data: Type.Object({ input: Type.String() }),
	result: Type.Void()
});

// Step groups for MultiStepWorkflow (sequential then parallel)
const multiStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'validate' }, { name: 'process' }]
	},
	{
		type: 'parallel' as const,
		definitions: [{ name: 'notify-email' }, { name: 'notify-sms' }]
	}
];

// Step handlers for MultiStepWorkflow
const createMultiStepHandlers = () => ({
	validate: {
		execute: async (ctx: WorkflowContext<{ input: string }>) => {
			return { valid: ctx.data.input.length > 0 };
		}
	},
	process: {
		execute: async () => {
			return { processed: true };
		}
	},
	'notify-email': {
		execute: async () => {
			return { sent: 'email' };
		}
	},
	'notify-sms': {
		execute: async () => {
			return { sent: 'sms' };
		}
	}
});

describe('BullMQWorkflowProvider', () => {
	let mockFlowProducer: MockFlowProducer;
	let mockWorker: MockWorker;
	let provider: BullMQWorkflowProvider;

	beforeEach(() => {
		mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-123' } })),
			close: mock(() => Promise.resolve())
		};

		mockWorker = {
			close: mock(() => Promise.resolve()),
			on: mock(() => mockWorker),
			connection: createMockRedisConnection(),
			blockingConnection: createMockRedisConnection()
		};

		const options: BullMQWorkflowProviderOptions = {
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-workflow',
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass(mockWorker) as any
		};

		provider = new BullMQWorkflowProvider(options);
	});

	describe('registerDefinitionConsumer', () => {
		it('should register workflow definition', () => {
			// Should not throw
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
		});

		it('should register multiple workflows', () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			provider.registerDefinitionConsumer(
				'MultiStepWorkflow',
				async () => {},
				multiStepGroups,
				createMultiStepHandlers()
			);
			// No error means success
		});

		it('should log warning when step handler is missing for defined step', () => {
			const mockLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {}),
				child: mock(() => mockLogger)
			};

			const providerWithLogger = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-workflow',
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				logger: mockLogger as any
			});

			// Step groups define 'validate' step but handlers only provide 'process'
			const stepGroupsWithMissingHandler = [
				{
					type: 'sequential' as const,
					definitions: [{ name: 'validate' }, { name: 'process' }]
				}
			];

			const incompleteHandlers = {
				process: { execute: async () => ({ done: true }) }
				// 'validate' handler is intentionally missing
			};

			providerWithLogger.registerDefinitionConsumer(
				'IncompleteWorkflow',
				async () => {},
				stepGroupsWithMissingHandler,
				incompleteHandlers
			);

			// Verify warning was logged for missing handler
			expect(mockLogger.warn).toHaveBeenCalled();
			const warnCalls = mockLogger.warn.mock.calls;
			const missingHandlerWarning = warnCalls.find(
				(call: unknown[]) => typeof call[0] === 'string' && call[0].includes('validate')
			);
			expect(missingHandlerWarning).toBeDefined();
		});

		it('should log warning when step groups defined but no stepHandlers provided', () => {
			const mockLogger = {
				info: mock(() => {}),
				warn: mock(() => {}),
				error: mock(() => {}),
				debug: mock(() => {}),
				child: mock(() => mockLogger)
			};

			const providerWithLogger = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-workflow',
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				logger: mockLogger as any
			});

			// Register with step groups but no stepHandlers
			providerWithLogger.registerDefinitionConsumer(
				'NoHandlersWorkflow',
				async () => {},
				testStepGroups,
				undefined // No stepHandlers provided
			);

			// Verify warning was logged about missing stepHandlers
			expect(mockLogger.warn).toHaveBeenCalled();
			const warnCalls = mockLogger.warn.mock.calls;
			const noHandlersWarning = warnCalls.find(
				(call: unknown[]) => typeof call[0] === 'string' && call[0].includes('no stepHandlers')
			);
			expect(noHandlersWarning).toBeDefined();
		});
	});

	describe('execute', () => {
		it('should add flow via FlowProducer', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(TestWorkflowDef, { value: 5 });

			expect(mockFlowProducer.add).toHaveBeenCalled();
			expect(handle.id).toBeDefined();
		});

		it('should include workflow name in flow job', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(TestWorkflowDef, { value: 10 });

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.name).toBe('TestWorkflow');
		});

		it('should include workflow data in flow job', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(TestWorkflowDef, { value: 42 });

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.data.workflowData).toEqual({ value: 42 });
		});

		it('should create step children for sequential workflow', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(TestWorkflowDef, { value: 1 });

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.children).toBeDefined();
			expect(flowJob.children.length).toBeGreaterThan(0);
			expect(flowJob.children[0].name).toBe('double');
		});

		it('should create step queue name with workflow name', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(TestWorkflowDef, { value: 1 });

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.children[0].queueName).toBe('test-workflow.TestWorkflow.steps');
		});

		it('should return flow handle with id', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			const handle = await provider.execute(TestWorkflowDef, { value: 1 });

			expect(handle.id).toBeDefined();
			expect(typeof handle.id).toBe('string');
		});
	});

	describe('getStatus', () => {
		it('should return pending for unknown flow', async () => {
			const status = await provider.getStatus('unknown-flow-id');
			expect(status).toBe('pending');
		});
	});

	describe('start', () => {
		it('should create workers and register error handlers for registered workflows', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);

			await provider.start();

			// Workers register 'error' event handlers during creation
			expect(mockWorker.on).toHaveBeenCalled();
			// Check that 'error' handler was registered (workers call on('error', ...))
			const onCalls = mockWorker.on.mock.calls;
			const errorHandlerCall = onCalls.find((call: unknown[]) => call[0] === 'error');
			expect(errorHandlerCall).toBeDefined();
		});

		it('should be idempotent and not create duplicate workers on multiple calls', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);

			await provider.start();
			const callCountAfterFirst = mockWorker.on.mock.calls.length;

			await provider.start();
			const callCountAfterSecond = mockWorker.on.mock.calls.length;

			// Second start() should not create additional workers (no new on() calls)
			expect(callCountAfterSecond).toBe(callCountAfterFirst);
		});
	});

	describe('stop', () => {
		it('should close FlowProducer', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.stop();

			expect(mockFlowProducer.close).toHaveBeenCalled();
		});

		it('should close workers', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.stop();

			expect(mockWorker.close).toHaveBeenCalled();
		});

		it('should be safe to call without start and not attempt to close non-existent workers', async () => {
			// Reset mock to track calls only from this test
			mockWorker.close.mockClear();
			mockFlowProducer.close.mockClear();

			await provider.stop();

			// No workers were created, so close should not be called on worker
			// FlowProducer.close is always called as it's created in constructor
			expect(mockWorker.close).not.toHaveBeenCalled();
		});
	});

	describe('propagation meta', () => {
		it('should include meta in flow job when provided', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(
				TestWorkflowDef,
				{ value: 1 },
				{
					meta: {
						request_id: 'req-123',
						trace_id: 'trace-456'
					}
				}
			);

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.data.meta).toEqual({
				request_id: 'req-123',
				trace_id: 'trace-456'
			});
		});

		it('should include meta in step jobs', async () => {
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			await provider.execute(
				TestWorkflowDef,
				{ value: 1 },
				{
					meta: {
						user_id: 'user-789'
					}
				}
			);

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];
			expect(flowJob.children[0].data.meta).toEqual({
				user_id: 'user-789'
			});
		});
	});

	describe('multi-step workflow', () => {
		it('should create correct flow structure for mixed groups', async () => {
			provider.registerDefinitionConsumer(
				'MultiStepWorkflow',
				async () => {},
				multiStepGroups,
				createMultiStepHandlers()
			);
			await provider.start();

			await provider.execute(MultiStepWorkflowDef, { input: 'test' });

			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];

			// Structure: parent ← __parallel__ ← process ← validate
			// Execution order: validate → process → (notify-email, notify-sms in parallel) → parent
			expect(flowJob.children).toHaveLength(1);
			const parallelJob = flowJob.children[0];
			expect(parallelJob.name).toBe('__parallel__:notify-email,notify-sms');

			// Parallel job has the sequential chain as children
			expect(parallelJob.children).toHaveLength(1);
			const processStep = parallelJob.children[0];
			expect(processStep.name).toBe('process');

			expect(processStep.children).toHaveLength(1);
			const validateStep = processStep.children[0];
			expect(validateStep.name).toBe('validate');
		});
	});

	describe('context propagation', () => {
		it('should create logger from PropagationMeta with request_id', async () => {
			let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;
			let receivedLog: any = null;

			const contextTestStepGroups = [
				{
					type: 'sequential' as const,
					definitions: [{ name: 'capture-context' }]
				}
			];

			const contextTestStepHandlers = {
				'capture-context': {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						receivedLog = ctx.log;
						return { captured: true };
					}
				}
			};

			const contextProvider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-workflow',
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createCapturingWorkerClass((processor) => {
					capturedStepProcessor = processor;
				}) as any
			});

			contextProvider.registerDefinitionConsumer(
				'ContextTestWorkflow',
				async () => {},
				contextTestStepGroups,
				contextTestStepHandlers
			);
			await contextProvider.start();

			expect(capturedStepProcessor).not.toBeNull();

			// Include PropagationMeta with request_id (simulating context from controller)
			const mockJob = {
				queueName: 'test-workflow.ContextTestWorkflow.steps',
				data: {
					flowId: 'flow-123',
					stepName: 'capture-context',
					workflowData: { value: 42 },
					meta: {
						request_id: 'req-abc-123',
						user_id: 'user-456',
						account_uuid: 'account-789'
					}
				},
				getChildrenValues: mock(() => Promise.resolve({}))
			};

			await capturedStepProcessor!(mockJob);

			// Verify the step handler received a Logger instance (from Logger.fromMeta)
			expect(receivedLog).toBeDefined();
			expect(typeof receivedLog.info).toBe('function');
			expect(typeof receivedLog.error).toBe('function');
			expect(typeof receivedLog.debug).toBe('function');
			expect(typeof receivedLog.warn).toBe('function');

			await contextProvider.stop();
		});

		it('should handle empty meta gracefully', async () => {
			let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;
			let receivedLog: any = null;

			const emptyMetaStepGroups = [
				{
					type: 'sequential' as const,
					definitions: [{ name: 'check-log' }]
				}
			];

			const emptyMetaStepHandlers = {
				'check-log': {
					execute: async (ctx: WorkflowContext<{ value: number }>) => {
						receivedLog = ctx.log;
						return { checked: true };
					}
				}
			};

			const emptyMetaProvider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-workflow',
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createCapturingWorkerClass((processor) => {
					capturedStepProcessor = processor;
				}) as any
			});

			emptyMetaProvider.registerDefinitionConsumer(
				'EmptyMetaWorkflow',
				async () => {},
				emptyMetaStepGroups,
				emptyMetaStepHandlers
			);
			await emptyMetaProvider.start();

			// No meta provided - should still work
			const mockJob = {
				queueName: 'test-workflow.EmptyMetaWorkflow.steps',
				data: {
					flowId: 'flow-456',
					stepName: 'check-log',
					workflowData: { value: 1 }
					// No meta field
				},
				getChildrenValues: mock(() => Promise.resolve({}))
			};

			await capturedStepProcessor!(mockJob);

			// Should still get a Logger instance
			expect(receivedLog).toBeDefined();
			expect(typeof receivedLog.info).toBe('function');

			await emptyMetaProvider.stop();
		});

		it('should propagate full controller context through workflow steps', async () => {
			/**
			 * This test demonstrates the complete context propagation flow:
			 *
			 * 1. Controller has a Logger with context (request_id, user_id, account_uuid)
			 * 2. Controller calls logger.propagationMeta() to get meta for workflow execution
			 * 3. Provider passes meta through to job data
			 * 4. Worker uses Logger.fromMeta() to restore logger
			 * 5. Step handler receives logger with same context
			 *
			 * This ensures distributed tracing works: HTTP Request → Controller → Workflow → Steps
			 */
			let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;
			let receivedContext: Record<string, unknown> = {};
			let receivedMeta: Record<string, unknown> = {};

			const fullContextStepGroups = [
				{
					type: 'sequential' as const,
					definitions: [{ name: 'process-order' }]
				}
			];

			const fullContextStepHandlers = {
				'process-order': {
					execute: async (ctx: WorkflowContext<{ orderId: string }>) => {
						// Capture both the meta and the logger's propagation meta to verify round-trip
						receivedMeta = ctx.meta as Record<string, unknown>;
						// Use the logger's propagationMeta() to verify context is properly restored
						receivedContext = ctx.log.propagationMeta();
						return { processed: true };
					}
				}
			};

			const contextProvider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-workflow',
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createCapturingWorkerClass((processor) => {
					capturedStepProcessor = processor;
				}) as any
			});

			contextProvider.registerDefinitionConsumer(
				'FullContextWorkflow',
				async () => {},
				fullContextStepGroups,
				fullContextStepHandlers
			);
			await contextProvider.start();

			// SIMULATE CONTROLLER CONTEXT:
			// In a real controller, this would come from middleware that creates
			// a Logger with correlationId from the incoming HTTP request
			const controllerRequestId = 'req-controller-12345';
			const controllerUserId = 'user-admin-67890';
			const controllerAccountUuid = 'account-uuid-abcdef';
			const controllerTraceId = 'trace-xyz-999';

			// Simulate the meta that would be passed from controller via logger.propagationMeta()
			// This is what the controller would pass to provider.execute()
			const controllerMeta = {
				request_id: controllerRequestId,
				user_id: controllerUserId,
				account_uuid: controllerAccountUuid,
				trace_id: controllerTraceId
			};

			// Simulate the job as it would be processed by the worker
			const mockJob = {
				queueName: 'test-workflow.FullContextWorkflow.steps',
				data: {
					flowId: 'flow-controller-test',
					stepName: 'process-order',
					workflowData: { orderId: 'order-123' },
					meta: controllerMeta
				},
				getChildrenValues: mock(() => Promise.resolve({}))
			};

			// Execute the step processor (simulates worker processing the job)
			await capturedStepProcessor!(mockJob);

			// VERIFY: Meta was passed through to the step handler
			expect(receivedMeta).toEqual(controllerMeta);

			// VERIFY: Logger.fromMeta() restored the context correctly
			// The logger's propagationMeta() should return the same context
			expect(receivedContext.request_id).toBe(controllerRequestId);
			expect(receivedContext.user_id).toBe(controllerUserId);
			expect(receivedContext.account_uuid).toBe(controllerAccountUuid);
			expect(receivedContext.trace_id).toBe(controllerTraceId);

			await contextProvider.stop();
		});

		it('should pass meta through execute() to job data for controller → workflow propagation', async () => {
			/**
			 * This test verifies the execute() side of context propagation:
			 * Controller calls execute() with meta, and that meta is stored in the job data.
			 */
			provider.registerDefinitionConsumer(
				'TestWorkflow',
				testOnComplete,
				testStepGroups,
				createTestStepHandlers()
			);
			await provider.start();

			// Controller-like meta that would come from logger.propagationMeta()
			const controllerMeta = {
				request_id: 'req-from-controller',
				user_id: 'user-making-request',
				account_uuid: 'account-owning-request'
			};

			await provider.execute(TestWorkflowDef, { value: 100 }, { meta: controllerMeta });

			// Verify the flow job was created with the meta
			const addCall = mockFlowProducer.add.mock.calls[0];
			expect(addCall).toBeDefined();
			const flowJob = addCall![0];

			// Root job should have meta
			expect(flowJob.data.meta).toEqual(controllerMeta);

			// Step children should also have meta (for when they're processed)
			expect(flowJob.children[0].data.meta).toEqual(controllerMeta);
		});
	});
});

describe('processDefinitionWorkflow functional tests', () => {
	it('should pass accumulated step results to handler when workflow completes', async () => {
		/**
		 * Functional test: Verifies that when a workflow with steps completes,
		 * the step results are correctly accumulated and passed to the onComplete handler.
		 *
		 * This tests the interaction between:
		 * - job.getChildrenValues() returning step results
		 * - flattenChildResults() processing the results
		 * - handler receiving the stepResults parameter
		 */
		let capturedWorkflowProcessor: ((job: unknown) => Promise<unknown>) | null = null;
		let receivedStepResults: Record<string, unknown> | undefined = undefined;
		let receivedData: unknown = undefined;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-123' } })),
			close: mock(() => Promise.resolve())
		};

		const mockWorker = {
			close: mock(() => Promise.resolve()),
			on: mock(() => mockWorker),
			connection: { _client: { on: mock(() => {}) } },
			blockingConnection: { _client: { on: mock(() => {}) } }
		};

		// Create Worker class that captures the workflow processor (not step processor)
		const CapturingWorkflowWorkerClass = class {
			public close = mock(() => Promise.resolve());
			public on = mock(() => this);
			public connection = { _client: { on: mock(() => {}) } };
			public blockingConnection = { _client: { on: mock(() => {}) } };

			constructor(queueName: string, processor: (job: unknown) => Promise<unknown>, _opts: unknown) {
				// Capture workflow processor (not .steps queue)
				if (!queueName.endsWith('.steps')) {
					capturedWorkflowProcessor = processor;
				}
			}
		};

		const FlowProducerClass = class {
			public add = mockFlowProducer.add;
			public close = mockFlowProducer.close;
		};

		// Step groups with multiple steps
		const stepGroupsForTest = [
			{
				type: 'sequential' as const,
				definitions: [{ name: 'step-a' }, { name: 'step-b' }]
			}
		];

		// Handler that captures what it receives
		const capturingHandler = async (
			data: unknown,
			_meta: Record<string, unknown> | undefined,
			stepResults: Record<string, unknown> | undefined
		): Promise<{ final: string }> => {
			receivedData = data;
			receivedStepResults = stepResults;
			return { final: 'done' };
		};

		const stepHandlers = {
			'step-a': { execute: async () => ({ resultA: 'valueA' }) },
			'step-b': { execute: async () => ({ resultB: 'valueB' }) }
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-workflow',
			FlowProducerClass: FlowProducerClass as any,
			WorkerClass: CapturingWorkflowWorkerClass as any
		});

		provider.registerDefinitionConsumer('MultiStepTest', capturingHandler, stepGroupsForTest, stepHandlers);
		await provider.start();

		expect(capturedWorkflowProcessor).not.toBeNull();

		// Simulate workflow job with child results (as returned by BullMQ)
		// The format matches what flattenChildResults expects: queueName:jobId -> wrapped result
		const mockWorkflowJob = {
			queueName: 'test-workflow.MultiStepTest',
			data: {
				version: '1.0',
				flowId: 'flow-abc',
				workflowData: { input: 'test-input' },
				stepResults: {},
				meta: { request_id: 'req-123' }
			},
			getChildrenValues: mock(() =>
				Promise.resolve({
					// BullMQ returns child results keyed by queueName:jobId as parsed objects
					'test-workflow.MultiStepTest.steps:step-a-job': {
						__version: '1',
						__stepName: 'step-a',
						__stepResult: { resultA: 'valueA' },
						__priorResults: {}
					},
					'test-workflow.MultiStepTest.steps:step-b-job': {
						__version: '1',
						__stepName: 'step-b',
						__stepResult: { resultB: 'valueB' },
						__priorResults: { 'step-a': { resultA: 'valueA' } }
					}
				})
			)
		};

		// Process the workflow job
		await capturedWorkflowProcessor!(mockWorkflowJob);

		// Verify handler received the workflow data
		expect(receivedData).toEqual({ input: 'test-input' });

		// Verify handler received accumulated step results
		expect(receivedStepResults).toBeDefined();
		expect(receivedStepResults!['step-a']).toEqual({ resultA: 'valueA' });
		expect(receivedStepResults!['step-b']).toEqual({ resultB: 'valueB' });

		await provider.stop();
	});
});

describe('calculateEffectiveTimeout edge cases', () => {
	/**
	 * These tests verify the timeout calculation behavior through observable effects.
	 * The private calculateEffectiveTimeout method:
	 * - Returns 0 when baseTimeout <= 0 (timeout disabled, no setTimeout called)
	 * - Returns baseTimeout + stallInterval when baseTimeout > 0
	 * - Uses DEFAULT_STALL_INTERVAL_MS (5000) when stallInterval not configured
	 */

	const DEFAULT_STALL_INTERVAL_MS = 5000; // Match the constant in source

	// Define workflow for timeout tests
	const TimeoutTestWorkflow = Workflow.define({
		name: 'TimeoutTest',
		data: Type.Object({ val: Type.Number() }),
		result: Type.Void()
	});

	it('should not set workflow timeout when timeout is 0 (disabled)', async () => {
		const setTimeoutCalls: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			setTimeoutCalls.push(ms);
			return originalSetTimeout(fn, ms);
		}) as typeof globalThis.setTimeout;

		try {
			const mockFlowProducer = {
				add: mock(() => Promise.resolve({ job: { id: 'flow-timeout-0' } })),
				close: mock(() => Promise.resolve())
			};

			const provider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout',
				defaultTimeout: 0, // Timeout disabled by default
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass({
					close: mock(() => Promise.resolve()),
					on: mock(() => ({})),
					connection: createMockRedisConnection(),
					blockingConnection: createMockRedisConnection()
				}) as any
			});

			provider.registerDefinitionConsumer('TimeoutTest', async () => {}, [], {});
			await provider.start();

			setTimeoutCalls.length = 0; // Clear any setup timeouts

			await provider.execute(TimeoutTestWorkflow, { val: 1 }, { timeout: 0 });

			// When timeout is 0, calculateEffectiveTimeout returns 0, so no workflow timeout is set.
			// Other timeouts may exist (e.g., flow state cleanup at 300000ms).
			// Verify no timeout in the workflow timeout range (baseTimeout + stallInterval).
			// With timeout=0, if it were incorrectly handled, we'd see 0+5000=5000.
			const potentialWorkflowTimeout = 0 + DEFAULT_STALL_INTERVAL_MS; // Would be 5000 if not disabled
			expect(setTimeoutCalls).not.toContain(potentialWorkflowTimeout);

			await provider.stop();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it('should add default stallInterval (5000ms) to timeout when not configured', async () => {
		const setTimeoutCalls: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			setTimeoutCalls.push(ms);
			return originalSetTimeout(fn, ms);
		}) as typeof globalThis.setTimeout;

		try {
			const mockFlowProducer = {
				add: mock(() => Promise.resolve({ job: { id: 'flow-default-stall' } })),
				close: mock(() => Promise.resolve())
			};

			const provider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout',
				// stallInterval NOT set - should use default 5000ms
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass({
					close: mock(() => Promise.resolve()),
					on: mock(() => ({})),
					connection: createMockRedisConnection(),
					blockingConnection: createMockRedisConnection()
				}) as any
			});

			provider.registerDefinitionConsumer('TimeoutTest', async () => {}, [], {});
			await provider.start();

			setTimeoutCalls.length = 0;

			const baseTimeout = 10000;
			await provider.execute(TimeoutTestWorkflow, { val: 1 }, { timeout: baseTimeout });

			// Effective timeout should be baseTimeout + DEFAULT_STALL_INTERVAL_MS
			const expectedTimeout = baseTimeout + DEFAULT_STALL_INTERVAL_MS;
			expect(setTimeoutCalls).toContain(expectedTimeout);

			await provider.stop();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it('should add custom stallInterval to timeout when configured', async () => {
		const setTimeoutCalls: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			setTimeoutCalls.push(ms);
			return originalSetTimeout(fn, ms);
		}) as typeof globalThis.setTimeout;

		try {
			const mockFlowProducer = {
				add: mock(() => Promise.resolve({ job: { id: 'flow-custom-stall' } })),
				close: mock(() => Promise.resolve())
			};

			const customStallInterval = 8000;
			const provider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout',
				stallInterval: customStallInterval, // Custom value
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass({
					close: mock(() => Promise.resolve()),
					on: mock(() => ({})),
					connection: createMockRedisConnection(),
					blockingConnection: createMockRedisConnection()
				}) as any
			});

			provider.registerDefinitionConsumer('TimeoutTest', async () => {}, [], {});
			await provider.start();

			setTimeoutCalls.length = 0;

			const baseTimeout = 15000;
			await provider.execute(TimeoutTestWorkflow, { val: 1 }, { timeout: baseTimeout });

			// Effective timeout should be baseTimeout + customStallInterval
			const expectedTimeout = baseTimeout + customStallInterval;
			expect(setTimeoutCalls).toContain(expectedTimeout);

			await provider.stop();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});
});

describe('pending result not-found paths', () => {
	/**
	 * Tests for graceful handling when pending results are not found.
	 * This happens in distributed scenarios where:
	 * - Instance A calls execute() and registers pending result
	 * - Instance B processes the job (has no pending entry for it)
	 * - Instance B's step failure calls rejectPendingByFlowId (no-op)
	 */

	it('should gracefully handle step failure when no pending entry exists (non-caller instance)', async () => {
		/**
		 * Simulates a step failing on a non-caller instance.
		 * The instance processing the step won't have a pending entry because
		 * it didn't call execute() - another instance did.
		 * rejectPendingByFlowId should be a no-op without throwing.
		 */
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-non-caller' } })),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-pending',
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		const failingStepHandlers = {
			'failing-step': {
				execute: async () => {
					throw new Error('Step intentionally failed');
				}
			}
		};

		provider.registerDefinitionConsumer(
			'FailingWorkflow',
			async () => {},
			[{ type: 'sequential' as const, definitions: [{ name: 'failing-step' }] }],
			failingStepHandlers
		);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		// Simulate job arriving WITHOUT a corresponding pending entry
		// (as would happen on a non-caller instance in distributed setup)
		const mockJob = {
			queueName: 'test-pending.FailingWorkflow.steps',
			data: {
				flowId: 'flow-unknown-to-this-instance', // No pending entry for this
				stepName: 'failing-step',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() => Promise.resolve({}))
		};

		// Should throw the step error but NOT cause unhandled rejection
		// from rejectPendingByFlowId (it should be a no-op)
		await expect(capturedStepProcessor!(mockJob)).rejects.toThrow('Step intentionally failed');

		await provider.stop();
	});

	it('should gracefully handle cleanup when pending entries exist during stop', async () => {
		/**
		 * When stop() is called while pending entries exist, cleanup should
		 * proceed without errors. This verifies graceful shutdown handling.
		 */
		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-settle-test' } })),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-settle',
			defaultTimeout: 0, // Disable timeout for this test
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass({
				close: mock(() => Promise.resolve()),
				on: mock(() => ({})),
				connection: createMockRedisConnection(),
				blockingConnection: createMockRedisConnection()
			}) as any
		});

		provider.registerDefinitionConsumer('SettleWorkflow', async () => {}, [], {});
		await provider.start();

		// Start execution but don't await (creates pending entry)
		const executePromise = provider.execute(
			Workflow.define({
				name: 'SettleWorkflow',
				data: Type.Object({ test: Type.Boolean() }),
				result: Type.Void()
			}),
			{ test: true }
		);

		// Give it a moment to register the pending entry
		await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

		// Stop should cleanly handle pending entries without errors
		let stopError: Error | undefined;
		try {
			await provider.stop();
		} catch (err) {
			stopError = err as Error;
		}
		expect(stopError).toBeUndefined();

		// The execute promise will be left dangling (never resolves)
		// This is expected - in production, the workflow would complete via QueueEvents
		void executePromise.catch(() => {}); // Suppress unhandled rejection
	});
});

describe('createBullMQWorkflowProvider', () => {
	it('should create a new BullMQWorkflowProvider instance', () => {
		const provider = createBullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 }
		});

		expect(provider).toBeInstanceOf(BullMQWorkflowProvider);
	});

	it('should create provider with custom options', () => {
		const provider = createBullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'custom-prefix',
			defaultTimeout: 60000
		});

		expect(provider).toBeInstanceOf(BullMQWorkflowProvider);
	});
});

describe('rollback error logging', () => {
	/**
	 * Tests that rollback errors are logged with just the error message string,
	 * not the full Error object. This prevents potential PII/sensitive data
	 * from stack traces being logged.
	 */

	it('should log rollback error message as string, not full Error object', async () => {
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;
		const errorLogCalls: { message: string; context: Record<string, unknown> }[] = [];

		const mockLogger = {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock((message: string, context?: Record<string, unknown>) => {
				errorLogCalls.push({ message, context: context ?? {} });
			}),
			debug: mock(() => {}),
			child: mock(() => mockLogger)
		};

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-rollback-test' } })),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-rollback',
			logger: mockLogger as any,
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		// Step handlers: step-one succeeds with rollback, step-two fails
		const stepHandlers = {
			'step-one': {
				execute: async () => ({ done: true }),
				rollback: async () => {
					throw new Error('Rollback failed intentionally');
				}
			},
			'step-two': {
				execute: async () => {
					throw new Error('Step execution failed');
				}
			}
		};

		const stepGroups = [
			{
				type: 'sequential' as const,
				definitions: [{ name: 'step-one' }, { name: 'step-two' }]
			}
		];

		provider.registerDefinitionConsumer('RollbackTestWorkflow', async () => {}, stepGroups, stepHandlers);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		// Simulate step-two job (which fails and triggers rollback of step-one)
		// Include prior results showing step-one completed
		const mockJob = {
			queueName: 'test-rollback.RollbackTestWorkflow.steps',
			data: {
				flowId: 'flow-rollback-test',
				stepName: 'step-two',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() =>
				Promise.resolve({
					'test-rollback.RollbackTestWorkflow.steps:step-one-job': {
						__version: '1',
						__stepName: 'step-one',
						__stepResult: { done: true },
						__priorResults: {}
					}
				})
			)
		};

		// Execute - will throw step execution error after rollback attempt
		await expect(capturedStepProcessor!(mockJob)).rejects.toThrow('Step execution failed');

		// Find the rollback error log
		const rollbackErrorLog = errorLogCalls.find((call) => call.message === 'Rollback failed');

		expect(rollbackErrorLog).toBeDefined();
		expect(rollbackErrorLog!.context.step).toBe('step-one');
		expect(rollbackErrorLog!.context.flowId).toBe('flow-rollback-test');

		// CRITICAL: Verify error is logged as string message, not full Error object
		expect(typeof rollbackErrorLog!.context.error).toBe('string');
		expect(rollbackErrorLog!.context.error).toBe('Rollback failed intentionally');

		await provider.stop();
	});
});

describe('step execution timeout', () => {
	/**
	 * Tests that individual step execution has a timeout to prevent infinite hangs.
	 * Without step timeout, a step handler that never resolves would block the worker forever.
	 *
	 * Issue: Step handlers in processStep() and executeParallelSteps() run without timeout.
	 * Fix: Wrap handler calls with Promise.race timeout.
	 */

	it('should timeout step execution when handler exceeds stepTimeout', async () => {
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-step-timeout' } })),
			close: mock(() => Promise.resolve())
		};

		// Configure provider with short step timeout (100ms)
		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-step-timeout',
			stepTimeout: 100, // 100ms step timeout
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		// Step handler that takes longer than the timeout
		const slowStepHandlers = {
			'slow-step': {
				execute: async () => {
					// Simulate a step that takes too long (500ms > 100ms timeout)
					await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
					return { completed: true };
				}
			}
		};

		const stepGroups = [
			{
				type: 'sequential' as const,
				definitions: [{ name: 'slow-step' }]
			}
		];

		provider.registerDefinitionConsumer('SlowStepWorkflow', async () => {}, stepGroups, slowStepHandlers);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		// Simulate the job
		const mockJob = {
			queueName: 'test-step-timeout.SlowStepWorkflow.steps',
			data: {
				flowId: 'flow-slow-step',
				stepName: 'slow-step',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() => Promise.resolve({}))
		};

		// Step should timeout and throw an error
		await expect(capturedStepProcessor!(mockJob)).rejects.toThrow(/timed out/i);

		await provider.stop();
	});

	it('should complete step normally when handler finishes within stepTimeout', async () => {
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-fast-step' } })),
			close: mock(() => Promise.resolve())
		};

		// Configure provider with reasonable step timeout (1000ms)
		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-step-timeout',
			stepTimeout: 1000, // 1 second step timeout
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		// Step handler that completes quickly
		const fastStepHandlers = {
			'fast-step': {
				execute: async () => {
					// Quick step (10ms < 1000ms timeout)
					await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
					return { completed: true };
				}
			}
		};

		const stepGroups = [
			{
				type: 'sequential' as const,
				definitions: [{ name: 'fast-step' }]
			}
		];

		provider.registerDefinitionConsumer('FastStepWorkflow', async () => {}, stepGroups, fastStepHandlers);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		// Simulate the job
		const mockJob = {
			queueName: 'test-step-timeout.FastStepWorkflow.steps',
			data: {
				flowId: 'flow-fast-step',
				stepName: 'fast-step',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() => Promise.resolve({}))
		};

		// Step should complete successfully
		const result = await capturedStepProcessor!(mockJob);
		expect(result).toHaveProperty('__stepResult');
		expect((result as any).__stepResult).toEqual({ completed: true });

		await provider.stop();
	});

	it('should timeout parallel step execution when any handler exceeds stepTimeout', async () => {
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-parallel-timeout' } })),
			close: mock(() => Promise.resolve())
		};

		// Configure provider with short step timeout
		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-parallel-timeout',
			stepTimeout: 100, // 100ms step timeout
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		// One fast step, one slow step (will timeout)
		const parallelStepHandlers = {
			'fast-parallel': {
				execute: async () => {
					await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
					return { fast: true };
				}
			},
			'slow-parallel': {
				execute: async () => {
					// This will timeout (500ms > 100ms)
					await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
					return { slow: true };
				}
			}
		};

		const stepGroups = [
			{
				type: 'parallel' as const,
				definitions: [{ name: 'fast-parallel' }, { name: 'slow-parallel' }]
			}
		];

		provider.registerDefinitionConsumer(
			'ParallelTimeoutWorkflow',
			async () => {},
			stepGroups,
			parallelStepHandlers
		);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		// Simulate the parallel group job
		const mockJob = {
			queueName: 'test-parallel-timeout.ParallelTimeoutWorkflow.steps',
			data: {
				flowId: 'flow-parallel-timeout',
				stepName: '__parallel__:fast-parallel,slow-parallel',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() => Promise.resolve({}))
		};

		// Should fail because slow-parallel times out
		await expect(capturedStepProcessor!(mockJob)).rejects.toThrow(/timed out/i);

		await provider.stop();
	});

	it('should use default step timeout when not configured', async () => {
		/**
		 * When stepTimeout is not explicitly set, there should be no step-level timeout
		 * (only workflow-level timeout applies). This maintains backward compatibility.
		 */
		let capturedStepProcessor: ((job: unknown) => Promise<unknown>) | null = null;

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-no-step-timeout' } })),
			close: mock(() => Promise.resolve())
		};

		// NO stepTimeout configured - should use default (0 = disabled)
		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-default-timeout',
			// stepTimeout NOT set
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createCapturingWorkerClass((processor) => {
				capturedStepProcessor = processor;
			}) as any
		});

		// Step that completes after a short delay
		const stepHandlers = {
			'normal-step': {
				execute: async () => {
					await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
					return { done: true };
				}
			}
		};

		const stepGroups = [
			{
				type: 'sequential' as const,
				definitions: [{ name: 'normal-step' }]
			}
		];

		provider.registerDefinitionConsumer('NoTimeoutWorkflow', async () => {}, stepGroups, stepHandlers);
		await provider.start();

		expect(capturedStepProcessor).not.toBeNull();

		const mockJob = {
			queueName: 'test-default-timeout.NoTimeoutWorkflow.steps',
			data: {
				flowId: 'flow-no-timeout',
				stepName: 'normal-step',
				workflowData: { test: true },
				meta: {}
			},
			getChildrenValues: mock(() => Promise.resolve({}))
		};

		// Should complete normally since no step timeout is configured
		const result = await capturedStepProcessor!(mockJob);
		expect(result).toHaveProperty('__stepResult');
		expect((result as any).__stepResult).toEqual({ done: true });

		await provider.stop();
	});
});

describe('correlation ID propagation', () => {
	/**
	 * Tests that correlationId (correlation ID) from the controller's request context
	 * is properly propagated to workflow job data and available in step execution.
	 *
	 * Issue: When execute() is called from a controller, the correlationId from the
	 * HTTP request context should flow through to workflow steps for distributed tracing.
	 */

	it('should capture correlationId from AsyncLocalStorage context when execute is called', async () => {
		// Import runWithContext from logging to simulate controller context
		const { runWithContext, Logger } = await import('@orijs/logging');

		let capturedJobData: unknown = null;

		const mockFlowProducer = {
			add: mock((flow: unknown) => {
				capturedJobData = flow;
				return Promise.resolve({ job: { id: 'flow-correlation-test' } });
			}),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-correlation',
			defaultTimeout: 0, // Disable timeout for this test
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass({
				close: mock(() => Promise.resolve()),
				on: mock(() => ({})),
				connection: createMockRedisConnection(),
				blockingConnection: createMockRedisConnection()
			}) as any
		});

		provider.registerDefinitionConsumer('CorrelationWorkflow', async () => {}, [], {});
		await provider.start();

		// Simulate calling execute() from within a controller context
		// This is what happens when an HTTP request handler calls execute()
		const testRequestId = 'test-correlation-id-123';
		const testLogger = new Logger('test');

		await runWithContext(
			{
				log: testLogger,
				correlationId: testRequestId,
				trace: {
					traceId: 'trace-abc',
					spanId: 'span-xyz'
				}
			},
			async () => {
				await provider.execute(
					Workflow.define({
						name: 'CorrelationWorkflow',
						data: Type.Object({ value: Type.Number() }),
						result: Type.Void()
					}),
					{ value: 42 }
				);
			}
		);

		// Verify the job data includes the captured correlationId
		expect(capturedJobData).toBeDefined();
		const jobData = (capturedJobData as { data: { meta?: Record<string, unknown> } }).data;
		expect(jobData.meta).toBeDefined();
		expect(jobData.meta!.correlationId).toBe(testRequestId);
		// Should also include trace context
		expect(jobData.meta!.traceId).toBe('trace-abc');

		await provider.stop();
	});

	it('should capture application metadata (userId, action) from setMeta in context', async () => {
		const { runWithContext, setMeta, Logger } = await import('@orijs/logging');

		let capturedJobData: unknown = null;

		const mockFlowProducer = {
			add: mock((flow: unknown) => {
				capturedJobData = flow;
				return Promise.resolve({ job: { id: 'flow-meta-test' } });
			}),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-meta',
			defaultTimeout: 0,
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass({
				close: mock(() => Promise.resolve()),
				on: mock(() => ({})),
				connection: createMockRedisConnection(),
				blockingConnection: createMockRedisConnection()
			}) as any
		});

		provider.registerDefinitionConsumer('MetaWorkflow', async () => {}, [], {});
		await provider.start();

		const testLogger = new Logger('test');

		await runWithContext(
			{
				log: testLogger,
				correlationId: 'req-456'
			},
			async () => {
				// Simulate guard setting user metadata (like AuthGuard does)
				setMeta({ userId: 'user-123', accountUuid: 'account-abc', action: 'signup' });

				await provider.execute(
					Workflow.define({
						name: 'MetaWorkflow',
						data: Type.Object({ data: Type.String() }),
						result: Type.Void()
					}),
					{ data: 'test' }
				);
			}
		);

		// Verify all metadata is captured
		const jobData = (capturedJobData as { data: { meta?: Record<string, unknown> } }).data;
		expect(jobData.meta).toBeDefined();
		expect(jobData.meta!.correlationId).toBe('req-456');
		expect(jobData.meta!.userId).toBe('user-123');
		expect(jobData.meta!.accountUuid).toBe('account-abc');
		expect(jobData.meta!.action).toBe('signup');

		await provider.stop();
	});

	it('should propagate auto-generated correlationId when no header provided', async () => {
		/**
		 * When a controller receives a request WITHOUT x-correlation-id header,
		 * the request pipeline generates a UUID. This test verifies that auto-generated
		 * ID flows through to workflow job data.
		 */
		const { runWithContext, Logger } = await import('@orijs/logging');

		let capturedJobData: unknown = null;

		const mockFlowProducer = {
			add: mock((flow: unknown) => {
				capturedJobData = flow;
				return Promise.resolve({ job: { id: 'flow-auto-gen-id' } });
			}),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-auto-gen',
			defaultTimeout: 0,
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass({
				close: mock(() => Promise.resolve()),
				on: mock(() => ({})),
				connection: createMockRedisConnection(),
				blockingConnection: createMockRedisConnection()
			}) as any
		});

		provider.registerDefinitionConsumer('AutoGenWorkflow', async () => {}, [], {});
		await provider.start();

		const testLogger = new Logger('test');
		// Simulate what request-pipeline does when NO header is provided:
		// it generates a UUID and passes it to runWithContext
		const autoGeneratedId = crypto.randomUUID();

		await runWithContext(
			{
				log: testLogger,
				correlationId: autoGeneratedId // This simulates the auto-generated ID
			},
			async () => {
				await provider.execute(
					Workflow.define({
						name: 'AutoGenWorkflow',
						data: Type.Object({ value: Type.Number() }),
						result: Type.Void()
					}),
					{ value: 1 }
				);
			}
		);

		// Verify the auto-generated ID was captured
		const jobData = (capturedJobData as { data: { meta?: Record<string, unknown> } }).data;
		expect(jobData.meta).toBeDefined();
		expect(jobData.meta!.correlationId).toBe(autoGeneratedId);
		// Verify it's a valid UUID format
		expect(jobData.meta!.correlationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		);

		await provider.stop();
	});

	it('should log warning when execute is called without request context', async () => {
		const debugLogCalls: { message: string; context?: Record<string, unknown> }[] = [];

		const mockLogger = {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock((message: string, context?: Record<string, unknown>) => {
				debugLogCalls.push({ message, context });
			}),
			child: mock(() => mockLogger)
		};

		const mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-no-context' } })),
			close: mock(() => Promise.resolve())
		};

		const provider = new BullMQWorkflowProvider({
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-no-context',
			defaultTimeout: 0,
			logger: mockLogger as any,
			FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
			WorkerClass: createMockWorkerClass({
				close: mock(() => Promise.resolve()),
				on: mock(() => ({})),
				connection: createMockRedisConnection(),
				blockingConnection: createMockRedisConnection()
			}) as any
		});

		provider.registerDefinitionConsumer('NoContextWorkflow', async () => {}, [], {});
		await provider.start();

		// Call execute WITHOUT being inside a runWithContext
		// This simulates calling from a script or background job
		await provider.execute(
			Workflow.define({
				name: 'NoContextWorkflow',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Void()
			}),
			{ value: 1 }
		);

		// Should log debug warning about missing correlation ID
		const warningLog = debugLogCalls.find((call) => call.message.includes('without propagation metadata'));
		expect(warningLog).toBeDefined();

		await provider.stop();
	});
});
