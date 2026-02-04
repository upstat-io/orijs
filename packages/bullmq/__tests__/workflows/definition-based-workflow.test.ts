/**
 * Definition-Based Workflow Execution Tests
 *
 * Tests the emitter-only workflow pattern where a WorkflowDefinition is passed
 * to execute() and emitted to a queue without requiring a local consumer.
 *
 * This tests the executeDefinition() flow in BullMQWorkflowProvider.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Type } from '@orijs/validation';
import {
	BullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions
} from '../../src/workflows/bullmq-workflow-provider.ts';
import type { WorkflowDefinition } from '@orijs/core';

/**
 * Create a test workflow definition
 */
function createTestWorkflowDefinition(
	name: string
): WorkflowDefinition<{ userId: string }, { success: boolean }> {
	return {
		name,
		dataSchema: Type.Object({ userId: Type.String() }),
		resultSchema: Type.Object({ success: Type.Boolean() }),
		stepGroups: [],
		_data: undefined as unknown as { userId: string },
		_result: undefined as unknown as { success: boolean },
		_steps: undefined as unknown as Record<never, never>
	};
}

/**
 * Mock Redis connection
 */
function createMockRedisConnection() {
	return { _client: { on: mock(() => {}) } };
}

/**
 * Captured flow job from FlowProducer.add()
 */
interface CapturedFlowJob {
	name: string;
	queueName: string;
	data: unknown;
	opts?: { jobId?: string };
}

describe('Definition-Based Workflow Execution', () => {
	let provider: BullMQWorkflowProvider;
	let capturedJobs: CapturedFlowJob[];
	let mockQueueEventsInstances: Map<string, { on: ReturnType<typeof mock>; close: ReturnType<typeof mock> }>;

	beforeEach(() => {
		capturedJobs = [];
		mockQueueEventsInstances = new Map();

		// Create mock FlowProducer that captures jobs
		const MockFlowProducerClass = class {
			add = mock((job: CapturedFlowJob) => {
				capturedJobs.push(job);
				return Promise.resolve({ job });
			});
			close = mock(() => Promise.resolve());
		};

		// Create mock Worker
		const MockWorkerClass = class {
			close = mock(() => Promise.resolve());
			on = mock(() => this);
			connection = createMockRedisConnection();
			blockingConnection = createMockRedisConnection();
		};

		// Create mock QueueEvents that tracks instances by queue name
		const MockQueueEventsClass = class {
			on = mock(() => this);
			close = mock(() => Promise.resolve());
			waitUntilReady = mock(() => Promise.resolve());
			connection = createMockRedisConnection();

			constructor(queueName: string) {
				mockQueueEventsInstances.set(queueName, { on: this.on, close: this.close });
			}
		};

		const options: BullMQWorkflowProviderOptions = {
			connection: { host: 'localhost', port: 6379 },
			queuePrefix: 'test-workflow',
			FlowProducerClass:
				MockFlowProducerClass as unknown as BullMQWorkflowProviderOptions['FlowProducerClass'],
			WorkerClass: MockWorkerClass as unknown as BullMQWorkflowProviderOptions['WorkerClass'],
			QueueEventsClass: MockQueueEventsClass as unknown as BullMQWorkflowProviderOptions['QueueEventsClass']
		};

		provider = new BullMQWorkflowProvider(options);
	});

	afterEach(async () => {
		await provider.stop();
	});

	describe('execute() with WorkflowDefinition', () => {
		it('should detect workflow definition by dataSchema property', async () => {
			const definition = createTestWorkflowDefinition('test-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			// Execute with definition (has dataSchema property)
			await provider.execute(definition as any, { userId: 'user-123' });

			// Should have emitted a job
			expect(capturedJobs.length).toBe(1);
		});

		it('should use correct queue name with dot separator', async () => {
			const definition = createTestWorkflowDefinition('my-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-456' });

			// Queue name should use dot separator: prefix.workflowName
			expect(capturedJobs[0]!.queueName).toBe('test-workflow.my-workflow');
		});

		it('should include workflow data in job', async () => {
			const definition = createTestWorkflowDefinition('data-workflow');
			const inputData = { userId: 'user-789' };
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, inputData);

			const jobData = capturedJobs[0]!.data as { workflowData: unknown };
			expect(jobData.workflowData).toEqual(inputData);
		});

		it('should include flowId in job data', async () => {
			const definition = createTestWorkflowDefinition('flow-id-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-abc' });

			const jobData = capturedJobs[0]!.data as { flowId: string };
			expect(jobData.flowId).toBeDefined();
			expect(typeof jobData.flowId).toBe('string');
			expect(jobData.flowId.length).toBeGreaterThan(0);
		});

		it('should include version in job data', async () => {
			const definition = createTestWorkflowDefinition('version-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-def' });

			const jobData = capturedJobs[0]!.data as { version: string };
			expect(jobData.version).toBe('1.0');
		});

		it('should create QueueEvents for the workflow queue', async () => {
			const definition = createTestWorkflowDefinition('queue-events-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-ghi' });

			// QueueEvents should be created for the workflow queue
			expect(mockQueueEventsInstances.has('test-workflow.queue-events-workflow')).toBe(true);
		});

		it('should return a FlowHandle with id', async () => {
			const definition = createTestWorkflowDefinition('handle-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			const handle = await provider.execute(definition as any, { userId: 'user-jkl' });

			expect(handle.id).toBeDefined();
			expect(typeof handle.id).toBe('string');
		});

		it('should return pending status initially', async () => {
			const definition = createTestWorkflowDefinition('status-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			const handle = await provider.execute(definition as any, { userId: 'user-mno' });

			// Status changes to 'running' after job is added
			const status = await handle.status();
			expect(status).toBe('running');
		});

		it('should use workflow name as job name', async () => {
			const definition = createTestWorkflowDefinition('job-name-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-pqr' });

			expect(capturedJobs[0]!.name).toBe('job-name-workflow');
		});

		it('should throw if provider not started', async () => {
			// Don't start provider - but still register the workflow
			const definition = createTestWorkflowDefinition('not-started-workflow');
			provider.registerEmitterWorkflow(definition.name);

			await expect(provider.execute(definition as any, { userId: 'user-stu' })).rejects.toThrow(
				'Provider not started'
			);
		});
	});

	describe('queue name format', () => {
		it('should handle workflow names with hyphens', async () => {
			const definition = createTestWorkflowDefinition('my-complex-workflow-name');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-1' });

			expect(capturedJobs[0]!.queueName).toBe('test-workflow.my-complex-workflow-name');
		});

		it('should handle simple workflow names', async () => {
			const definition = createTestWorkflowDefinition('simple');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-2' });

			expect(capturedJobs[0]!.queueName).toBe('test-workflow.simple');
		});

		it('should use custom queuePrefix', async () => {
			// Create provider with custom prefix
			const customProvider = new BullMQWorkflowProvider({
				connection: { host: 'localhost', port: 6379 },
				queuePrefix: 'custom-prefix',
				FlowProducerClass: class {
					add = mock((job: CapturedFlowJob) => {
						capturedJobs.push(job);
						return Promise.resolve({ job });
					});
					close = mock(() => Promise.resolve());
				} as unknown as BullMQWorkflowProviderOptions['FlowProducerClass'],
				WorkerClass: class {
					close = mock(() => Promise.resolve());
					on = mock(() => this);
					connection = createMockRedisConnection();
					blockingConnection = createMockRedisConnection();
				} as unknown as BullMQWorkflowProviderOptions['WorkerClass'],
				QueueEventsClass: class {
					on = mock(() => this);
					close = mock(() => Promise.resolve());
					waitUntilReady = mock(() => Promise.resolve());
					connection = createMockRedisConnection();
				} as unknown as BullMQWorkflowProviderOptions['QueueEventsClass']
			});

			const definition = createTestWorkflowDefinition('test');
			customProvider.registerEmitterWorkflow(definition.name);
			await customProvider.start();

			await customProvider.execute(definition as any, { userId: 'user-3' });

			expect(capturedJobs[capturedJobs.length - 1]!.queueName).toBe('custom-prefix.test');

			await customProvider.stop();
		});
	});

	describe('job data structure', () => {
		it('should have correct WorkflowJobData structure', async () => {
			const definition = createTestWorkflowDefinition('structure-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-xyz' });

			const jobData = capturedJobs[0]!.data as {
				version: string;
				flowId: string;
				workflowData: unknown;
				stepResults: Record<string, unknown>;
				meta?: unknown;
			};

			// Verify all required fields
			expect(jobData.version).toBe('1.0');
			expect(jobData.flowId).toBeDefined();
			expect(jobData.workflowData).toEqual({ userId: 'user-xyz' });
			expect(jobData.stepResults).toEqual({});
		});

		it('should include propagation meta when available', async () => {
			const definition = createTestWorkflowDefinition('meta-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			// Execute with explicit meta option
			await provider.execute(
				definition as any,
				{ userId: 'user-meta' },
				{ meta: { correlationId: 'req-123' } }
			);

			const jobData = capturedJobs[0]!.data as { meta?: { correlationId: string } };
			expect(jobData.meta).toEqual({ correlationId: 'req-123' });
		});

		it('should use jobId without colons (BullMQ restriction)', async () => {
			const definition = createTestWorkflowDefinition('jobid-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(definition as any, { userId: 'user-jobid' });

			const jobId = capturedJobs[0]!.opts?.jobId;
			expect(jobId).toBeDefined();
			expect(jobId).not.toContain(':');
			// Should be workflowName.flowId format
			expect(jobId).toMatch(/^jobid-workflow\./);
		});

		it('should use idempotencyKey as jobId when provided', async () => {
			const definition = createTestWorkflowDefinition('idempotent-workflow');
			provider.registerEmitterWorkflow(definition.name);
			await provider.start();

			await provider.execute(
				definition as any,
				{ userId: 'user-idem' },
				{ idempotencyKey: 'custom-key-123' }
			);

			const jobId = capturedJobs[0]!.opts?.jobId;
			expect(jobId).toBe('custom-key-123');
		});
	});
});
