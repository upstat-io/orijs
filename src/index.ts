/**
 * OriJS - A lightweight, high-performance TypeScript backend framework for Bun
 *
 * Named after the Ori from Stargate SG-1.
 *
 * This file re-exports all packages for convenience. For smaller bundles,
 * import directly from individual packages:
 *
 * @example
 * import { Application } from '@orijs/core';
 * import { Logger } from '@orijs/logging';
 * import { CacheService } from '@orijs/cache';
 */

// Core framework (canonical source for EventContext, WorkflowContext consumer types)
export * from '@orijs/core';

export * from '@orijs/config';

// Events - exclude EventContext (use @orijs/core version for consumers)
export {
	createEventContext,
	createChainedMeta,
	InProcessEventProvider,
	EventRegistry,
	EventSubscription,
	createSubscription,
	createEventSystem,
	createPropagationMeta,
	type EventSystem,
	type EventProvider,
	type EventMessage,
	type BuiltEventRegistry,
	type EventEmitFn,
	type CreateEventContextOptions
} from '@orijs/events';

export * from '@orijs/logging';
export * from '@orijs/validation';

// Workflows - exclude WorkflowContext (use @orijs/core version for consumers)
export {
	createWorkflowContext,
	InProcessWorkflowProvider,
	WorkflowTimeoutError,
	WorkflowStepError,
	type WorkflowExecutor,
	type WorkflowLifecycle,
	type WorkflowProvider,
	type WorkflowDefinitionLike,
	type FlowHandle,
	type FlowStatus,
	type StepHandler,
	type RollbackHandler,
	type StepOptions,
	type StepDefinitionBase,
	type StepGroup
} from '@orijs/workflows';

export * from '@orijs/cache';
export * from '@orijs/mapper';
export * from '@orijs/sql';
