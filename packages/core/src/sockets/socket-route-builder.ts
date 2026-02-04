import type {
	SocketRouteBuilder as ISocketRouteBuilder,
	SocketRouteDefinition,
	SocketHandler,
	SocketGuardClass
} from '../types/socket-router';
import type { SocketEmitter } from '../types/emitter';
import type { Schema } from '@orijs/validation';

/**
 * Fluent API for defining socket routes within a router.
 *
 * Supports connection guards (run ONCE on upgrade) and message guards
 * (run per message) at both router level and individual route level.
 *
 * @typeParam TState - The state variables type for this builder's handlers.
 * @typeParam TSocket - The socket emitter type for typed ctx.app.socket access.
 *
 * @example
 * ```ts
 * class MySocketRouter implements OriSocketRouter<AuthState, AppSocketEmitter> {
 *   configure(r: SocketRouteBuilder<AuthState, AppSocketEmitter>) {
 *     // Connection guard - runs ONCE on WebSocket upgrade
 *     r.connectionGuard(AuthGuard);
 *
 *     // Message handlers - ctx.app.socket is typed as AppSocketEmitter
 *     r.on('heartbeat', this.handleHeartbeat);
 *   }
 * }
 * ```
 */
export class SocketRouteBuilder<
	TState extends object = Record<string, unknown>,
	TSocket extends SocketEmitter = SocketEmitter
> implements ISocketRouteBuilder<TState, TSocket> {
	private routes: SocketRouteDefinition[] = [];
	private connectionGuards: SocketGuardClass[] = [];
	private routerGuards: SocketGuardClass[] = [];
	private currentRoute: SocketRouteDefinition | null = null;
	private routeGuardsOverride: SocketGuardClass[] | null = null;

	/**
	 * Creates a new SocketRouteBuilder.
	 * @param inheritedGuards - Guards inherited from global application level
	 */
	constructor(private inheritedGuards: SocketGuardClass[] = []) {}

	/**
	 * Adds a connection guard (runs once on WebSocket upgrade).
	 * Connection guards determine if the client can connect at all.
	 * They set state that persists for the entire connection.
	 *
	 * @param guard - The guard class to add
	 * @returns this for method chaining
	 */
	public connectionGuard(guard: SocketGuardClass): this {
		this.connectionGuards.push(guard);
		return this;
	}

	/**
	 * Adds a message guard to the router or current route.
	 * Message guards run on each incoming message.
	 *
	 * When called before any route method, applies to all routes.
	 * When called after a route method, applies only to that route.
	 *
	 * @param guard - Guard class to add
	 * @returns this for method chaining
	 */
	public guard(guard: SocketGuardClass): this {
		if (this.currentRoute) {
			if (!this.routeGuardsOverride) {
				this.routeGuardsOverride = [...this.getEffectiveGuards()];
			}
			this.routeGuardsOverride.push(guard);
			this.currentRoute.guards = this.routeGuardsOverride;
		} else {
			this.routerGuards.push(guard);
		}
		return this;
	}

	/**
	 * Replaces all message guards with the provided array.
	 * Does NOT affect connection guards.
	 *
	 * @param guards - Array of guard classes to use
	 * @returns this for method chaining
	 */
	public guards(guards: SocketGuardClass[]): this {
		if (this.currentRoute) {
			this.routeGuardsOverride = guards;
			this.currentRoute.guards = guards;
		} else {
			this.routerGuards = guards;
			this.inheritedGuards = [];
		}
		return this;
	}

	/**
	 * Clears all message guards (inherited and controller-level).
	 * Does NOT affect connection guards.
	 *
	 * @returns this for method chaining
	 */
	public clearGuards(): this {
		if (this.currentRoute) {
			this.routeGuardsOverride = [];
			this.currentRoute.guards = [];
		} else {
			this.routerGuards = [];
			this.inheritedGuards = [];
		}
		return this;
	}

	/**
	 * Registers a message handler for a specific message type.
	 *
	 * @param messageType - The message type to handle (e.g., 'heartbeat', 'subscribe')
	 * @param handler - Handler function that receives SocketContext and returns response data
	 * @param schema - Optional TypeBox schema for message data validation
	 * @returns this for method chaining
	 */
	public on<TResponse = unknown>(
		messageType: string,
		handler: SocketHandler<TState, TSocket, TResponse>,
		schema?: Schema
	): this {
		this.currentRoute = {
			messageType,
			handler: handler as SocketHandler,
			guards: this.getEffectiveGuards(),
			schema
		};
		this.routeGuardsOverride = null;
		this.routes.push(this.currentRoute);
		return this;
	}

	/**
	 * Returns all registered connection guards.
	 */
	public getConnectionGuards(): readonly SocketGuardClass[] {
		return Object.freeze([...this.connectionGuards]);
	}

	/**
	 * Returns all registered routes.
	 * Finalizes any pending route configuration.
	 */
	public getRoutes(): readonly SocketRouteDefinition[] {
		this.currentRoute = null;
		return Object.freeze([...this.routes]);
	}

	private getEffectiveGuards(): SocketGuardClass[] {
		return [...this.inheritedGuards, ...this.routerGuards];
	}
}
