/**
 * Socket router types for type-safe WebSocket message handling.
 *
 * Socket routers handle WebSocket connections with a clear two-phase model:
 * 1. Connection: Guards run ONCE on WebSocket upgrade (authentication)
 * 2. Routing: Messages are routed to handlers with pre-authenticated state
 *
 * ## Design Philosophy
 *
 * After the connection handshake, it's just message routing:
 * - Connection guards authenticate once, set state that persists
 * - Messages route to handlers based on type
 * - Optional per-message guards for rate limiting, etc.
 *
 * ## Usage
 *
 * ```typescript
 * interface AuthState {
 *   user: UserWithAccountAndRoles;
 * }
 *
 * // TSocket generic gives you typed ctx.app.socket
 * class PresenceRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
 *   constructor(private presenceService: PresenceClientService) {}
 *
 *   configure(r: SocketRouteBuilder<AuthState, AppSocketEmitter>) {
 *     // Guard runs ONCE on connection (authenticates, sets state)
 *     r.connectionGuard(FirebaseAuthGuard);
 *
 *     // Route message types to handlers
 *     r.on('heartbeat', this.handleHeartbeat);
 *   }
 *
 *   // ctx.app.socket is typed as AppSocketEmitter automatically
 *   private handleHeartbeat = async (ctx) => {
 *     await this.presenceService.updatePresence(ctx.state.user);
 *     await ctx.app.socket.emitToAccount(...); // Typed!
 *     return { success: true };
 *   };
 * }
 * ```
 */

import type { Schema } from '@orijs/validation';
import type { Constructor } from './context';
import type { SocketEmitter } from './emitter';

/**
 * Forward declaration for AppContext socket access.
 * This avoids circular dependencies while maintaining type safety.
 */
export interface AppContextSocketLike<TSocket extends SocketEmitter = SocketEmitter> {
	readonly socket: TSocket;
}

/**
 * Forward declaration for SocketContext (defined in sockets/socket-context.ts).
 * This avoids circular dependencies while maintaining type safety.
 *
 * @typeParam TState - The state variables type
 * @typeParam TSocket - The socket emitter type for typed access to custom methods
 */
export interface SocketContextLike<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> {
	readonly state: TState;
	readonly app: AppContextSocketLike<TSocket>;
	/** The parsed message data */
	readonly data: unknown;
	/** The message type being handled */
	readonly messageType: string;
	/** Correlation ID for tracing */
	readonly correlationId: string;
	/** Socket ID of the connection */
	readonly socketId: string;
	set<K extends keyof TState>(key: K, value: TState[K]): void;
	get<K extends keyof TState>(key: K): TState[K];
}

/**
 * Guard interface for socket authentication/authorization.
 * Same pattern as HTTP guards - receives context, returns boolean.
 *
 * Guards can be used for:
 * - connectionGuard(): runs once on WebSocket upgrade
 * - guard(): runs per-message (optional, for rate limiting etc.)
 */
export interface SocketGuard {
	/**
	 * Determines if the connection/message should proceed.
	 * @param ctx - The socket context
	 * @returns `true` to allow, `false` to deny
	 */
	canActivate(ctx: SocketContextLike): boolean | Promise<boolean>;
}

/** Constructor type for SocketGuard classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SocketGuardClass = new (...args: any[]) => SocketGuard;

/**
 * Socket router interface that all socket routers must implement.
 *
 * @typeParam TState - The state variables type for this router's context.
 *   Connection guards set state via `ctx.set()`, handlers access via `ctx.state`.
 * @typeParam TSocket - The socket emitter type for typed access to custom methods.
 *   When specified, `ctx.app.socket` returns this type in handlers.
 */
export interface OriSocketRouter<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> {
	/**
	 * Configures message routes for this socket router using the SocketRouteBuilder.
	 * @param route - The socket route builder instance
	 */
	configure(route: SocketRouteBuilder<TState, TSocket>): void;
}

/** Constructor type for SocketRouter classes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SocketRouterClass = new (...args: any[]) => OriSocketRouter<any, any>;

/**
 * Handler function type for socket messages.
 * Returns data that will be automatically serialized and sent back.
 *
 * The context parameter is typed as `any` to allow users to declare their
 * handler parameter type explicitly (e.g., `ctx: SocketContext<AuthState>`).
 * TypeScript infers the response type from the handler's return value.
 *
 * @typeParam TState - The state variables type (for documentation)
 * @typeParam TSocket - The socket emitter type (for documentation)
 * @typeParam TResponse - The response data type (auto-serialized to JSON)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SocketHandler<
	_TState extends object = Record<string, unknown>,
	_TSocket extends SocketEmitter = SocketEmitter,
	TResponse = unknown
> = (ctx: any) => TResponse | Promise<TResponse>;

/**
 * Internal socket route definition after building.
 */
export interface SocketRouteDefinition {
	/** Message type to match (e.g., 'heartbeat', 'subscribe') */
	messageType: string;
	/** Handler function */
	handler: SocketHandler;
	/** Guards to run before this handler */
	guards: SocketGuardClass[];
	/** Schema for message data validation */
	schema?: Schema;
}

/**
 * Fluent API for defining socket routes within a router.
 *
 * @typeParam TState - The state variables type for this builder's handlers.
 * @typeParam TSocket - The socket emitter type for typed ctx.app.socket access.
 *
 * @example
 * ```ts
 * interface AuthState { user: User }
 *
 * class MySocketRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
 *   configure(r: SocketRouteBuilder<AuthState, AppSocketEmitter>) {
 *     // Connection guard (runs ONCE on upgrade)
 *     r.connectionGuard(AuthGuard);
 *
 *     // Message handlers - ctx.app.socket is typed as AppSocketEmitter
 *     r.on('heartbeat', this.handleHeartbeat);
 *   }
 * }
 * ```
 */
export interface SocketRouteBuilder<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> {
	/**
	 * Adds a connection guard (runs ONCE on WebSocket upgrade).
	 * Connection guards determine if the client can connect at all.
	 * They set state that persists for the entire connection.
	 *
	 * @param guard - The guard class to add
	 */
	connectionGuard(guard: SocketGuardClass): SocketRouteBuilder<TState, TSocket>;

	/**
	 * Adds a guard to the router or current route.
	 * These guards run on each message (optional, for rate limiting etc.).
	 *
	 * When called before any route method, applies to all routes in the router.
	 * When called after a route method, applies only to that route.
	 *
	 * @param guard - Guard class to add
	 */
	guard(guard: SocketGuardClass): SocketRouteBuilder<TState, TSocket>;

	/**
	 * Replaces all message guards for the current route or router.
	 * Does NOT affect connection guards.
	 *
	 * @param guards - The guard classes to use
	 */
	guards(guards: SocketGuardClass[]): SocketRouteBuilder<TState, TSocket>;

	/**
	 * Clears all message guards (NOT connection guards).
	 */
	clearGuards(): SocketRouteBuilder<TState, TSocket>;

	/**
	 * Registers a message handler for a specific message type.
	 *
	 * @param messageType - The message type to handle (e.g., 'heartbeat', 'subscribe')
	 * @param handler - Handler function that receives SocketContext and returns response data
	 * @param schema - Optional TypeBox schema for message data validation
	 */
	on<TResponse = unknown>(
		messageType: string,
		handler: SocketHandler<TState, TSocket, TResponse>,
		schema?: Schema
	): SocketRouteBuilder<TState, TSocket>;

	/**
	 * Returns all registered connection guards (internal use).
	 */
	getConnectionGuards(): readonly SocketGuardClass[];

	/**
	 * Returns all registered routes (internal use).
	 */
	getRoutes(): readonly SocketRouteDefinition[];
}

/**
 * Configuration for registering a socket router.
 */
export interface SocketRouterConfig {
	/** The socket router class */
	router: SocketRouterClass;
	/** Dependencies to inject into the router */
	deps: Constructor[];
}

/**
 * Incoming WebSocket message format.
 * Messages must include a type field for routing.
 */
export interface SocketMessage<TData = unknown> {
	/** Message type for routing (e.g., 'heartbeat', 'subscribe') */
	type: string;
	/** Optional message data */
	data?: TData;
	/** Optional correlation ID for request-response matching */
	correlationId?: string;
}

/**
 * Outgoing WebSocket response format.
 * Responses include the original type and data.
 */
export interface SocketResponse<TData = unknown> {
	/** Original message type */
	type: string;
	/** Response data */
	data: TData;
	/** Correlation ID if provided in request */
	correlationId?: string;
	/** Error details if handler failed */
	error?: string;
}

/**
 * Shorthand type for socket handler context.
 * Use this when typing handler parameters instead of the full SocketContext<TState, unknown, TSocket>.
 *
 * @typeParam TState - The state variables type (from connection guards)
 * @typeParam TSocket - The socket emitter type for typed ctx.app.socket access
 *
 * @example
 * ```ts
 * class MyRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
 *   private handleMessage = async (ctx: SocketCtx<AuthState, AppSocketEmitter>) => {
 *     ctx.state.user;           // Typed as AuthState['user']
 *     ctx.app.socket.customFn(); // Typed as AppSocketEmitter
 *   };
 * }
 * ```
 */
export type SocketCtx<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> = SocketContextLike<TState, TSocket>;
