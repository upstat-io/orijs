/**
 * FlowBuilder Unit Tests
 *
 * Tests the conversion from WorkflowBuilder step groups to BullMQ FlowJob structure.
 *
 * Key conversions:
 * - Sequential steps → nested children (deepest runs first)
 * - Parallel steps → flat children array (run concurrently)
 * - Mixed groups → combination of both patterns
 */

import { describe, it, expect } from 'bun:test';
import type { StepGroup, StepDefinitionBase } from '@orijs/workflows';
import {
	FlowBuilder,
	createFlowBuilder,
	JOB_DATA_VERSION,
	type StepJobData,
	type WorkflowJobData
} from '../../src/workflows/flow-builder.ts';

/**
 * Helper to create a step definition for testing.
 * StepDefinitionBase only contains name - handlers are registered separately.
 */
function createStep(name: string): StepDefinitionBase {
	return { name };
}

describe('FlowBuilder', () => {
	describe('buildFlow', () => {
		it('should create parent job with workflow name and data', () => {
			const builder = new FlowBuilder({
				workflowName: 'TestWorkflow',
				flowId: 'flow-123',
				queuePrefix: 'workflow'
			});

			const flow = builder.buildFlow([], { userId: 'user-1' });

			expect(flow.name).toBe('TestWorkflow');
			expect(flow.queueName).toBe('workflow.TestWorkflow');
			expect(flow.data).toEqual({
				type: 'workflow',
				version: JOB_DATA_VERSION,
				flowId: 'flow-123',
				workflowData: { userId: 'user-1' },
				stepResults: {}
			});
		});

		it('should include version field in workflow and step job data', () => {
			const builder = new FlowBuilder({
				workflowName: 'VersionTest',
				flowId: 'flow-version',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('step1')]
				}
			];

			const flow = builder.buildFlow(stepGroups, { data: 'test' });

			// Parent workflow job should have version
			const workflowData = flow.data as WorkflowJobData;
			expect(workflowData.version).toBe(JOB_DATA_VERSION);
			expect(workflowData.version).toBe('1');

			// Step job should have version
			const stepJob = flow.children![0]!;
			const stepData = stepJob.data as StepJobData;
			expect(stepData.version).toBe(JOB_DATA_VERSION);
			expect(stepData.version).toBe('1');
		});

		it('should include version in parallel group job data', () => {
			const builder = new FlowBuilder({
				workflowName: 'ParallelVersionTest',
				flowId: 'flow-pv',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'parallel',
					definitions: [createStep('step-a'), createStep('step-b')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Parallel group job should have version
			const parallelJob = flow.children![0]!;
			const stepData = parallelJob.data as StepJobData;
			expect(stepData.version).toBe(JOB_DATA_VERSION);
		});

		it('should build sequential steps as nested children (deepest first)', () => {
			const builder = new FlowBuilder({
				workflowName: 'SequentialWorkflow',
				flowId: 'flow-456',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('step1'), createStep('step2'), createStep('step3')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Sequential: step1 → step2 → step3
			// BullMQ structure: parent has child step3, which has child step2, which has child step1
			// Execution order: step1 (deepest) → step2 → step3 → parent
			expect(flow.children).toHaveLength(1);
			const step3 = flow.children![0]!;
			expect(step3.name).toBe('step3');
			expect(step3.children).toHaveLength(1);
			const step2 = step3.children![0]!;
			expect(step2.name).toBe('step2');
			expect(step2.children).toHaveLength(1);
			const step1 = step2.children![0]!;
			expect(step1.name).toBe('step1');
			expect(step1.children).toBeUndefined();
		});

		it('should build parallel steps as single parallel group job', () => {
			const builder = new FlowBuilder({
				workflowName: 'ParallelWorkflow',
				flowId: 'flow-789',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'parallel',
					definitions: [createStep('notify-email'), createStep('notify-sms'), createStep('notify-slack')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Parallel: creates single __parallel__ job containing all step names
			expect(flow.children).toHaveLength(1);
			const parallelJob = flow.children![0]!;
			expect(parallelJob.name).toBe('__parallel__:notify-email,notify-sms,notify-slack');
			expect(parallelJob.children).toBeUndefined();
		});

		it('should build mixed sequential then parallel groups', () => {
			const builder = new FlowBuilder({
				workflowName: 'MixedWorkflow',
				flowId: 'flow-mixed',
				queuePrefix: 'workflow'
			});

			// Workflow: validate → process → (notify-email || notify-sms)
			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('validate'), createStep('process')]
				},
				{
					type: 'parallel',
					definitions: [createStep('notify-email'), createStep('notify-sms')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Structure: parent ← __parallel__ ← process ← validate
			// Execution: validate → process → (parallel job with notify-email, notify-sms) → parent
			expect(flow.children).toHaveLength(1);
			const parallelJob = flow.children![0]!;
			expect(parallelJob.name).toBe('__parallel__:notify-email,notify-sms');

			// Parallel job should have the sequential chain as children
			expect(parallelJob.children).toHaveLength(1);
			const processStep = parallelJob.children![0]!;
			expect(processStep.name).toBe('process');
			expect(processStep.children).toHaveLength(1);
			const validateStep = processStep.children![0]!;
			expect(validateStep.name).toBe('validate');
		});

		it('should build mixed parallel then sequential groups', () => {
			const builder = new FlowBuilder({
				workflowName: 'ParallelThenSeq',
				flowId: 'flow-pts',
				queuePrefix: 'workflow'
			});

			// Workflow: (fetch-a || fetch-b) → merge → save
			const stepGroups: StepGroup[] = [
				{
					type: 'parallel',
					definitions: [createStep('fetch-a'), createStep('fetch-b')]
				},
				{
					type: 'sequential',
					definitions: [createStep('merge'), createStep('save')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Structure: parent ← save ← merge ← __parallel__
			// Execution: (parallel job with fetch-a, fetch-b) → merge → save → parent
			expect(flow.children).toHaveLength(1);
			const saveStep = flow.children![0]!;
			expect(saveStep.name).toBe('save');
			expect(saveStep.children).toHaveLength(1);
			const mergeStep = saveStep.children![0]!;
			expect(mergeStep.name).toBe('merge');
			expect(mergeStep.children).toHaveLength(1);
			const parallelJob = mergeStep.children![0]!;
			expect(parallelJob.name).toBe('__parallel__:fetch-a,fetch-b');
		});

		it('should handle empty step groups', () => {
			const builder = new FlowBuilder({
				workflowName: 'EmptyWorkflow',
				flowId: 'flow-empty',
				queuePrefix: 'workflow'
			});

			const flow = builder.buildFlow([], { data: 'test' });

			expect(flow.name).toBe('EmptyWorkflow');
			expect(flow.children).toBeUndefined();
			expect(flow.data.workflowData).toEqual({ data: 'test' });
		});

		it('should handle single step', () => {
			const builder = new FlowBuilder({
				workflowName: 'SingleStep',
				flowId: 'flow-single',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('only-step')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			expect(flow.children).toHaveLength(1);
			const onlyStep = flow.children![0]!;
			expect(onlyStep.name).toBe('only-step');
			expect(onlyStep.children).toBeUndefined();
		});

		it('should include step queue name based on workflow', () => {
			const builder = new FlowBuilder({
				workflowName: 'QueueTest',
				flowId: 'flow-q',
				queuePrefix: 'wf'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('my-step')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Step queues use format: {prefix}.{workflowName}.steps
			const myStep = flow.children![0]!;
			expect(myStep.queueName).toBe('wf.QueueTest.steps');
		});

		it('should include flowId and step name in step data', () => {
			const builder = new FlowBuilder({
				workflowName: 'DataTest',
				flowId: 'flow-data',
				queuePrefix: 'workflow'
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('data-step')]
				}
			];

			const flow = builder.buildFlow(stepGroups, { inputData: 123 });

			const dataStep = flow.children![0]!;
			const stepData = dataStep.data as StepJobData;
			expect(stepData.flowId).toBe('flow-data');
			expect(stepData.stepName).toBe('data-step');
			expect(stepData.workflowData).toEqual({ inputData: 123 });
		});

		it('should include propagation meta in job data when provided', () => {
			const builder = new FlowBuilder({
				workflowName: 'MetaTest',
				flowId: 'flow-meta',
				queuePrefix: 'workflow',
				meta: {
					request_id: 'req-123',
					trace_id: 'trace-456',
					user_id: 'user-789'
				}
			});

			const stepGroups: StepGroup[] = [
				{
					type: 'sequential',
					definitions: [createStep('meta-step')]
				}
			];

			const flow = builder.buildFlow(stepGroups, {});

			// Parent job should have meta
			expect(flow.data.meta).toEqual({
				request_id: 'req-123',
				trace_id: 'trace-456',
				user_id: 'user-789'
			});

			// Step job should have meta
			const metaStep = flow.children![0]!;
			expect(metaStep.data.meta).toEqual({
				request_id: 'req-123',
				trace_id: 'trace-456',
				user_id: 'user-789'
			});
		});
	});

	describe('getStepQueueName', () => {
		it('should return step queue name for workflow', () => {
			const builder = new FlowBuilder({
				workflowName: 'TestWf',
				flowId: 'f-1',
				queuePrefix: 'wf'
			});

			expect(builder.getStepQueueName()).toBe('wf.TestWf.steps');
		});
	});

	describe('getWorkflowQueueName', () => {
		it('should return workflow queue name', () => {
			const builder = new FlowBuilder({
				workflowName: 'TestWf',
				flowId: 'f-1',
				queuePrefix: 'wf'
			});

			expect(builder.getWorkflowQueueName()).toBe('wf.TestWf');
		});
	});
});

describe('createFlowBuilder', () => {
	it('should create a new FlowBuilder instance', () => {
		const builder = createFlowBuilder({
			workflowName: 'TestWorkflow',
			flowId: 'flow-123',
			queuePrefix: 'workflow'
		});

		expect(builder).toBeInstanceOf(FlowBuilder);
	});

	it('should create builder with correct options', () => {
		const builder = createFlowBuilder({
			workflowName: 'MyWorkflow',
			flowId: 'flow-456',
			queuePrefix: 'my-prefix'
		});

		expect(builder.getWorkflowQueueName()).toBe('my-prefix.MyWorkflow');
		expect(builder.getStepQueueName()).toBe('my-prefix.MyWorkflow.steps');
	});
});
