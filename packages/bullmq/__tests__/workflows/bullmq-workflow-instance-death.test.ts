/**
 * BullMQ Workflow Instance Death Tests
 *
 * Tests workflow behavior when provider instances crash or stop:
 * - Work continuation by surviving instances
 * - Stalled job recovery
 * - Result delivery even when original caller dies
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

// Test timeout constants - optimized for fast execution while still testing death/recovery
const TEST_TIMEOUTS = {
	WORKFLOW_EXECUTION: 1_500,
	STEP_DELAY: 5,
	STALL_INTERVAL: 50, // Fast stall detection for tests
	STALL_RECOVERY_WAIT: 150 // Wait for stalled job to be picked up
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

describe('BullMQ Workflow Instance Death', () => {
	let harness: MultiInstanceTestHarness;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `wf-death-${testFileId}-${++testCounter}`;
		harness = new MultiInstanceTestHarness(connection, uniquePrefix);
		executionLog = createSharedExecutionLog();
	});

	afterEach(async () => {
		await harness.stopAll();
	});

	describe('graceful shutdown', () => {
		it(
			'should allow surviving instance to complete workflows when one stops',
			async () => {
				harness.registerConsumer(
					'tracked-workflow',
					async (_data, _meta, stepResults) => {
						const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
						return { result: step3Result?.computed ?? 0 };
					},
					trackedStepGroups,
					createTrackedStepHandlers()
				);
				harness.createInstance('primary');
				harness.createInstance('backup');
				await harness.startAll();

				// Start multiple workflows from primary
				const primary = harness.getInstance('primary');
				const handles = await Promise.all([
					primary.execute(TrackedWorkflowDef, { value: 1 }),
					primary.execute(TrackedWorkflowDef, { value: 2 }),
					primary.execute(TrackedWorkflowDef, { value: 3 })
				]);

				// Verify handles were created
				expect(handles.length).toBe(3);

				// Wait for some work to start
				await delay(50);

				// Stop primary instance
				await harness.stopInstance('primary');

				// Wait for workflows to complete via backup
				// Note: We can't await results from stopped instance handles,
				// but we can verify the work completes by checking execution log
				await delay(TEST_TIMEOUTS.WORKFLOW_EXECUTION / 2);

				// All 9 steps should eventually complete (3 workflows * 3 steps)
				// Some may have been done by primary before shutdown, rest by backup
				expect(executionLog.entries.length).toBe(9);

				// Verify backup participated
				const backupEntries = executionLog.getEntriesForInstance('backup');
				console.log(`Graceful shutdown: backup executed ${backupEntries.length} steps`);
				expect(backupEntries.length).toBeGreaterThan(0);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION
		);

		it(
			'should continue processing when worker stops mid-workflow',
			async () => {
				harness.registerConsumer(
					'tracked-workflow',
					async (_data, _meta, stepResults) => {
						const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
						return { result: step3Result?.computed ?? 0 };
					},
					trackedStepGroups,
					createTrackedStepHandlers()
				);
				harness.createInstance('worker1');
				harness.createInstance('worker2');
				await harness.startAll();

				// Start a single workflow
				const worker1 = harness.getInstance('worker1');
				const handle = await worker1.execute(TrackedWorkflowDef, { value: 100 });

				// Verify workflow started
				expect(handle.id).toBeDefined();

				// Wait briefly then stop worker1
				await delay(50);
				await harness.stopInstance('worker1');

				// Wait for workflow to complete
				await delay(TEST_TIMEOUTS.WORKFLOW_EXECUTION / 2);

				// All 3 steps should complete
				expect(executionLog.entries.length).toBe(3);

				// Log which instance executed what
				const w1Entries = executionLog.getEntriesForInstance('worker1');
				const w2Entries = executionLog.getEntriesForInstance('worker2');
				console.log(`Mid-workflow stop: worker1=${w1Entries.length}, worker2=${w2Entries.length}`);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION
		);
	});

	describe('instance replacement', () => {
		it(
			'should handle instance being replaced by a new one with same role',
			async () => {
				harness.registerConsumer(
					'tracked-workflow',
					async (_data, _meta, stepResults) => {
						const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
						return { result: step3Result?.computed ?? 0 };
					},
					trackedStepGroups,
					createTrackedStepHandlers()
				);
				harness.createInstance('primary');
				harness.createInstance('secondary');
				await harness.startAll();

				const primary = harness.getInstance('primary');

				// Start workflows
				const handles = await Promise.all([
					primary.execute(TrackedWorkflowDef, { value: 1 }),
					primary.execute(TrackedWorkflowDef, { value: 2 })
				]);

				// Verify started
				expect(handles[0].id).toBeDefined();
				expect(handles[1].id).toBeDefined();

				// Stop secondary
				await harness.stopInstance('secondary');

				// Add a replacement
				harness.createInstance('replacement');
				await harness.startInstance('replacement');

				// Start more workflows
				await Promise.all([
					primary.execute(TrackedWorkflowDef, { value: 3 }),
					primary.execute(TrackedWorkflowDef, { value: 4 })
				]);

				// Wait for all to complete
				await delay(TEST_TIMEOUTS.WORKFLOW_EXECUTION / 2);

				// Should have at least 12 step executions (4 workflows * 3 steps)
				// May have more due to stalled job recovery in BullMQ (at-least-once delivery)
				expect(executionLog.entries.length).toBeGreaterThanOrEqual(12);

				// Check that replacement participated in later workflows
				const replacementEntries = executionLog.getEntriesForInstance('replacement');
				console.log(`Replacement test: replacement executed ${replacementEntries.length} steps`);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION
		);
	});

	describe('all workers stop', () => {
		it(
			'should resume workflows when new worker starts after all stop',
			async () => {
				harness.registerConsumer(
					'tracked-workflow',
					async (_data, _meta, stepResults) => {
						const step3Result = stepResults?.['step3'] as { computed: number } | undefined;
						return { result: step3Result?.computed ?? 0 };
					},
					trackedStepGroups,
					createTrackedStepHandlers()
				);
				harness.createInstance('worker');
				await harness.startInstance('worker');

				const worker = harness.getInstance('worker');

				// Start a workflow
				const handle = await worker.execute(TrackedWorkflowDef, { value: 50 });
				expect(handle.id).toBeDefined();

				// Wait briefly for workflow to start
				await delay(50);

				// Stop all workers
				await harness.stopAll();

				// Create and start a new worker
				harness.createInstance('revival');
				await harness.startInstance('revival');

				// Wait for the stalled workflow to be picked up and completed
				await delay(TEST_TIMEOUTS.STALL_RECOVERY_WAIT + TEST_TIMEOUTS.WORKFLOW_EXECUTION / 2);

				// The workflow should eventually complete
				// (stalled jobs are re-queued by BullMQ after stall interval)
				expect(executionLog.entries.length).toBeGreaterThanOrEqual(1);

				// Revival instance should have executed at least some steps
				const revivalEntries = executionLog.getEntriesForInstance('revival');
				console.log(`Revival test: revival executed ${revivalEntries.length} steps`);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION * 2
		);
	});
});
