// Context classes
import type { RequestContext as _RequestContext } from '../controllers/request-context.ts';
import type { SocketEmitter } from './emitter';
export type { _RequestContext as RequestContext };
/**
 * Request context type for handlers.
 * Shorthand that skips the TSocket generic (defaults to SocketEmitter).
 */
export type Context<
	TState extends object = Record<string, unknown>,
	TParams extends Record<string, string> = Record<string, string>
> = _RequestContext<TState, SocketEmitter, TParams>;
export type { AppContext } from '../app-context.ts';

// Context types
export type {
	Handler,
	HandlerInput,
	LifecycleHook,
	LifecyclePhase,
	Constructor,
	ConstructorDeps,
	InjectionToken
} from './context';

// EventSystem (from events module)
export type { EventSystem } from '@orijs/events';

// Middleware (guards, interceptors, pipes)
export type {
	Guard,
	GuardClass,
	Interceptor,
	InterceptorClass,
	Pipe,
	PipeMetadata,
	PipeClass
} from './middleware';

// Controllers and routing
export type {
	OriController,
	ControllerClass,
	RouteDefinition,
	RouteBuilder,
	RouteSchemaOptions,
	ContextHandler,
	ContextHandlerInput
} from './controller';

// Param validators
export type { ParamValidator, ParamValidatorClass } from '../controllers/param-validators';

// HTTP
export type { HttpMethod } from './http';

// Logging
export type {
	LogObject,
	Transport,
	LoggerOptions,
	LoggerGlobalOptions,
	LevelName,
	LevelNumber
} from './logging';

// Workflow definitions
export { Workflow, isWorkflowDefinition, hasSteps } from './workflow-definition';
export type {
	WorkflowDefinition,
	WorkflowConfig,
	WorkflowContext,
	StepContext,
	StepDefinition,
	StepGroup
} from './workflow-definition';

// Event definitions
export { Event } from './event-definition';
export type { EventDefinition, EventConfig, EventContext } from './event-definition';

// Socket message definitions
export { SocketMessage } from './socket-message-definition';
export type { SocketMessageDefinition, SocketMessageConfig } from './socket-message-definition';

// Consumer interfaces
export type { IEventConsumer, IWorkflowConsumer, StepHandler } from './consumer';

// Utility types for type extraction
// Note: Context alias from utility.ts is NOT exported here (conflicts with RequestContext alias)
// Use EventCtx instead of Context for event context types
export type {
	Data,
	Result,
	MessageData,
	EventConsumer,
	EventCtx,
	WorkflowConsumer,
	WorkflowCtx
} from './utility';

// Emitter interfaces (ctx.events, ctx.workflows, ctx.socket)
export type {
	EventEmitter,
	WorkflowExecutor,
	WorkflowExecuteOptions,
	WorkflowHandle,
	WorkflowStatus,
	SocketEmitter
} from './emitter';

// WebSocket types (for .websocket() and .onWebSocket() configuration)
export type { SocketData, WebSocketConnection, WebSocketHandlers, SocketMessageLike } from '@orijs/websocket';

// Application types
export type {
	ControllerConfig,
	ProviderConfig,
	ProviderOptions,
	AppLoggerOptions,
	CorsConfig
} from './application';

// Socket router types
export type {
	SocketContextLike,
	SocketGuard,
	SocketGuardClass,
	OriSocketRouter,
	SocketRouterClass,
	SocketHandler,
	SocketRouteDefinition,
	SocketRouteBuilder,
	SocketRouterConfig,
	SocketMessage as SocketMessageFormat,
	SocketResponse,
	SocketCtx
} from './socket-router';
