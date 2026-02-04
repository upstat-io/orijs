import type { Container } from '../container.ts';
import type { Logger, LoggerOptions } from '@orijs/logging';
import type { AppContext } from '../app-context.ts';
import type { WebSocketConnection } from '@orijs/websocket';
import type { SocketEmitter } from '../types/emitter.ts';
import type { SocketRouterConfig, SocketGuardClass, OriSocketRouter } from '../types/socket-router';
import { SocketRouteBuilder } from './socket-route-builder';
import { SocketPipeline, type CompiledSocketRoute } from './socket-pipeline';

/**
 * Connection state stored per WebSocket connection.
 * Holds state set by connection guards that persists across messages.
 */
interface ConnectionState {
	/** State variables set by guards */
	state: Record<string, unknown>;
	/** Connection guards have been run */
	initialized: boolean;
}

/**
 * Manages socket router registration, route compilation, and message routing.
 *
 * Responsibilities:
 * - Register socket routers via .socketRouter()
 * - Compile routes from all routers into a lookup map
 * - Route incoming messages to the correct handler
 * - Manage connection state (from connection guards)
 *
 * @typeParam TSocket - The socket emitter type for typed access to custom methods.
 */
export class SocketRoutingCoordinator<TSocket extends SocketEmitter = SocketEmitter> {
	private readonly routerConfigs: SocketRouterConfig[] = [];
	private readonly compiledRoutes = new Map<string, CompiledSocketRoute>();
	private readonly connectionStates = new Map<string, ConnectionState>();
	private connectionGuards: SocketGuardClass[] = [];
	private pipeline: SocketPipeline<TSocket> | null = null;

	constructor(
		private readonly container: Container,
		private readonly appLogger: Logger
	) {}

	/**
	 * Adds a socket router configuration.
	 */
	public addRouter(config: SocketRouterConfig): void {
		this.routerConfigs.push(config);
	}

	/**
	 * Registers routers with the DI container and compiles routes.
	 * Called during bootstrap.
	 */
	public registerRouters(): void {
		for (const config of this.routerConfigs) {
			// Register router with container
			// Type assertion needed because SocketRouterClass has dynamic constructor signature
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.container.register as (service: any, deps: any) => void)(config.router, config.deps);

			// Resolve router instance
			const router = this.container.resolve<OriSocketRouter>(config.router);

			// Build routes
			const builder = new SocketRouteBuilder();
			router.configure(builder);

			// Collect connection guards
			const routerConnectionGuards = builder.getConnectionGuards();
			this.connectionGuards.push(...routerConnectionGuards);

			// Compile routes
			const routes = builder.getRoutes();
			this.appLogger.debug('Registering socket router', {
				router: config.router.name,
				routes: routes.length,
				connectionGuards: routerConnectionGuards.length
			});

			for (const route of routes) {
				if (this.compiledRoutes.has(route.messageType)) {
					throw new Error(
						`Duplicate socket message type: '${route.messageType}' is already registered. ` +
							`Each message type can only have one handler.`
					);
				}

				if (this.pipeline) {
					this.compiledRoutes.set(route.messageType, this.pipeline.compileRoute(route));
				}
			}
		}
	}

	/**
	 * Initializes the pipeline and compiles all routes.
	 * Must be called after container is ready.
	 */
	public initialize(appContext: AppContext<TSocket>, loggerOptions: LoggerOptions): void {
		this.pipeline = new SocketPipeline<TSocket>(this.container, appContext, this.appLogger, loggerOptions);

		// Re-compile routes now that pipeline is ready
		for (const config of this.routerConfigs) {
			const router = this.container.resolve<OriSocketRouter>(config.router);
			const builder = new SocketRouteBuilder();
			router.configure(builder);

			// Auto-register connection guards
			for (const guard of builder.getConnectionGuards()) {
				this.registerGuardIfMissing(guard);
			}

			const routes = builder.getRoutes();
			for (const route of routes) {
				// Auto-register message guards
				for (const guard of route.guards) {
					this.registerGuardIfMissing(guard);
				}
				this.compiledRoutes.set(route.messageType, this.pipeline.compileRoute(route));
			}
		}
	}

	/**
	 * Auto-registers a guard with the container if not already registered.
	 * Guards are treated as having no constructor dependencies.
	 */
	private registerGuardIfMissing(guard: SocketGuardClass): void {
		if (!this.container.has(guard)) {
			// Guards have no constructor deps by convention
			this.container.register(guard as new () => unknown);
		}
	}

	/**
	 * Handles a new WebSocket connection.
	 * Runs connection guards and initializes connection state.
	 *
	 * @returns true if connection is allowed, false if rejected
	 */
	public async handleConnection<TData>(ws: WebSocketConnection<TData>): Promise<boolean> {
		if (!this.pipeline) {
			this.appLogger.error('Socket pipeline not initialized');
			return false;
		}

		// Run connection guards
		const ctx = await this.pipeline.runConnectionGuards(ws, this.connectionGuards);
		if (!ctx) {
			return false;
		}

		// Store connection state
		this.connectionStates.set(ws.data.socketId, {
			state: ctx.state as Record<string, unknown>,
			initialized: true
		});

		return true;
	}

	/**
	 * Handles an incoming WebSocket message.
	 * Routes to the appropriate handler based on message type.
	 *
	 * @param ws - The WebSocket connection
	 * @param messageType - The message type
	 * @param messageData - The message data
	 * @param correlationId - Optional correlation ID
	 * @returns true if message was handled, false if no handler found
	 */
	public async handleMessage<TData>(
		ws: WebSocketConnection<TData>,
		messageType: string,
		messageData: unknown,
		correlationId?: string
	): Promise<boolean> {
		if (!this.pipeline) {
			this.appLogger.error('Socket pipeline not initialized');
			return false;
		}

		// Find route
		const route = this.compiledRoutes.get(messageType);
		if (!route) {
			return false; // No handler - let fallback handle it
		}

		// Get connection state
		const connectionState = this.connectionStates.get(ws.data.socketId);
		if (!connectionState?.initialized) {
			this.appLogger.warn('Message received before connection initialized', {
				socketId: ws.data.socketId,
				messageType
			});
			ws.send(JSON.stringify({ type: messageType, error: 'Connection not initialized' }));
			return true;
		}

		// Handle message
		await this.pipeline.handleMessage(
			ws,
			route,
			messageType,
			messageData,
			correlationId,
			connectionState.state
		);
		return true;
	}

	/**
	 * Handles WebSocket connection close.
	 * Cleans up connection state.
	 */
	public handleDisconnection(socketId: string): void {
		this.connectionStates.delete(socketId);
	}

	/**
	 * Returns all registered message types for debugging.
	 */
	public getRegisteredMessageTypes(): string[] {
		return Array.from(this.compiledRoutes.keys());
	}

	/**
	 * Returns true if there are any socket routers registered.
	 */
	public hasRouters(): boolean {
		return this.routerConfigs.length > 0;
	}
}
