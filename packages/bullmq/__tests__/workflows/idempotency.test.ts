/**
 * Idempotency Tests for BullMQ Workflow Provider
 *
 * Tests to verify behavior when the same workflow is submitted multiple times.
 * Demonstrates both the problem (without idempotency key) and the solution (with idempotency key).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';

// Ensure Redis is ready
if (!isRedisReady()) {
	throw new Error('Redis container not ready for idempotency tests');
}

// Track execution counts globally
let executionCount = 0;
const executionLog: Array<{ flowId: string; data: unknown; timestamp: number }> = [];

// Define workflow with definition-based API
const SlowWorkflowDef = Workflow.define({
	name: 'slow-workflow',
	data: Type.Object({ orderId: Type.String() }),
	result: Type.Object({ processed: Type.Boolean() })
});

// Step groups (structure only)
const stepGroups = [{ type: 'sequential' as const, definitions: [{ name: 'process' }] }];

// Step handlers (implementation)
const createStepHandlers = () => ({
	process: {
		execute: async (ctx: WorkflowContext<{ orderId: string }>) => {
			executionCount++;
			executionLog.push({
				flowId: ctx.flowId,
				data: ctx.data,
				timestamp: Date.now()
			});

			// Simulate slow processing
			await new Promise((resolve) => setTimeout(resolve, 50));

			return { orderId: ctx.data.orderId, processedAt: Date.now() };
		}
	}
});

describe('BullMQ Workflow Idempotency', () => {
	let provider: BullMQWorkflowProvider;

	beforeAll(async () => {
		const connection = getRedisConnectionOptions();
		provider = new BullMQWorkflowProvider({
			connection,
			queuePrefix: 'idempotency-test',
			defaultTimeout: 10000
		});

		provider.registerDefinitionConsumer(
			'slow-workflow',
			async (_data, _meta, _stepResults) => {
				return { processed: true };
			},
			stepGroups,
			createStepHandlers()
		);
		await provider.start();
	}, 30000);

	afterAll(async () => {
		await provider.stop();
		// Allow ioredis async cleanup to complete before next test file starts
		await new Promise((r) => setTimeout(r, 50));
	});

	beforeEach(() => {
		// Reset counters before each test
		executionCount = 0;
		executionLog.length = 0;
	});

	describe('without idempotency key (demonstrates the problem)', () => {
		it('should create duplicate executions when same data submitted twice', async () => {
			const orderData = { orderId: 'ORDER-NO-KEY-1' };

			// Submit the SAME workflow twice in quick succession WITHOUT idempotency key
			const [handle1, handle2] = await Promise.all([
				provider.execute(SlowWorkflowDef, orderData),
				provider.execute(SlowWorkflowDef, orderData)
			]);

			// They should have DIFFERENT flow IDs (this is the problem!)
			console.log('Without key - Flow ID 1:', handle1.id);
			console.log('Without key - Flow ID 2:', handle2.id);
			expect(handle1.id).not.toBe(handle2.id);

			// Wait for both to complete
			const [result1, result2] = await Promise.all([handle1.result(), handle2.result()]);

			// Both workflows completed
			expect(result1.processed).toBe(true);
			expect(result2.processed).toBe(true);

			// The PROBLEM: step executed TWICE for the same order!
			console.log('Without key - Execution count:', executionCount);
			expect(executionCount).toBe(2); // This demonstrates the issue
		}, 15000);
	});

	describe('with idempotency key (the solution)', () => {
		it('should deduplicate when same idempotency key sent twice (simulates double-click)', async () => {
			const orderData = { orderId: 'ORDER-1' };

			// UI generates a unique key when user clicks the button
			const idempotencyKey = crypto.randomUUID();

			// User double-clicks, same key sent twice
			const handle1 = await provider.execute(SlowWorkflowDef, orderData, { idempotencyKey });
			console.log('With key - Flow ID 1:', handle1.id);

			// Second request arrives with same key while first is still processing
			const handle2 = await provider.execute(SlowWorkflowDef, orderData, { idempotencyKey });
			console.log('With key - Flow ID 2:', handle2.id);

			// Race the two handles - one of them should complete
			const result = await Promise.race([
				handle1.result().catch(() => null),
				handle2.result().catch(() => null)
			]);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.processed).toBe(true);
			}

			// Wait a bit to ensure both would have completed if they were running
			await new Promise((resolve) => setTimeout(resolve, 25));

			console.log('With key - Execution count:', executionCount);

			// With idempotency, step should only execute ONCE despite double-click
			expect(executionCount).toBe(1);
		}, 15000);

		it('should allow separate intentional submissions with different keys', async () => {
			const orderData = { orderId: 'ORDER-2' };

			// First intentional click - UI generates key
			const key1 = crypto.randomUUID();
			const handle1 = await provider.execute(SlowWorkflowDef, orderData, { idempotencyKey: key1 });

			// Second intentional click (later) - UI generates NEW key
			const key2 = crypto.randomUUID();
			const handle2 = await provider.execute(SlowWorkflowDef, orderData, { idempotencyKey: key2 });

			// Wait for both
			await Promise.all([handle1.result(), handle2.result()]);

			// Both should execute because different keys (separate user actions)
			expect(executionCount).toBe(2);
		}, 15000);
	});
});
