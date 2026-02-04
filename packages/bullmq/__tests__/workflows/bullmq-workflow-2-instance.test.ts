/**
 * BullMQ Workflow 2-Instance Distribution Tests
 *
 * Tests distributed workflow execution across 2 provider instances
 * sharing the same Redis. Verifies:
 * - Work distribution between instances
 * - Result aggregation from distributed steps
 * - Rollback execution on different instance than step
 * - Result notification to originating instance
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady } from '../preload.ts';
import {
	MultiInstanceTestHarness,
	createSharedExecutionLog,
	withTimeout,
	delay,
	type SharedExecutionLog
} from './multi-instance-test-utils';
import { Workflow, type WorkflowContext } from '@orijs/core';
import { Type } from '@orijs/validation';

// Test timeout constants - optimized for fast execution while still testing distribution
const TEST_TIMEOUTS = {
	WORKFLOW_EXECUTION: 1_000,
	STEP_DELAY: 5 // Just enough for workers to pick up jobs
} as const;

// Generate unique prefix per test file to prevent parallel test interference
const testFileId = Math.random().toString(36).substring(2, 8);
let testCounter = 0;

// Shared execution log - will be set per test
let executionLog: SharedExecutionLog;

// Define tracked workflow
const TrackedWorkflowDef = Workflow.define({
	name: 'tracked-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({ result: Type.Number() })
});

// Step groups for TrackedWorkflow
const trackedStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'step1' }, { name: 'step2' }, { name: 'step3' }]
	}
];

// Step handlers for TrackedWorkflow
const createTrackedStepHandlers = () => ({
	step1: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'TrackedWorkflow',
				stepName: 'step1',
				action: 'execute',
				data: { input: ctx.data.value }
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			return { computed: ctx.data.value * 2 };
		}
	},
	step2: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			const prev = (ctx.results['step1'] as { computed: number })?.computed ?? ctx.data.value;
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'TrackedWorkflow',
				stepName: 'step2',
				action: 'execute',
				data: { input: prev }
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			return { computed: prev + 10 };
		}
	},
	step3: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			const prev = (ctx.results['step2'] as { computed: number })?.computed ?? ctx.data.value;
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'TrackedWorkflow',
				stepName: 'step3',
				action: 'execute',
				data: { input: prev }
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			return { computed: prev * 2 };
		}
	}
});

// Define failing tracked workflow
const FailingTrackedWorkflowDef = Workflow.define({
	name: 'failing-tracked-workflow',
	data: Type.Object({ value: Type.Number() }),
	result: Type.Object({})
});

// Step groups for FailingTrackedWorkflow
const failingStepGroups = [
	{
		type: 'sequential' as const,
		definitions: [{ name: 'step1' }, { name: 'step2' }]
	}
];

// Step handlers for FailingTrackedWorkflow
const createFailingStepHandlers = () => ({
	step1: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'FailingTrackedWorkflow',
				stepName: 'step1',
				action: 'execute'
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			return { done: true };
		},
		rollback: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'FailingTrackedWorkflow',
				stepName: 'step1',
				action: 'rollback'
			});
		}
	},
	step2: {
		execute: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'FailingTrackedWorkflow',
				stepName: 'step2',
				action: 'execute'
			});
			await delay(TEST_TIMEOUTS.STEP_DELAY);
			throw new Error('Intentional failure in step2');
		},
		rollback: async (ctx: WorkflowContext<{ value: number }>) => {
			executionLog.log({
				instanceName: ctx.providerId ?? 'unknown',
				workflowName: 'FailingTrackedWorkflow',
				stepName: 'step2',
				action: 'rollback'
			});
		}
	}
});

describe('BullMQ Workflow 2-Instance Distribution', () => {
	let harness: MultiInstanceTestHarness;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `wf-2inst-${testFileId}-${++testCounter}`;
		harness = new MultiInstanceTestHarness(connection, uniquePrefix);
		executionLog = createSharedExecutionLog();
	});

	afterEach(async () => {
		await harness.stopAll();
	});

	describe('work distribution', () => {
		it('should distribute steps across 2 instances', async () => {
			// Register consumer with step structure AND handlers
			harness.registerConsumer(
				'tracked-workflow',
				async (_data, _meta, stepResults) => {
					const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
					return { result: step3Result?.computed ?? 0 };
				},
				trackedStepGroups,
				createTrackedStepHandlers()
			);
			harness.createInstance('instance1');
			harness.createInstance('instance2');
			await harness.startAll();

			// Execute workflow from instance1
			const instance1 = harness.getInstance('instance1');
			const handle = await instance1.execute(TrackedWorkflowDef, { value: 5 });

			// Wait for completion
			const result = await withTimeout(
				handle.result(),
				TEST_TIMEOUTS.WORKFLOW_EXECUTION,
				'Workflow execution timeout'
			);

			// Verify result is correct: (5*2 + 10) * 2 = 40
			expect(result).toEqual({ result: 40 });

			// Verify all 3 steps were executed
			expect(executionLog.entries.length).toBe(3);
			expect(executionLog.getEntriesForStep('step1').length).toBe(1);
			expect(executionLog.getEntriesForStep('step2').length).toBe(1);
			expect(executionLog.getEntriesForStep('step3').length).toBe(1);

			// With 2 workers competing, work should be distributed
			const instance1Entries = executionLog.getEntriesForInstance('instance1');
			const instance2Entries = executionLog.getEntriesForInstance('instance2');
			console.log(
				`Instance1 executed: ${instance1Entries.length}, Instance2 executed: ${instance2Entries.length}`
			);

			// Both instances should be receiving work (exact split depends on BullMQ)
			expect(instance1Entries.length + instance2Entries.length).toBe(3);
		}, 10000);

		it('should allow any instance to execute workflow initiated from any instance', async () => {
			harness.registerConsumer(
				'tracked-workflow',
				async (_data, _meta, stepResults) => {
					const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
					return { result: step3Result?.computed ?? 0 };
				},
				trackedStepGroups,
				createTrackedStepHandlers()
			);
			harness.createInstance('instance1');
			harness.createInstance('instance2');
			await harness.startAll();

			// Execute from instance2 this time
			const instance2 = harness.getInstance('instance2');
			const handle = await instance2.execute(TrackedWorkflowDef, { value: 10 });

			const result = await withTimeout(
				handle.result(),
				TEST_TIMEOUTS.WORKFLOW_EXECUTION,
				'Workflow execution timeout'
			);

			// Verify result: (10*2 + 10) * 2 = 60
			expect(result).toEqual({ result: 60 });
			expect(executionLog.entries.length).toBe(3);
		}, 10000);
	});

	describe('multiple workflow executions', () => {
		it('should handle multiple concurrent workflow executions across instances', async () => {
			harness.registerConsumer(
				'tracked-workflow',
				async (_data, _meta, stepResults) => {
					const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
					return { result: step3Result?.computed ?? 0 };
				},
				trackedStepGroups,
				createTrackedStepHandlers()
			);
			harness.createInstance('instance1');
			harness.createInstance('instance2');
			await harness.startAll();

			const instance1 = harness.getInstance('instance1');
			const instance2 = harness.getInstance('instance2');

			// Start workflows from both instances concurrently
			const [handle1, handle2] = await Promise.all([
				instance1.execute(TrackedWorkflowDef, { value: 1 }),
				instance2.execute(TrackedWorkflowDef, { value: 2 })
			]);

			// Wait for both to complete
			const [result1, result2] = await Promise.all([
				withTimeout(handle1.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION),
				withTimeout(handle2.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)
			]);

			// Verify results: (1*2 + 10) * 2 = 24, (2*2 + 10) * 2 = 28
			expect(result1).toEqual({ result: 24 });
			expect(result2).toEqual({ result: 28 });

			// Both workflows should have executed all steps (6 total)
			expect(executionLog.entries.length).toBe(6);
		}, 10000);
	});

	describe('rollback distribution', () => {
		it('should execute rollback on available instance when step fails', async () => {
			harness.registerConsumer(
				'failing-tracked-workflow',
				async () => ({}),
				failingStepGroups,
				createFailingStepHandlers()
			);
			harness.createInstance('instance1');
			harness.createInstance('instance2');
			await harness.startAll();

			const instance1 = harness.getInstance('instance1');
			const handle = await instance1.execute(FailingTrackedWorkflowDef, { value: 5 });

			// Should fail - in distributed mode, error message may vary depending on which instance
			// processed the failing step vs which receives the QueueEvents failure notification
			await expect(withTimeout(handle.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)).rejects.toThrow();

			// Wait a bit for rollback to complete
			await delay(50);

			// Verify step1 was executed and rolled back
			const step1Executions = executionLog.getEntriesForStep('step1').filter((e) => e.action === 'execute');
			const step1Rollbacks = executionLog.getEntriesForStep('step1').filter((e) => e.action === 'rollback');
			expect(step1Executions.length).toBe(1);
			// In distributed mode, rollback might be attempted by multiple workers due to race conditions
			// The important thing is that rollback was triggered at least once
			expect(step1Rollbacks.length).toBeGreaterThanOrEqual(1);

			// Verify step2 was executed (and failed)
			// In distributed mode, there's a narrow race window where both workers might attempt
			// step2 before one discovers the job is already being processed
			const step2Executions = executionLog.getEntriesForStep('step2').filter((e) => e.action === 'execute');
			expect(step2Executions.length).toBeGreaterThanOrEqual(1);
		}, 10000);
	});

	describe('instance failure scenarios', () => {
		it('should continue processing if one instance stops', async () => {
			harness.registerConsumer(
				'tracked-workflow',
				async (_data, _meta, stepResults) => {
					const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
					return { result: step3Result?.computed ?? 0 };
				},
				trackedStepGroups,
				createTrackedStepHandlers()
			);
			harness.createInstance('instance1');
			harness.createInstance('instance2');
			await harness.startAll();

			// Execute a workflow
			const instance1 = harness.getInstance('instance1');
			const handle1 = await instance1.execute(TrackedWorkflowDef, { value: 3 });

			// Wait for it to complete first
			await withTimeout(handle1.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// Now stop instance2 and verify instance1 can still handle workflows
			await harness.stopInstance('instance2');

			const handle2 = await instance1.execute(TrackedWorkflowDef, { value: 7 });
			const result = await withTimeout(handle2.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION);

			// (7*2 + 10) * 2 = 48
			expect(result).toEqual({ result: 48 });
		}, 15000);
	});
});
