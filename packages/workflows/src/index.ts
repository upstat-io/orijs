/**
 * @module workflows
 * Workflow system for OriJS.
 */

// Types needed by consumers and sibling packages
export type {
	WorkflowExecutor,
	WorkflowProvider,
	WorkflowLifecycle,
	WorkflowDefinitionLike,
	FlowHandle,
	FlowStatus,
	StepHandler,
	RollbackHandler,
	StepOptions,
	StepDefinitionBase,
	StepGroup
} from './workflow.types';

// Error types
export { WorkflowStepError } from './workflow.types';

// Context (used by step handlers)
export { createWorkflowContext, type WorkflowContext } from './workflow-context';

// In-process provider (default provider)
export { InProcessWorkflowProvider, WorkflowTimeoutError } from './in-process-workflow-provider';
