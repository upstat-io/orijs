/**
 * Flow Registry Tests
 *
 * Tests the Redis-based flowId -> workflowName registry that enables O(1) lookups
 * for recovery APIs (getHandle, getResult, getStatus).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';
import Redis from 'ioredis';

// Generate unique prefix per test run
const testFileId = Math.random().toString(36).substring(2, 8);
let testCounter = 0;

const getUniquePrefix = () => `flow-reg-${testFileId}-${++testCounter}`;

// Simple workflow for testing
const TestWorkflow = Workflow.define({
	name: 'test-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

const stepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'compute' }]
	}
];

const stepHandlers = {
	compute: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			return { computed: ctx.data.value * 2 };
		}
	}
};

describe('Flow Registry', () => {
	let provider: BullMQWorkflowProvider;
	let redis: Redis;
	let queuePrefix: string;

	beforeAll(() => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		queuePrefix = getUniquePrefix();
		const connectionOptions = getRedisConnectionOptions();

		provider = new BullMQWorkflowProvider({
			connection: connectionOptions,
			queuePrefix
		});

		provider.registerDefinitionConsumer(
			TestWorkflow.name,
			async (_data, _meta, stepResults) => {
				const stepResult = stepResults?.['compute'] as { computed: number } | undefined;
				return { result: stepResult?.computed ?? 0 };
			},
			stepGroups,
			stepHandlers
		);

		await provider.start();

		// Create separate Redis client for verification
		redis = new Redis(connectionOptions);
	});

	afterEach(async () => {
		await provider.stop();
		await redis.quit();
	});

	it('should register flowId in registry when executing workflow', async () => {
		// Execute workflow
		const handle = await provider.execute(TestWorkflow, { value: 21 });
		const flowId = handle.id;

		// Verify registry entry exists
		const hash = Bun.hash(flowId).toString(36);
		const registryKey = `${queuePrefix}:fr:${hash}`;
		const workflowName = await redis.get(registryKey);

		expect(workflowName).toBe('test-workflow');

		// Verify TTL is set (should be ~900 seconds)
		const ttl = await redis.ttl(registryKey);
		expect(ttl).toBeGreaterThan(890);
		expect(ttl).toBeLessThanOrEqual(900);

		// Wait for completion
		await handle.result();
	});

	it('should use registry for O(1) lookup in getStatus', async () => {
		// Execute workflow and wait for completion
		const handle = await provider.execute(TestWorkflow, { value: 10 });
		const flowId = handle.id;
		await handle.result();

		// getStatus should work via registry lookup
		const status = await provider.getStatus(flowId);
		expect(status).toBe('completed');
	});

	it('should use registry for O(1) lookup in getHandle', async () => {
		// Execute workflow and wait for completion
		const handle = await provider.execute(TestWorkflow, { value: 15 });
		const flowId = handle.id;
		await handle.result();

		// getHandle should work via registry lookup
		const recoveredHandle = await provider.getHandle(flowId);
		const status = await recoveredHandle.status();
		expect(status).toBe('completed');
	});

	it('should fallback to sequential search when registry entry missing', async () => {
		// Execute workflow and wait for completion
		const handle = await provider.execute(TestWorkflow, { value: 5 });
		const flowId = handle.id;
		await handle.result();

		// Delete registry entry to simulate expiration
		const hash = Bun.hash(flowId).toString(36);
		const registryKey = `${queuePrefix}:fr:${hash}`;
		await redis.del(registryKey);

		// getStatus should still work via fallback sequential search
		const status = await provider.getStatus(flowId);
		expect(status).toBe('completed');
	});

	it('should handle multiple workflows with different registry entries', async () => {
		// Define second workflow
		const SecondWorkflow = Workflow.define({
			name: 'second-workflow',
			data: Type.Object({ value: Type.Number() }),
			result: Type.Object({ result: Type.Number() })
		});

		// Register second workflow
		provider.registerDefinitionConsumer(
			SecondWorkflow.name,
			async (_data, _meta, stepResults) => {
				const stepResult = stepResults?.['compute'] as { computed: number } | undefined;
				return { result: stepResult?.computed ?? 0 };
			},
			stepGroups,
			stepHandlers
		);

		// Execute both workflows
		const handle1 = await provider.execute(TestWorkflow, { value: 1 });
		const handle2 = await provider.execute(SecondWorkflow, { value: 2 });

		// Verify different registry entries
		const hash1 = Bun.hash(handle1.id).toString(36);
		const hash2 = Bun.hash(handle2.id).toString(36);

		const workflowName1 = await redis.get(`${queuePrefix}:fr:${hash1}`);
		const workflowName2 = await redis.get(`${queuePrefix}:fr:${hash2}`);

		expect(workflowName1).toBe('test-workflow');
		expect(workflowName2).toBe('second-workflow');

		// Wait for completion
		await handle1.result();
		await handle2.result();
	});
});
