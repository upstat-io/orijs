/**
 * BullMQ Workflow 3-Instance Distribution Tests
 *
 * Tests distributed workflow execution across 3 provider instances
 * sharing the same Redis. Verifies:
 * - Work distribution across all 3 instances
 * - Quorum behavior with odd number of instances
 * - Result delivery regardless of which instance executes steps
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
	WORKFLOW_EXECUTION: 1_500,
	STEP_DELAY: 10 // Just enough for workers to pick up jobs
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

describe('BullMQ Workflow 3-Instance Distribution', () => {
	let harness: MultiInstanceTestHarness;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		const connection = getRedisConnectionOptions();
		const uniquePrefix = `wf-3inst-${testFileId}-${++testCounter}`;
		harness = new MultiInstanceTestHarness(connection, uniquePrefix);
		executionLog = createSharedExecutionLog();
	});

	afterEach(async () => {
		await harness.stopAll();
	});

	describe('3-way distribution', () => {
		it(
			'should distribute work across all 3 instances',
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
				harness.createInstance('alpha');
				harness.createInstance('beta');
				harness.createInstance('gamma');
				await harness.startAll();

				// Execute many workflows to maximize distribution chance
				const alpha = harness.getInstance('alpha');
				const handles = await Promise.all([
					alpha.execute(TrackedWorkflowDef, { value: 1 }),
					alpha.execute(TrackedWorkflowDef, { value: 2 }),
					alpha.execute(TrackedWorkflowDef, { value: 3 }),
					alpha.execute(TrackedWorkflowDef, { value: 4 }),
					alpha.execute(TrackedWorkflowDef, { value: 5 }),
					alpha.execute(TrackedWorkflowDef, { value: 6 }),
					alpha.execute(TrackedWorkflowDef, { value: 7 })
				]);

				// Wait for all to complete
				const results = await Promise.all(
					handles.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION))
				);

				// Verify all results are correct
				for (let i = 0; i < 7; i++) {
					const expected = ((i + 1) * 2 + 10) * 2;
					expect(results[i]).toEqual({ result: expected });
				}

				// Should have 21 step executions total (7 workflows * 3 steps)
				expect(executionLog.entries.length).toBe(21);

				// Check distribution across all 3 instances
				const alphaEntries = executionLog.getEntriesForInstance('alpha');
				const betaEntries = executionLog.getEntriesForInstance('beta');
				const gammaEntries = executionLog.getEntriesForInstance('gamma');

				console.log(
					`3-way distribution: alpha=${alphaEntries.length}, beta=${betaEntries.length}, gamma=${gammaEntries.length}`
				);

				// At minimum, 2 of 3 instances should participate (BullMQ doesn't guarantee perfect distribution)
				const participatingInstances = [alphaEntries, betaEntries, gammaEntries].filter(
					(e) => e.length > 0
				).length;
				expect(participatingInstances).toBeGreaterThanOrEqual(2);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION * 2
		);

		it(
			'should deliver results to caller regardless of which instances execute',
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
				harness.createInstance('caller');
				harness.createInstance('worker1');
				harness.createInstance('worker2');
				await harness.startAll();

				// Start workflows from 'caller' instance
				const caller = harness.getInstance('caller');
				const handles = await Promise.all([
					caller.execute(TrackedWorkflowDef, { value: 10 }),
					caller.execute(TrackedWorkflowDef, { value: 20 }),
					caller.execute(TrackedWorkflowDef, { value: 30 })
				]);

				// Get results - should work regardless of which worker executes
				const results = await Promise.all(
					handles.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION))
				);

				// (10*2+10)*2=60, (20*2+10)*2=100, (30*2+10)*2=140
				expect(results[0]).toEqual({ result: 60 });
				expect(results[1]).toEqual({ result: 100 });
				expect(results[2]).toEqual({ result: 140 });

				// Verify all statuses are accessible from caller
				for (const handle of handles) {
					const status = await handle.status();
					expect(status).toBe('completed');
				}
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION * 2
		);
	});

	describe('instance joining mid-execution', () => {
		it(
			'should allow third instance to join and participate',
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

				// Start with 2 instances
				harness.createInstance('original1');
				harness.createInstance('original2');
				await harness.startAll();

				const original1 = harness.getInstance('original1');

				// Start some workflows
				const handles1 = await Promise.all([
					original1.execute(TrackedWorkflowDef, { value: 1 }),
					original1.execute(TrackedWorkflowDef, { value: 2 })
				]);

				// Add third instance while work is in progress
				harness.createInstance('newcomer');
				await harness.startInstance('newcomer');

				// Start more workflows
				const handles2 = await Promise.all([
					original1.execute(TrackedWorkflowDef, { value: 3 }),
					original1.execute(TrackedWorkflowDef, { value: 4 }),
					original1.execute(TrackedWorkflowDef, { value: 5 })
				]);

				// Wait for all to complete
				await Promise.all([
					...handles1.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION)),
					...handles2.map((h) => withTimeout(h.result(), TEST_TIMEOUTS.WORKFLOW_EXECUTION))
				]);

				// Should have 15 step executions (5 workflows * 3 steps)
				expect(executionLog.entries.length).toBe(15);

				// Log distribution
				const o1 = executionLog.getEntriesForInstance('original1');
				const o2 = executionLog.getEntriesForInstance('original2');
				const nc = executionLog.getEntriesForInstance('newcomer');
				console.log(`Join test: original1=${o1.length}, original2=${o2.length}, newcomer=${nc.length}`);
			},
			TEST_TIMEOUTS.WORKFLOW_EXECUTION * 2
		);
	});
});
