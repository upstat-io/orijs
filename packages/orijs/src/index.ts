/**
 * @orijs/orijs - OriJS Framework Meta-Package
 *
 * A lightweight, high-performance TypeScript backend framework for Bun.
 * This package re-exports all core OriJS modules for convenience.
 *
 * @example
 * // Import everything from one package
 * import { Application, Logger, CacheService } from '@orijs/orijs';
 *
 * // Or import from individual packages for smaller bundles
 * import { Application } from '@orijs/core';
 * import { Logger } from '@orijs/logging';
 * import { CacheService } from '@orijs/cache';
 */

// Core framework (canonical source for EventContext, WorkflowContext consumer types)
export * from '@orijs/core';

// Logging
export * from '@orijs/logging';

// Configuration
export * from '@orijs/config';

// Validation (TypeBox wrappers)
export * from '@orijs/validation';

// SQL Result Mapping
export * from '@orijs/mapper';

// Event System - exclude EventContext (use @orijs/core version for consumers)
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

// Workflow Orchestration - exclude WorkflowContext (use @orijs/core version for consumers)
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

// Caching System
export * from '@orijs/cache';

// WebSocket Support
export {
	// Types
	type BunServer,
	type SocketData,
	type WebSocketConnection,
	type WebSocketUpgradeOptions,
	type WebSocketHandlers,
	type SocketEmitter,
	type SocketLifecycle,
	type WebSocketProvider,
	type WebSocketProviderOptions,
	type SocketEmitterConstructor,
	type SocketCoordinatorOptions,
	type InProcWsProviderOptions,
	// Tokens
	WebSocketProviderToken,
	// Classes
	SocketCoordinator,
	InProcWsProvider,
	// Factory functions
	createInProcWsProvider
} from '@orijs/websocket';
