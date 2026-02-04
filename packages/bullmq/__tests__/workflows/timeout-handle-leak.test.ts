/**
 * Timeout Handle Memory Leak Tests for BullMQWorkflowProvider
 *
 * Tests that verify timeout handles are properly cleaned up to prevent memory leaks.
 *
 * The `timeoutHandles` Map tracks timeout handles, and cleanup must occur
 * when the workflow completes (via the promise .finally() handler), not just
 * when the timeout actually fires or stop() is called.
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
 * Create mock FlowProducer class that respects opts.jobId
 */
function createMockFlowProducerClass(mockFlowProducer: MockFlowProducer) {
	let jobIdCounter = 0;
	return class MockFlowProducerClass {
		public add = mock((flowJob: { opts?: { jobId?: string } }) => {
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

/**
 * Helper to access private members for testing
 */
function getPrivateMap<K, V>(provider: BullMQWorkflowProvider, mapName: string): Map<K, V> {
	return (provider as unknown as Record<string, Map<K, V>>)[mapName]!;
}

describe('BullMQWorkflowProvider Timeout Handle Memory Leak', () => {
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

	describe('timeoutHandles cleanup', () => {
		it('should clean up timeout handle when workflow completes normally before timeout', async () => {
			/**
			 * This test verifies that timeout handles are cleaned up when a workflow
			 * completes normally (before the timeout fires).
			 *
			 * The cleanup should happen in the .finally() handler of resultPromise.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: 30000, // 30 second timeout (won't fire in this test)
				flowStateCleanupDelay: 0, // Disable flow state cleanup for this test
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

			// Get reference to private timeoutHandles map
			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');

			// Execute a workflow
			const handle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = handle.id;

			// Verify timeout handle was created
			expect(timeoutHandles.has(flowId)).toBe(true);

			// Simulate workflow completion via QueueEvents
			mockQueueEvents.emit('completed', {
				jobId: flowId,
				returnvalue: JSON.stringify({ result: 84 })
			});

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify timeout handle was cleaned up
			expect(timeoutHandles.has(flowId)).toBe(false);
		});

		it('should clean up timeout handle when workflow fails before timeout', async () => {
			/**
			 * Same test but for workflow failure path.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: 30000,
				flowStateCleanupDelay: 0,
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

			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');

			// Execute a workflow
			const flowHandle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = flowHandle.id;

			// Verify timeout handle was created
			expect(timeoutHandles.has(flowId)).toBe(true);

			// Simulate workflow failure via QueueEvents
			mockQueueEvents.emit('failed', {
				jobId: flowId,
				failedReason: 'Test failure'
			});

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify timeout handle was cleaned up
			expect(timeoutHandles.has(flowId)).toBe(false);
		});

		it('should clean up multiple timeout handles when multiple workflows complete', async () => {
			/**
			 * Test that multiple workflows don't leave stale timeout handles.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: 30000,
				flowStateCleanupDelay: 0,
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

			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');

			// Execute 5 workflows
			const flowIds: string[] = [];
			for (let i = 0; i < 5; i++) {
				const handle = await provider.execute(SimpleWorkflowDef, { value: i });
				flowIds.push(handle.id);
			}

			// Verify all timeout handles were created
			expect(timeoutHandles.size).toBe(5);
			for (const flowId of flowIds) {
				expect(timeoutHandles.has(flowId)).toBe(true);
			}

			// Simulate completion of all workflows
			for (let i = 0; i < flowIds.length; i++) {
				mockQueueEvents.emit('completed', {
					jobId: flowIds[i],
					returnvalue: JSON.stringify({ result: i * 2 })
				});
			}

			// Allow promise callbacks to resolve
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify ALL timeout handles were cleaned up
			expect(timeoutHandles.size).toBe(0);
		});

		it('should clean up timeout handle when timeout fires (and delete from map in callback)', async () => {
			/**
			 * When timeout fires, the timeout callback should also delete the handle
			 * from the map (not just rely on .finally()).
			 *
			 * This is important because if the promise somehow doesn't settle
			 * (edge case), we still want cleanup.
			 *
			 * NOTE: Effective timeout = TIMEOUT_MS + stallInterval because the provider
			 * adds stallInterval to allow for worker recovery if one dies.
			 */
			const TIMEOUT_MS = 50; // Short timeout for testing
			const STALL_INTERVAL_MS = 5000; // Minimum allowed stallInterval
			const EFFECTIVE_TIMEOUT_MS = TIMEOUT_MS + STALL_INTERVAL_MS;

			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: TIMEOUT_MS,
				stallInterval: STALL_INTERVAL_MS,
				flowStateCleanupDelay: 0,
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

			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');

			// Execute a workflow (it will timeout because we don't emit completion)
			const flowHandle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = flowHandle.id;

			// Verify timeout handle was created
			expect(timeoutHandles.has(flowId)).toBe(true);

			// Wait for timeout to fire (effective timeout = TIMEOUT_MS + stallInterval)
			await new Promise((resolve) => setTimeout(resolve, EFFECTIVE_TIMEOUT_MS + 50));

			// Verify timeout handle was cleaned up (via .finally() after timeout rejects the promise)
			expect(timeoutHandles.has(flowId)).toBe(false);

			// Verify status is 'failed'
			expect(await provider.getStatus(flowId)).toBe('failed');
		}, 10000); // Extended timeout for this test (5s+ for stallInterval)

		it('should clean up timeout handle synchronously in callback even if promise already settled', async () => {
			/**
			 * The timeout callback should delete the handle synchronously,
			 * NOT rely solely on .finally() which only runs when the promise settles.
			 *
			 * Scenario:
			 * 1. Workflow starts with timeout
			 * 2. QueueEvents completes workflow BEFORE timeout fires
			 * 3. Timeout fires, but state is already 'completed'
			 * 4. Timeout callback skips rejection (state != pending/running)
			 * 5. Promise already settled, .finally() already ran
			 * 6. Without synchronous cleanup: timeout handle never deleted (leak)
			 * 7. With synchronous cleanup: timeout callback deletes handle immediately
			 *
			 * This test verifies the synchronous cleanup happens.
			 *
			 * NOTE: Effective timeout = TIMEOUT_MS + stallInterval because the provider
			 * adds stallInterval to allow for worker recovery if one dies.
			 */
			const TIMEOUT_MS = 100; // Short timeout for testing
			const STALL_INTERVAL_MS = 5000; // Minimum allowed stallInterval
			const EFFECTIVE_TIMEOUT_MS = TIMEOUT_MS + STALL_INTERVAL_MS;

			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: TIMEOUT_MS,
				stallInterval: STALL_INTERVAL_MS,
				flowStateCleanupDelay: 0,
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

			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');
			const localFlowStates = getPrivateMap<string, { status: string }>(provider, 'localFlowStates');

			// Execute a workflow
			const flowHandle = await provider.execute(SimpleWorkflowDef, { value: 42 });
			const flowId = flowHandle.id;

			// Verify timeout handle was created
			expect(timeoutHandles.has(flowId)).toBe(true);

			// Simulate workflow completion BEFORE timeout fires
			// This causes .finally() to run and clean up the handle
			mockQueueEvents.emit('completed', {
				jobId: flowId,
				returnvalue: JSON.stringify({ result: 84 })
			});

			// Allow promise callbacks to resolve (this runs .finally())
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Handle should be cleaned up by .finally()
			expect(timeoutHandles.has(flowId)).toBe(false);

			// Now test the edge case: what if we execute ANOTHER workflow
			// and manually manipulate state to simulate the race condition?

			// Execute second workflow
			const flowHandle2 = await provider.execute(SimpleWorkflowDef, { value: 99 });
			const flowId2 = flowHandle2.id;

			// Verify timeout handle was created for second workflow
			expect(timeoutHandles.has(flowId2)).toBe(true);

			// Manually set state to 'completed' to simulate QueueEvents completing
			// just before timeout fires, but AFTER .finally() already ran
			// (This simulates the race condition edge case)
			const state = localFlowStates.get(flowId2);
			if (state) {
				state.status = 'completed';
			}

			// Wait for timeout to fire (effective timeout = TIMEOUT_MS + stallInterval)
			// The timeout callback checks state, sees 'completed', and skips rejection.
			// Without synchronous cleanup, handle stays in map (leak).
			// With synchronous cleanup, handle is deleted immediately in callback.
			await new Promise((resolve) => setTimeout(resolve, EFFECTIVE_TIMEOUT_MS + 50));

			// Verify timeout handle was still cleaned up (by synchronous deletion in callback)
			expect(timeoutHandles.has(flowId2)).toBe(false);
		}, 10000); // Extended timeout for this test (5s+ for stallInterval)

		it('should NOT leave stale entries when workflow completes with timeout disabled', async () => {
			/**
			 * When timeout is disabled (timeout: 0), no timeout handle should be created.
			 */
			const options: BullMQWorkflowProviderOptions = {
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'test-timeout-leak',
				defaultTimeout: 0, // Disable timeout
				flowStateCleanupDelay: 0,
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

			const timeoutHandles = getPrivateMap<string, ReturnType<typeof setTimeout>>(provider, 'timeoutHandles');

			// Execute a workflow with timeout disabled
			await provider.execute(SimpleWorkflowDef, { value: 42 });

			// No timeout handle should be created
			expect(timeoutHandles.size).toBe(0);
		});
	});
});
