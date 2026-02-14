/**
 * @orijs/core - Core framework package for OriJS
 *
 * This package provides the foundation for building applications with OriJS:
 * - Application builder with fluent API
 * - Dependency injection container
 * - HTTP routing and controllers
 * - WebSocket support
 * - Event and workflow coordination
 * - Lifecycle management
 *
 * @example Basic usage
 * ```typescript
 * import { Ori, Type, Params } from '@orijs/orijs';
 * import type { OriController, RouteBuilder } from '@orijs/orijs';
 *
 * class ApiController implements OriController {
 *   configure(r: RouteBuilder) {
 *     r.get('/health', () => Response.json({ status: 'ok' }));
 *   }
 * }
 *
 * Ori.create()
 *   .controller('/api', ApiController)
 *   .listen(3000);
 * ```
 *
 * @packageDocumentation
 */

/**
 * Core application exports.
 * - `Ori` / `Application` - Static factory and application class
 * - `Container` - Dependency injection container
 * - `AppContext` - Application-level context for lifecycle hooks
 */
export { Ori, OriApplication, Application } from './application';
export type { ApplicationOptions } from './application';
export { Container } from './container';
export { FrameworkError, throwFrameworkError, isDebugMode } from './framework-error';
export { AppContext } from './app-context';
export type { BaseContext } from './base-context';
export { parseQuery } from './utils/query';

/**
 * Token utilities for creating typed injection tokens.
 * Use these when you need multiple instances of the same type.
 *
 * @example
 * ```typescript
 * import { createToken } from '@orijs/core';
 *
 * const HotCache = createToken<CacheService>('HotCache');
 * const ColdCache = createToken<CacheService>('ColdCache');
 *
 * Ori.create()
 *   .providerInstance(HotCache, new CacheService({ ttl: '1m' }))
 *   .providerInstance(ColdCache, new CacheService({ ttl: '1h' }));
 * ```
 */
export { createToken, isToken } from './token';
export type { Token } from './token';

/**
 * Internal coordinators - exposed for testing and framework extension.
 * These manage the internal coordination of routing, events, workflows, etc.
 *
 * @internal Most users should not need to use these directly.
 */
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

/**
 * Controller and HTTP routing exports.
 * - `RouteBuilder` - Fluent API for defining routes in controllers
 * - `RequestContext` - Per-request context with params, query, body, state
 * - `ResponseFactory` - Helper for creating HTTP responses
 */
export {
	RouteBuilder,
	RequestContext,
	RequestContextFactory,
	ResponseFactory,
	responseFactory,
	OriResponse,
	UuidParam,
	StringParam,
	NumberParam
} from './controllers/index';

/**
 * WebSocket routing exports.
 * - `SocketContext` - Per-message context for socket handlers
 * - `SocketRouteBuilder` - Fluent API for defining socket routes
 */
export { SocketContext, SocketContextFactory, SocketRouteBuilder, SocketPipeline } from './sockets/index';

/**
 * Core type definitions for controllers, guards, interceptors, and middleware.
 */
export type {
	Handler,
	Guard,
	GuardClass,
	Interceptor,
	InterceptorClass,
	Pipe,
	PipeClass,
	PipeMetadata,
	ParamValidator,
	ParamValidatorClass,
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

/**
 * Workflow and Event definition builders.
 * Use these to define type-safe workflows and events.
 *
 * @example Event definition
 * ```typescript
 * const UserCreated = Event.define({
 *   name: 'user.created',
 *   data: Type.Object({ userId: Type.String() })
 * });
 * ```
 *
 * @example Workflow definition
 * ```typescript
 * const OrderProcessing = Workflow.define({
 *   name: 'order-processing',
 *   data: Type.Object({ orderId: Type.String() }),
 *   result: Type.Object({ status: Type.String() })
 * });
 * ```
 */
export { Workflow, isWorkflowDefinition } from './types/index';
export type { WorkflowDefinition, WorkflowConfig, WorkflowContext, StepContext } from './types/index';
export { Event } from './types/index';
export type { EventDefinition, EventConfig, EventContext } from './types/index';

/**
 * Socket message definition builder.
 * Use this to define type-safe WebSocket messages.
 */
export { SocketMessage } from './types/index';
export type { SocketMessageDefinition, SocketMessageConfig } from './types/index';

/**
 * Consumer interfaces for implementing event and workflow handlers.
 */
export type { IEventConsumer, IWorkflowConsumer } from './types/index';

/**
 * Utility types for extracting data and result types from definitions.
 * Use these to get type-safe access to definition payloads.
 *
 * @example
 * ```typescript
 * import type { Data, Result, EventCtx } from '@orijs/core';
 *
 * type UserData = Data<typeof UserCreated>;  // { userId: string }
 * type OrderResult = Result<typeof OrderProcessing>;  // { status: string }
 *
 * // Use EventCtx for typed event handlers
 * const handler = async (ctx: EventCtx<typeof UserCreated>) => {
 *   ctx.data.userId;  // Type-safe access
 * };
 * ```
 */
export type {
	Data,
	Result,
	MessageData,
	EventConsumer,
	EventCtx,
	WorkflowConsumer,
	WorkflowCtx
} from './types/index';

/**
 * Emitter interfaces available on request/socket context.
 * - `EventEmitter` - ctx.events interface
 * - `WorkflowExecutor` - ctx.workflows interface
 * - `SocketEmitter` - ctx.socket interface
 */
export type {
	EventEmitter,
	WorkflowExecutor,
	WorkflowExecuteOptions,
	WorkflowHandle,
	WorkflowStatus,
	SocketEmitter
} from './types/index';

/**
 * WebSocket connection types for .websocket() and .onWebSocket() configuration.
 */
export type { SocketData, WebSocketConnection, WebSocketHandlers, SocketMessageLike } from './types/index';

/**
 * Registration interfaces returned by .event() and .workflow() for fluent configuration.
 */
export type { EventRegistration, WorkflowRegistration } from './application';

/**
 * Convenience alias - Context<TState, TParams> maps to RequestContext with default TSocket.
 */
export type { Context } from './types/index';
