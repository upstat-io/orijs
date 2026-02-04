/**
 * Memory Leak Tests for BullMQWorkflowProvider
 *
 * Tests that verify flow state entries are properly cleaned up to prevent memory leaks.
 *
 * The `localFlowStates` Map tracks flow states, and without cleanup, it would
 * accumulate entries indefinitely. Flows are added in execute() and must be
 * removed after completion/failure to prevent unbounded memory growth.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';
import {
	BullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions
} from '../../src/workflows/bullmq-workflow-provider.ts';

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
 * Mock FlowProducer for testing
 */
interface MockFlowProducer {
	add: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
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
 * Mock QueueEvents with controllable event callbacks
 */
interface MockQueueEvents {
	on: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
	waitUntilReady: ReturnType<typeof mock>;
	connection: MockRedisConnection;
	_eventHandlers: Map<string, ((...args: unknown[]) => void)[]>;
	emit(event: string, ...args: unknown[]): void;
}

function createMockQueueEvents(): MockQueueEvents {
	const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
	const mockEvents: MockQueueEvents = {
		_eventHandlers: eventHandlers,
		on: mock((event: string, callback: (...args: unknown[]) => void) => {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(callback);
			return mockEvents;
		}),
		close: mock(() => Promise.resolve()),
		waitUntilReady: mock(() => Promise.resolve()),
		connection: createMockRedisConnection(),
		emit(event: string, ...args: unknown[]) {
			const handlers = this._eventHandlers.get(event) ?? [];
			for (const handler of handlers) {
				handler(...args);
			}
		}
	};
	return mockEvents;
}

/**
 * Create mock FlowProducer class that respects opts.jobId for deduplication.
 */
function createMockFlowProducerClass(mockFlowProducer: MockFlowProducer) {
	let jobIdCounter = 0;
	return class MockFlowProducerClass {
		public add = mock((flowJob: { opts?: { jobId?: string } }) => {
			// Use opts.jobId if provided for predictable job identification
			const jobId = flowJob.opts?.jobId ?? `job-${++jobIdCounter}`;
			return Promise.resolve({ job: { id: jobId } });
		});
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

// Define workflow using definition-based API
const SimpleWorkflowDef = Workflow.define({
	name: 'simple-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

// Step groups for SimpleWorkflow
const simpleStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'process' }]
	}
];

// Step handlers for SimpleWorkflow
const createSimpleStepHandlers = () => ({
	process: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { computed: ctx.data.value * 2 };
		}
	}
});

// onComplete handler for SimpleWorkflow
const simpleOnComplete = async (
	_data: unknown,
	_meta: Record<string, unknown> | undefined,
	stepResults: Record<string, unknown> | undefined
): Promise<{ result: number }> => {
	const processResult = stepResults?.['process'] as { computed: number } | undefined;
	return { result: processResult?.computed ?? 0 };
};

describe('BullMQWorkflowProvider Memory Leak', () => {
	let mockFlowProducer: MockFlowProducer;
	let mockWorker: MockWorker;
	let mockQueueEvents: MockQueueEvents;
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

		mockQueueEvents = createMockQueueEvents();
	});

	afterEach(async () => {
		if (provider) {
			await provider.stop();
		}
	});

	describe('localFlowStates cleanup', () => {
		it('should retain flow state until cleanup delay expires (when cleanup is disabled)', async () => {
			/**
			 * This test verifies that flow states remain available for status checks
			 * until the cleanup delay expires.
			 *
			 * With cleanup disabled (flowStateCleanupDelay: 0), entries remain forever.
			 * This demonstrates the behavior when cleanup is not configured.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-memory-leak',
				defaultTimeout: 0, // Disable timeout for this test
				flowStateCleanupDelay: 0, // Disable cleanup to show entries persist
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				QueueEventsClass: class {
					public on = mockQueueEvents.on;
					public close = mockQueueEvents.close;
					public waitUntilReady = mockQueueEvents.waitUntilReady;
					public connection = mockQueueEvents.connection;
				} as any
			};

			provider = new BullMQWorkflowProvider(options);
			provider.registerDefinitionConsumer(
				'simple-workflow',
				simpleOnComplete,
				simpleStepGroups,
				createSimpleStepHandlers()
			);
			await provider.start();

			// Execute 5 workflows
			const flowIds: string[] = [];
			for (let i = 0; i < 5; i++) {
				const handle = await provider.execute(SimpleWorkflowDef, { value: i });
				flowIds.push(handle.id);
			}

			// Verify all flows are tracked (status should be 'running' since we set it after job submission)
			for (const flowId of flowIds) {
				const status = await provider.getStatus(flowId);
				expect(status).toBe('running');
			}

			// Simulate completion of all workflows via QueueEvents
			for (let i = 0; i < flowIds.length; i++) {
				mockQueueEvents.emit('completed', {
					jobId: flowIds[i],
					returnvalue: JSON.stringify({ result: i * 2 })
				});
			}

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// With cleanup disabled, entries persist forever (this was the original bug behavior)
			// getStatus returns 'completed' because entries are still in localFlowStates
			for (const flowId of flowIds) {
				const status = await provider.getStatus(flowId);
				expect(status).toBe('completed'); // Entries persist when cleanup is disabled
			}
		});

		it('should retain failed flow state until cleanup delay expires (demonstrates prior behavior without cleanup)', async () => {
			/**
			 * Same test for failed flows - with cleanup disabled, entries persist forever.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-memory-leak',
				defaultTimeout: 0,
				flowStateCleanupDelay: 0, // Disable cleanup to show entries persist
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				QueueEventsClass: class {
					public on = mockQueueEvents.on;
					public close = mockQueueEvents.close;
					public waitUntilReady = mockQueueEvents.waitUntilReady;
					public connection = mockQueueEvents.connection;
				} as any
			};

			provider = new BullMQWorkflowProvider(options);
			provider.registerDefinitionConsumer(
				'simple-workflow',
				simpleOnComplete,
				simpleStepGroups,
				createSimpleStepHandlers()
			);
			await provider.start();

			// Execute 3 workflows
			const flowIds: string[] = [];
			for (let i = 0; i < 3; i++) {
				const handle = await provider.execute(SimpleWorkflowDef, { value: i });
				flowIds.push(handle.id);
			}

			// Simulate failure of all workflows via QueueEvents
			for (let i = 0; i < flowIds.length; i++) {
				mockQueueEvents.emit('failed', {
					jobId: flowIds[i],
					failedReason: `Simulated failure ${i}`
				});
			}

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// With cleanup disabled, entries persist forever (this was the original bug behavior)
			for (const flowId of flowIds) {
				const status = await provider.getStatus(flowId);
				expect(status).toBe('failed'); // Entries persist when cleanup is disabled
			}
		});

		it('should clean up localFlowStates after workflow completion', async () => {
			/**
			 * This test verifies that entries are removed from localFlowStates
			 * after a short delay following completion.
			 *
			 * Cleanup uses setTimeout to schedule removal after completion.
			 * For testing, we use a shorter delay (100ms) to avoid slow tests.
			 */
			const CLEANUP_DELAY_MS = 100; // Short delay for testing

			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-memory-leak',
				defaultTimeout: 0,
				flowStateCleanupDelay: CLEANUP_DELAY_MS, // Use short delay for testing
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				QueueEventsClass: class {
					public on = mockQueueEvents.on;
					public close = mockQueueEvents.close;
					public waitUntilReady = mockQueueEvents.waitUntilReady;
					public connection = mockQueueEvents.connection;
				} as any
			};

			provider = new BullMQWorkflowProvider(options);
			provider.registerDefinitionConsumer(
				'simple-workflow',
				simpleOnComplete,
				simpleStepGroups,
				createSimpleStepHandlers()
			);
			await provider.start();

			// Execute a workflow
			const handle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = handle.id;

			// Verify it's tracked
			expect(await provider.getStatus(flowId)).toBe('running');

			// Simulate completion
			mockQueueEvents.emit('completed', {
				jobId: flowId,
				returnvalue: JSON.stringify({ result: 84 })
			});

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Immediately after completion, entry should still exist (status = completed)
			expect(await provider.getStatus(flowId)).toBe('completed');

			// Wait for cleanup delay
			await new Promise((resolve) => setTimeout(resolve, CLEANUP_DELAY_MS + 50));

			// Entry should be cleaned up, getStatus returns 'pending' (default for unknown)
			const statusAfterCleanup = await provider.getStatus(flowId);
			expect(statusAfterCleanup).toBe('pending'); // Entry cleaned up, prevents memory leak
		});

		it('should clean up localFlowStates after workflow failure', async () => {
			/**
			 * Same test for failed workflows - should be cleaned up after delay.
			 */
			const CLEANUP_DELAY_MS = 100;

			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-memory-leak',
				defaultTimeout: 0,
				flowStateCleanupDelay: CLEANUP_DELAY_MS, // Use short delay for testing
				FlowProducerClass: createMockFlowProducerClass(mockFlowProducer) as any,
				WorkerClass: createMockWorkerClass(mockWorker) as any,
				QueueEventsClass: class {
					public on = mockQueueEvents.on;
					public close = mockQueueEvents.close;
					public waitUntilReady = mockQueueEvents.waitUntilReady;
					public connection = mockQueueEvents.connection;
				} as any
			};

			provider = new BullMQWorkflowProvider(options);
			provider.registerDefinitionConsumer(
				'simple-workflow',
				simpleOnComplete,
				simpleStepGroups,
				createSimpleStepHandlers()
			);
			await provider.start();

			// Execute a workflow
			const handle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = handle.id;

			// Simulate failure
			mockQueueEvents.emit('failed', {
				jobId: flowId,
				failedReason: 'Test failure'
			});

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Immediately after failure, entry should still exist
			expect(await provider.getStatus(flowId)).toBe('failed');

			// Wait for cleanup delay
			await new Promise((resolve) => setTimeout(resolve, CLEANUP_DELAY_MS + 50));

			// Entry should be cleaned up
			const statusAfterCleanup = await provider.getStatus(flowId);
			expect(statusAfterCleanup).toBe('pending'); // Entry cleaned up, prevents memory leak
		});
	});
});
