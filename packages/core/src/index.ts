// Core exports
export { Ori, OriApplication, Application } from './application';
export type { ApplicationOptions } from './application';
export { Container } from './container';
export { FrameworkError, throwFrameworkError, isDebugMode } from './framework-error';
export { AppContext } from './app-context';
export type { BaseContext } from './base-context';
export { parseQuery } from './utils/query';

// Token utilities for named providers
export { createToken, isToken } from './token';
export type { Token } from './token';

// Coordinators (internal, but exposed for testing and extension)
export { RoutingCoordinator } from './routing-coordinator';
export { EventCoordinator } from './event-coordinator';
export type { EventProviderFactory } from './event-coordinator';
export { WorkflowCoordinator } from './workflow-coordinator';
export type { WorkflowProviderFactory } from './workflow-coordinator';
export { ProviderCoordinator } from './provider-coordinator';
export { LifecycleManager } from './lifecycle-manager';
export type { LifecycleOptions, ShutdownCallback } from './lifecycle-manager';
export { DependencyValidator } from './dependency-validator';
export { SocketRoutingCoordinator } from './sockets/socket-routing-coordinator';

// Re-export from controllers (moved files)
export {
	RouteBuilder,
	RequestContext,
	RequestContextFactory,
	ResponseFactory,
	responseFactory,
	OriResponse
} from './controllers/index';

// Re-export from sockets
export { SocketContext, SocketContextFactory, SocketRouteBuilder, SocketPipeline } from './sockets/index';

// Types (from ../types/)
export type {
	Handler,
	Guard,
	GuardClass,
	Interceptor,
	InterceptorClass,
	Pipe,
	PipeClass,
	PipeMetadata,
	OriController,
	ControllerClass,
	Constructor,
	InjectionToken,
	HttpMethod,
	RouteDefinition,
	RouteBuilder as IRouteBuilder,
	// Socket router types
	SocketContextLike,
	SocketGuard,
	SocketGuardClass,
	OriSocketRouter,
	SocketRouterClass,
	SocketHandler,
	SocketRouteDefinition,
	SocketRouteBuilder as ISocketRouteBuilder,
	SocketRouterConfig,
	SocketMessageFormat,
	SocketResponse,
	SocketCtx
} from './types/index';

// Workflow and Event definitions
export { Workflow, isWorkflowDefinition } from './types/index';
export type { WorkflowDefinition, WorkflowConfig, WorkflowContext, StepContext } from './types/index';
export { Event } from './types/index';
export type { EventDefinition, EventConfig, EventContext } from './types/index';

// Socket message definitions
export { SocketMessage } from './types/index';
export type { SocketMessageDefinition, SocketMessageConfig } from './types/index';

// Consumer interfaces
export type { IEventConsumer, IWorkflowConsumer } from './types/index';

// Utility types for type extraction
export type {
	Data,
	Result,
	MessageData,
	EventConsumer,
	EventCtx,
	WorkflowConsumer,
	WorkflowCtx
} from './types/index';

// Emitter interfaces (ctx.events, ctx.workflows, ctx.socket)
export type {
	EventEmitter,
	WorkflowExecutor,
	WorkflowExecuteOptions,
	WorkflowHandle,
	WorkflowStatus,
	SocketEmitter
} from './types/index';

// WebSocket types (for .websocket() and .onWebSocket() configuration)
export type { SocketData, WebSocketConnection, WebSocketHandlers, SocketMessageLike } from './types/index';

// Registration interfaces (fluent builder pattern)
export type { EventRegistration, WorkflowRegistration } from './application';

// Convenience alias
export type { RequestContext as Context } from './controllers/index';
