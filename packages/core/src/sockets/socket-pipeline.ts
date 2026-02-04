import type { Container } from '../container.ts';
import type { Logger, LoggerOptions } from '@orijs/logging';
import type { AppContext } from '../app-context.ts';
import type { WebSocketConnection } from '@orijs/websocket';
import type { SocketEmitter } from '../types/emitter.ts';
import type {
	SocketGuard,
	SocketGuardClass,
	SocketRouteDefinition,
	SocketHandler,
	SocketResponse
} from '../types/socket-router';
import { SocketContext, SocketContextFactory } from './socket-context';
import { validate, type ValidationError, type Schema } from '@orijs/validation';
import { runWithContext, createTraceContext } from '@orijs/logging';

/**
 * Compiled socket route with handler and guards.
 */
export interface CompiledSocketRoute {
	/** Message type to match */
	messageType: string;
	/** Handler function */
	handler: SocketHandler;
	/** Pre-resolved guard instances */
	guards: SocketGuard[];
	/** Validation schema for message data */
	schema?: Schema;
}

/**
 * Handles the socket message processing pipeline: guards, validation, and handler execution.
 * Extracted from Application to follow Single Responsibility Principle.
 *
 * Similar to RequestPipeline but for WebSocket messages.
 *
 * @typeParam TSocket - The socket emitter type for typed access to custom methods.
 */
export class SocketPipeline<TSocket extends SocketEmitter = SocketEmitter> {
	private readonly contextFactory: SocketContextFactory<TSocket>;

	constructor(
		private readonly container: Container,
		appContext: AppContext<TSocket>,
		private readonly appLogger: Logger,
		loggerOptions: LoggerOptions
	) {
		this.contextFactory = new SocketContextFactory<TSocket>(appContext, loggerOptions);
	}

	/**
	 * Compiles a socket route by pre-resolving guards.
	 * Guards are resolved once at registration time, not per-message.
	 */
	public compileRoute(route: SocketRouteDefinition): CompiledSocketRoute {
		const guards = route.guards.map((G) => this.container.resolve(G));
		return {
			messageType: route.messageType,
			handler: route.handler,
			guards,
			schema: route.schema
		};
	}

	/**
	 * Runs connection guards when a WebSocket connection is established.
	 * Returns the context if all guards pass, null if any guard rejects.
	 *
	 * @param ws - The WebSocket connection
	 * @param connectionGuards - Guard classes to run on connection
	 * @returns SocketContext with state if guards pass, null if rejected
	 */
	public async runConnectionGuards<TData>(
		ws: WebSocketConnection<TData>,
		connectionGuards: SocketGuardClass[]
	): Promise<SocketContext<Record<string, unknown>, TData, TSocket> | null> {
		const correlationId = crypto.randomUUID();

		// Create context for connection guards
		const ctx = this.contextFactory.create(ws, '__connection__', {}, correlationId);

		// Pre-resolve guards
		const guards = connectionGuards.map((G) => this.container.resolve(G));

		// Run guards
		for (const guard of guards) {
			try {
				const canActivate = await guard.canActivate(ctx);
				if (!canActivate) {
					this.appLogger.debug('Connection guard rejected', {
						socketId: ws.data.socketId,
						guard: guard.constructor.name
					});
					return null;
				}
			} catch (error) {
				this.appLogger.error('Connection guard error', {
					socketId: ws.data.socketId,
					guard: guard.constructor.name,
					error: error instanceof Error ? error.message : String(error)
				});
				return null;
			}
		}

		return ctx;
	}

	/**
	 * Handles an incoming socket message.
	 * Runs guards, validates data, executes handler, and sends response.
	 *
	 * @param ws - The WebSocket connection
	 * @param route - The compiled route to execute
	 * @param messageType - The message type
	 * @param messageData - The message data
	 * @param correlationId - Optional correlation ID from the message
	 * @param connectionState - State from connection guards (persists across messages)
	 */
	public async handleMessage<TData>(
		ws: WebSocketConnection<TData>,
		route: CompiledSocketRoute,
		messageType: string,
		messageData: unknown,
		correlationId: string | undefined,
		connectionState: Record<string, unknown>
	): Promise<void> {
		const requestCorrelationId = correlationId ?? crypto.randomUUID();
		const trace = createTraceContext();

		await runWithContext({ log: this.appLogger, correlationId: requestCorrelationId, trace }, async () => {
			try {
				// Create context for this message
				const ctx = this.contextFactory.create(ws, messageType, messageData, requestCorrelationId);

				// Copy connection state to message context
				for (const [key, value] of Object.entries(connectionState)) {
					ctx.set(key as keyof typeof ctx.state, value as (typeof ctx.state)[keyof typeof ctx.state]);
				}

				// Run message guards
				for (const guard of route.guards) {
					const canActivate = await guard.canActivate(ctx);
					if (!canActivate) {
						this.sendError(ws, messageType, 'Forbidden', requestCorrelationId);
						return;
					}
				}

				// Validate message data if schema provided
				if (route.schema) {
					const validationResult = await validate(route.schema, messageData);
					if (!validationResult.success) {
						const errors = validationResult.errors.map((e: ValidationError) => e.message).join(', ');
						this.sendError(ws, messageType, `Validation failed: ${errors}`, requestCorrelationId);
						return;
					}
				}

				// Execute handler
				const result = await route.handler(ctx);

				// Send response
				this.sendResponse(ws, messageType, result, requestCorrelationId);
			} catch (error) {
				this.appLogger.error('Socket handler error', {
					correlationId: requestCorrelationId,
					messageType,
					socketId: ws.data.socketId,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
				this.sendError(
					ws,
					messageType,
					error instanceof Error ? error.message : 'Internal error',
					requestCorrelationId
				);
			}
		});
	}

	/**
	 * Sends a success response to the client.
	 */
	private sendResponse<TData>(
		ws: WebSocketConnection<TData>,
		messageType: string,
		data: unknown,
		correlationId?: string
	): void {
		const response: SocketResponse = {
			type: messageType,
			data
		};
		if (correlationId) {
			response.correlationId = correlationId;
		}
		ws.send(JSON.stringify(response));
	}

	/**
	 * Sends an error response to the client.
	 */
	private sendError<TData>(
		ws: WebSocketConnection<TData>,
		messageType: string,
		error: string,
		correlationId?: string
	): void {
		const response: SocketResponse = {
			type: messageType,
			data: null,
			error
		};
		if (correlationId) {
			response.correlationId = correlationId;
		}
		ws.send(JSON.stringify(response));
	}
}
