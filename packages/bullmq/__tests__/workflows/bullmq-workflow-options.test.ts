/**
 * Tests for BullMQWorkflowProvider Options Support
 *
 * Verifies the provider options architecture:
 * - Per-workflow concurrency configuration
 * - Workers created with correct concurrency
 * - Options passed through registerDefinitionConsumer
 */

import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import {
	BullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions,
	type BullMQWorkflowOptions
} from '../../src/workflows/index.ts';

// Mock factories
type MockFlowProducer = {
	add: Mock<() => Promise<{ job: { id: string } }>>;
	close: Mock<() => Promise<void>>;
};

type MockWorker = {
	on: Mock<(event: string, handler: () => void) => void>;
	close: Mock<() => Promise<void>>;
	concurrency?: number;
};

type MockQueueEvents = {
	on: Mock<(event: string, handler: () => void) => void>;
	close: Mock<() => Promise<void>>;
};

// Capture worker options from constructor
let capturedWorkerOptions: { concurrency?: number }[] = [];

// Simple step groups for all workflows
const simpleStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'process' }]
	}
];

// Simple step handlers
const createSimpleStepHandlers = () => ({
	process: {
		execute: async () => ({})
	}
});

describe('BullMQWorkflowProvider Options', () => {
	let mockFlowProducer: MockFlowProducer;
	let mockWorker: MockWorker;
	let mockQueueEvents: MockQueueEvents;
	let provider: BullMQWorkflowProvider;

	beforeEach(() => {
		capturedWorkerOptions = [];

		mockFlowProducer = {
			add: mock(() => Promise.resolve({ job: { id: 'flow-123' } })),
			close: mock(() => Promise.resolve())
		};

		mockWorker = {
			on: mock(() => {}),
			close: mock(() => Promise.resolve())
		};

		mockQueueEvents = {
			on: mock(() => {}),
			close: mock(() => Promise.resolve())
		};

		// Create provider with mock factories
		const options: BullMQWorkflowProviderOptions = {
			connection: { host: 'localhost', port: 6379 },
			FlowProducerClass: class {
				add = mockFlowProducer.add;
				close = mockFlowProducer.close;
			} as unknown as BullMQWorkflowProviderOptions['FlowProducerClass'],
			WorkerClass: class {
				on = mockWorker.on;
				close = mockWorker.close;
				concurrency: number;
				constructor(_queueName: string, _processor: unknown, opts?: { concurrency?: number }) {
					this.concurrency = opts?.concurrency ?? 1;
					capturedWorkerOptions.push({ concurrency: this.concurrency });
				}
			} as unknown as BullMQWorkflowProviderOptions['WorkerClass'],
			QueueEventsClass: class {
				on = mockQueueEvents.on;
				close = mockQueueEvents.close;
			} as unknown as BullMQWorkflowProviderOptions['QueueEventsClass']
		};

		provider = new BullMQWorkflowProvider(options);
	});

	describe('registerDefinitionConsumer with options', () => {
		it('should accept BullMQWorkflowOptions when registering', () => {
			const options: BullMQWorkflowOptions = { concurrency: 10 };

			// Should not throw
			provider.registerDefinitionConsumer(
				'high-volume-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers(),
				undefined,
				options
			);

			expect(true).toBe(true); // Registration succeeded
		});

		it('should allow registration without options', () => {
			// Should not throw
			provider.registerDefinitionConsumer(
				'default-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers()
			);

			expect(true).toBe(true); // Registration succeeded
		});
	});

	describe('worker concurrency configuration', () => {
		it('should create workers with specified concurrency', async () => {
			provider.registerDefinitionConsumer(
				'high-volume-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers(),
				undefined,
				{ concurrency: 10 }
			);
			await provider.start();

			// Workers are created for each queue: workflow queue + step queue
			expect(capturedWorkerOptions.length).toBeGreaterThanOrEqual(1);

			// At least one worker should have concurrency 10
			const workflowWorker = capturedWorkerOptions[0]!;
			expect(workflowWorker.concurrency).toBe(10);
		});

		it('should default to concurrency 1 when no options provided', async () => {
			provider.registerDefinitionConsumer(
				'default-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers()
			);
			await provider.start();

			expect(capturedWorkerOptions.length).toBeGreaterThanOrEqual(1);

			// Default concurrency should be 1
			const workflowWorker = capturedWorkerOptions[0]!;
			expect(workflowWorker.concurrency).toBe(1);
		});

		it('should configure different concurrency per workflow', async () => {
			provider.registerDefinitionConsumer(
				'high-volume-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers(),
				undefined,
				{ concurrency: 10 }
			);
			provider.registerDefinitionConsumer(
				'low-priority-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers(),
				undefined,
				{ concurrency: 2 }
			);
			await provider.start();

			// Should have workers for both workflows
			expect(capturedWorkerOptions.length).toBeGreaterThanOrEqual(2);

			// Find concurrency values (order may vary)
			const concurrencyValues = capturedWorkerOptions.map((o) => o.concurrency);
			expect(concurrencyValues).toContain(10);
			expect(concurrencyValues).toContain(2);
		});
	});

	describe('options interface completeness', () => {
		it('should accept BullMQ native options', () => {
			// Full BullMQ passthrough - no abstraction
			const fullOptions: BullMQWorkflowOptions = {
				// Worker options
				concurrency: 5,
				// Job options (BullMQ native)
				attempts: 3,
				backoff: { type: 'exponential', delay: 1000 },
				failParentOnFailure: true
			};

			// Should not throw
			provider.registerDefinitionConsumer(
				'high-volume-workflow',
				async () => {},
				simpleStepGroups,
				createSimpleStepHandlers(),
				undefined,
				fullOptions
			);

			expect(true).toBe(true);
		});
	});
});

describe('BullMQWorkflowOptions type', () => {
	it('should accept BullMQ native job and worker options', () => {
		const options: BullMQWorkflowOptions = {
			// Worker options
			concurrency: 10,
			// Job options (BullMQ native)
			attempts: 3,
			backoff: { type: 'exponential', delay: 1000 },
			failParentOnFailure: true
		};

		expect(options.concurrency).toBe(10);
		expect(options.attempts).toBe(3);
		expect(options.backoff).toEqual({ type: 'exponential', delay: 1000 });
		expect(options.failParentOnFailure).toBe(true);
	});

	it('should allow partial options', () => {
		const options: BullMQWorkflowOptions = {
			concurrency: 5
		};

		expect(options.concurrency).toBe(5);
		expect(options.attempts).toBeUndefined();
	});

	it('should allow empty options', () => {
		const options: BullMQWorkflowOptions = {};

		expect(options.concurrency).toBeUndefined();
	});
});
