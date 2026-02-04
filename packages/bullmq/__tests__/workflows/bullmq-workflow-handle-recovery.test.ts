/**
 * BullMQ Workflow Handle Recovery Tests
 *
 * Tests that workflow status and results can be retrieved from ANY instance,
 * not just the instance that started the workflow. This is critical for:
 * - Server restarts (same server comes back, needs to check pending workflows)
 * - Load balancing (different server handles status check request)
 * - High availability (original server dies, another takes over)
 *
 * CURRENT BEHAVIOR (broken):
 * - localFlowStates is in-memory, lost when instance dies
 * - handle.status() returns 'pending' on new instance (wrong)
 * - handle.result() promise is lost, cannot be reconstructed
 *
 * EXPECTED BEHAVIOR (after fix):
 * - Any instance can query Redis for workflow status
 * - Any instance can retrieve completed workflow results
 * - Handles can be reconstructed from flowId alone
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import {
	MultiInstanceTestHarness,
	createSharedExecutionLog,
	delay,
	type SharedExecutionLog
} from './multi-instance-test-utils';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';

const TEST_TIMEOUTS = {
	WORKFLOW_COMPLETION: 2000,
	STEP_DELAY: 50
} as const;

// Generate unique prefix per test run
const testFileId = Math.random().toString(36).substring(2, 8);
let testCounter = 0;

let executionLog: SharedExecutionLog;

// Define simple workflow
const SimpleWorkflowDef = Workflow.define({
	name: 'simple-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

// Step groups for SimpleWorkflow
const simpleStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'compute' }]
	}
];

// Step handlers for SimpleWorkflow
const createSimpleStepHandlers = () => ({
	compute: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'SimpleWorkflow',
				stepName: 'compute',
				action: 'execute',
				data: { input: ctx.data.value }
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			return { computed: ctx.data.value * 2 };
		}
	}
});

// Define slow workflow
const SlowWorkflowDef = Workflow.define({
	name: 'slow-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

// Step groups for SlowWorkflow
const slowStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'step1' }, { name: 'step2' }, { name: 'step3' }]
	}
];

// Step handlers for SlowWorkflow
const createSlowStepHandlers = () => ({
	step1: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'SlowWorkflow',
				stepName: 'step1',
				action: 'execute'
			});
			await delay(200); // Slow step
			return { value: ctx.data.value };
		}
	},
	step2: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'SlowWorkflow',
				stepName: 'step2',
				action: 'execute'
			});
			await delay(200);
			const prev = (ctx.results['step1'] as { value: number }).value;
			return { value: prev * 2 };
		}
	},
	step3: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'SlowWorkflow',
				stepName: 'step3',
				action: 'execute'
			});
			await delay(200);
			const prev = (ctx.results['step2'] as { value: number }).value;
			return { value: prev + 10 };
		}
	}
});

describe('BullMQ Workflow Handle Recovery', () => {
	let harness: MultiInstanceTestHarness;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `wf-recovery-${testFileId}-${++testCounter}`;
		harness = new MultiInstanceTestHarness(connection, uniquePrefix);
		executionLog = createSharedExecutionLog();
	});

	afterEach(async () => {
		await harness.stopAll();
	});

	describe('status recovery after instance death', () => {
		it(
			'should allow new instance to get completed workflow status using flowId',
			async () => {
				// ARRANGE: Register workflow and create first instance
				harness.registerConsumer(
					'simple-workflow',
					async (_data, _meta, stepResults) => {
						const stepResult = stepResults?.['compute'] as { computed: number } | undefined;
						return { result: stepResult?.computed ?? 0 };
					},
					simpleStepGroups,
					createSimpleStepHandlers()
				);
				harness.createInstance('instance1');
				await harness.startAll();

				const instance1 = harness.getInstance('instance1');

				// ACT: Start workflow on instance1
				const handle = await instance1.execute(SimpleWorkflowDef, { value: 21 });
				const flowId = handle.id;

				// Wait for workflow to complete
				const result = await handle.result();
				expect(result).toEqual({ result: 42 });

				// Verify workflow completed on instance1
				const status1 = await handle.status();
				expect(status1).toBe('completed');

				// Stop instance1 (simulates server death/restart)
				await harness.stopInstance('instance1');

				// Create a NEW instance (simulates server restart or different server)
				harness.createInstance('instance2');
				await harness.startInstance('instance2');

				const instance2 = harness.getInstance('instance2');

				// ASSERT: New instance should be able to get status using flowId
				// Currently this will FAIL because localFlowStates is in-memory
				const statusFromInstance2 = await instance2.getStatus(flowId);

				// BUG: This returns 'pending' because instance2 has no knowledge of flowId
				// EXPECTED: Should return 'completed' by querying Redis
				expect(statusFromInstance2).toBe('completed');
			},
			TEST_TIMEOUTS.WORKFLOW_COMPLETION
		);

		it(
			'should allow new instance to get running workflow status using flowId',
			async () => {
				// ARRANGE: Use slow workflow so we can check status mid-execution
				harness.registerConsumer(
					'slow-workflow',
					async (_data, _meta, stepResults) => {
						const stepResult = stepResults?.['step3'] as { value: number } | undefined;
						return { result: stepResult?.value ?? 0 };
					},
					slowStepGroups,
					createSlowStepHandlers()
				);
				harness.createInstance('emitter');
				harness.createInstance('worker');
				await harness.startAll();

				const emitter = harness.getInstance('emitter');

				// ACT: Start workflow
				const handle = await emitter.execute(SlowWorkflowDef, { value: 5 });
				const flowId = handle.id;

				// Wait for workflow to start but not complete
				await delay(100);

				// Stop emitter (the instance that started the workflow)
				await harness.stopInstance('emitter');

				// Create replacement instance
				harness.createInstance('replacement');
				await harness.startInstance('replacement');

				const replacement = harness.getInstance('replacement');

				// ASSERT: Replacement should see workflow as running
				// Currently this will FAIL - returns 'pending' instead of 'running'
				const statusFromReplacement = await replacement.getStatus(flowId);
				expect(['running', 'active', 'waiting']).toContain(statusFromReplacement);

				// Wait for workflow to complete (worker is still running)
				await delay(TEST_TIMEOUTS.WORKFLOW_COMPLETION);

				// After completion, replacement should see 'completed'
				const finalStatus = await replacement.getStatus(flowId);
				expect(finalStatus).toBe('completed');
			},
			TEST_TIMEOUTS.WORKFLOW_COMPLETION * 2
		);
	});

	describe('result recovery after instance death', () => {
		it(
			'should allow new instance to retrieve completed workflow result using flowId',
			async () => {
				// ARRANGE
				harness.registerConsumer(
					'simple-workflow',
					async (_data, _meta, stepResults) => {
						const stepResult = stepResults?.['compute'] as { computed: number } | undefined;
						return { result: stepResult?.computed ?? 0 };
					},
					simpleStepGroups,
					createSimpleStepHandlers()
				);
				harness.createInstance('original');
				await harness.startAll();

				const original = harness.getInstance('original');

				// ACT: Start and complete workflow
				const handle = await original.execute(SimpleWorkflowDef, { value: 50 });
				const flowId = handle.id;

				// Wait for completion
				const originalResult = await handle.result();
				expect(originalResult).toEqual({ result: 100 });

				// Stop original instance
				await harness.stopInstance('original');

				// Create new instance
				harness.createInstance('recovery');
				await harness.startInstance('recovery');

				const recovery = harness.getInstance('recovery');

				// ASSERT: New instance should be able to get result using flowId
				// This requires a new method like getResult(flowId) or reconstructing the handle
				// Currently there's NO WAY to do this - the result promise is lost
				const recoveredResult = await recovery.getResult(flowId);
				expect(recoveredResult).toEqual({ result: 100 });
			},
			TEST_TIMEOUTS.WORKFLOW_COMPLETION
		);

		it(
			'should allow new instance to wait for in-progress workflow result',
			async () => {
				// ARRANGE
				harness.registerConsumer(
					'slow-workflow',
					async (_data, _meta, stepResults) => {
						const stepResult = stepResults?.['step3'] as { value: number } | undefined;
						return { result: stepResult?.value ?? 0 };
					},
					slowStepGroups,
					createSlowStepHandlers()
				);
				harness.createInstance('starter');
				harness.createInstance('processor');
				await harness.startAll();

				const starter = harness.getInstance('starter');

				// ACT: Start workflow (will take ~600ms with 3x200ms steps)
				const handle = await starter.execute(SlowWorkflowDef, { value: 10 });
				const flowId = handle.id;

				// Wait briefly then kill starter
				await delay(50);
				await harness.stopInstance('starter');

				// Create new instance that wants to wait for the result
				harness.createInstance('waiter');
				await harness.startInstance('waiter');

				const waiter = harness.getInstance('waiter');

				// ASSERT: Waiter should be able to wait for and receive the result
				// Even though it didn't start the workflow
				// Expected result: (10 * 2) + 10 = 30
				const result = await waiter.getResult(flowId);
				expect(result).toEqual({ result: 30 });
			},
			TEST_TIMEOUTS.WORKFLOW_COMPLETION * 2
		);
	});

	describe('handle reconstruction', () => {
		it(
			'should reconstruct a fully functional handle from flowId alone',
			async () => {
				// ARRANGE
				harness.registerConsumer(
					'simple-workflow',
					async (_data, _meta, stepResults) => {
						const stepResult = stepResults?.['compute'] as { computed: number } | undefined;
						return { result: stepResult?.computed ?? 0 };
					},
					simpleStepGroups,
					createSimpleStepHandlers()
				);
				harness.createInstance('first');
				await harness.startAll();

				const first = harness.getInstance('first');

				// ACT: Execute workflow and get flowId
				const originalHandle = await first.execute(SimpleWorkflowDef, { value: 25 });
				const flowId = originalHandle.id;

				// Complete the workflow
				await originalHandle.result();

				// Stop first instance
				await harness.stopInstance('first');

				// Create second instance
				harness.createInstance('second');
				await harness.startInstance('second');

				const second = harness.getInstance('second');

				// ASSERT: Should be able to reconstruct handle from flowId
				// This handle should have working status() and result() methods
				const reconstructedHandle = await second.getHandle(flowId);

				expect(reconstructedHandle.id).toBe(flowId);
				expect(await reconstructedHandle.status()).toBe('completed');
				expect(await reconstructedHandle.result()).toEqual({ result: 50 });
			},
			TEST_TIMEOUTS.WORKFLOW_COMPLETION
		);
	});
});
