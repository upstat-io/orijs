/**
 * Workflows - Main facade for the OriJS workflow system.
 *
 * Provides workflow orchestration with:
 * - Sequential and parallel step execution
 * - Result accumulation across steps
 * - Error handling with onError callbacks
 * - Type-safe workflow registration via Workflow.define()
 *
 * @module workflows/workflows
 */

// Types
export type {
	WorkflowExecutor,
	WorkflowLifecycle,
	WorkflowProvider,
	WorkflowDefinitionLike,
	FlowHandle,
	FlowStatus,
	StepHandler,
	RollbackHandler,
	StepOptions,
	StepDefinitionBase,
	StepGroup
} from './workflow.types';

// Errors
export { WorkflowStepError } from './workflow.types';

// Context
export { DefaultWorkflowContext, createWorkflowContext, type WorkflowContext } from './workflow-context';

// Providers
export {
	InProcessWorkflowProvider,
	WorkflowTimeoutError,
	type WorkflowProviderConfig
} from './in-process-workflow-provider';
