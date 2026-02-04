/**
 * Workflow module exports.
 *
 * Provides BullMQ-based workflow execution using FlowProducer for
 * distributed parent-child job relationships.
 *
 * @module workflows
 */

// Main provider
export {
	BullMQWorkflowProvider,
	createBullMQWorkflowProvider,
	type BullMQWorkflowProviderOptions,
	type BullMQWorkflowOptions,
	type BullMQJobOptions,
	type BullMQWorkerOptions,
	type ExecuteOptions,
	type IFlowProducer,
	type IWorker
} from './bullmq-workflow-provider';

// Flow building (internal, but exported for testing/extension)
export {
	FlowBuilder,
	type FlowBuilderOptions,
	type FlowJobDefinition,
	type StepJobData,
	type WorkflowJobData
} from './flow-builder';

// Step registry (internal, but exported for testing/extension)
export { StepRegistry, StepNotFoundError, createStepRegistry } from './step-registry';
