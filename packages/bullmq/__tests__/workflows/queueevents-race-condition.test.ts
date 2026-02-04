/**
 * Tests for QueueEvents Race Condition
 *
 * Verifies that QueueEvents 'completed' callback can find the pending result
 * even when the job completes extremely fast (before pendingResults.set runs).
 *
 * The race condition occurs when:
 * 1. flowProducer.add() is called - job created
 * 2. Job completes immediately (fast worker)
 * 3. QueueEvents fires 'completed' event
 * 4. Event handler looks for pendingResults.get(jobId) - NOT FOUND (race!)
 * 5. pendingResults.set(jobId, ...) runs - too late
 *
 * Solution: Register pending result with pre-generated jobId BEFORE adding job.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { BullMQWorkflowProvider, type BullMQWorkflowProviderOptions } from '../../src/workflows/index.ts';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';

// Define workflow using definition-based API
const FastWorkflowDef = Workflow.define({
	name: 'fast-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Number()
});

// Step groups for FastWorkflow
const fastStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'fast-step' }]
	}
];

// Step handlers for FastWorkflow
const createFastStepHandlers = () => ({
	'fast-step': {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { result: ctx.data.value * 2 };
		}
	}
});

describe('QueueEvents Race Condition', () => {
	let provider: BullMQWorkflowProvider;
	let mockFlowProducer: {
		add: Mock<(flowJob: { opts?: { jobId?: string } }) => Promise<{ job: { id: string } }>>;
		close: Mock<() => Promise<void>>;
	};
	let mockQueueEvents: {
		on: Mock<(event: string, handler: (...args: unknown[]) => void) => void>;
		close: Mock<() => Promise<void>>;
		waitUntilReady: Mock<() => Promise<void>>;
	};
	let queueEventsHandlers: Map<string, (...args: unknown[]) => void>;
	let addJobDelay: number;
	let capturedJobId: string | undefined;

	beforeEach(() => {
		queueEventsHandlers = new Map();
		addJobDelay = 0;
		capturedJobId = undefined;

		mockFlowProducer = {
			add: mock(async (flowJob: { opts?: { jobId?: string } }) => {
				// Use opts.jobId if provided for predictable job identification
				const jobId = flowJob.opts?.jobId ?? `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				capturedJobId = jobId;

				// If delay is set, wait before returning (simulates slow add)
				if (addJobDelay > 0) {
					await new Promise((resolve) => setTimeout(resolve, addJobDelay));
				}

				return { job: { id: jobId } };
			}),
			close: mock(() => Promise.resolve())
		};

		mockQueueEvents = {
			on: mock((event: string, handler: (...args: unknown[]) => void) => {
				queueEventsHandlers.set(event, handler);
			}),
			close: mock(() => Promise.resolve()),
			waitUntilReady: mock(() => Promise.resolve())
		};

		const mockWorker = {
			on: mock(() => {}),
			close: mock(() => Promise.resolve()),
			connection: { _client: { on: mock(() => {}) } },
			blockingConnection: { _client: { on: mock(() => {}) } }
		};

		const options: BullMQWorkflowProviderOptions = {
			connection: { host: 'localhost', port: 6379 },
			FlowProducerClass: class {
				add = mockFlowProducer.add;
				close = mockFlowProducer.close;
			} as unknown as BullMQWorkflowProviderOptions['FlowProducerClass'],
			WorkerClass: class {
				on = mockWorker.on;
				close = mockWorker.close;
				connection = mockWorker.connection;
				blockingConnection = mockWorker.blockingConnection;
			} as unknown as BullMQWorkflowProviderOptions['WorkerClass'],
			QueueEventsClass: class {
				on = mockQueueEvents.on;
				close = mockQueueEvents.close;
				waitUntilReady = mockQueueEvents.waitUntilReady;
			} as unknown as BullMQWorkflowProviderOptions['QueueEventsClass']
		};

		provider = new BullMQWorkflowProvider(options);
		provider.registerDefinitionConsumer(
			'fast-workflow',
			async (_data, _meta, stepResults) => {
				const stepResult = stepResults?.['fast-step'] as { result: number } | undefined;
				return stepResult?.result ?? 0;
			},
			fastStepGroups,
			createFastStepHandlers()
		);
	});

	it('should handle result even when completed event fires during add', async () => {
		await provider.start();

		// Set up: Job completes DURING flowProducer.add() before it returns
		addJobDelay = 50; // Delay add() return by 50ms

		// Start the execute call (don't await yet)
		const executePromise = provider.execute(FastWorkflowDef, { value: 21 });

		// Wait a tick for add() to be called
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Simulate: Job completes while add() is still waiting to return.
		// Without pre-registration, pendingResults.set() hasn't run yet - result is lost.
		// With pre-registration, pendingResults was set BEFORE add() - result is captured.
		const completedHandler = queueEventsHandlers.get('completed');
		expect(completedHandler).toBeDefined();

		// The jobId is predictable (flowId-based) and pendingResults is
		// registered BEFORE add() is called. The jobId is the flowId
		// (or idempotencyKey if provided). We use capturedJobId which
		// the mock returns - in the real implementation, this is pre-registered.
		completedHandler!({ jobId: capturedJobId, returnvalue: JSON.stringify(42) });

		// Now let add() return
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Get the handle
		const handle = await executePromise;

		// Result should be available because pendingResults was registered
		// BEFORE flowProducer.add() was called
		const resultPromise = handle.result();
		const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 200));

		const result = await Promise.race([resultPromise, timeoutPromise]);

		// Result should be 42, not 'timeout' (race condition prevented)
		expect(result).toBe(42);
	});

	it('should handle immediate completion after add returns', async () => {
		await provider.start();

		// Execute workflow (no delay, add returns immediately)
		const handle = await provider.execute(FastWorkflowDef, { value: 21 });

		// Simulate completion after execute returns
		const completedHandler = queueEventsHandlers.get('completed');
		expect(completedHandler).toBeDefined();

		completedHandler!({ jobId: capturedJobId, returnvalue: JSON.stringify(42) });

		// Result should be available
		const result = await handle.result();
		expect(result).toBe(42);
	});
});
