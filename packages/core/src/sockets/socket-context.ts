import type { AppContext } from '../app-context.ts';
import type { BaseContext } from '../base-context.ts';
import { Logger, setMeta as setContextMeta, type LoggerOptions } from '@orijs/logging';
import { Json } from '@orijs/validation';
import type { EventEmitter, WorkflowExecutor, SocketEmitter } from '../types/emitter.ts';
import type { WebSocketConnection } from '@orijs/websocket';
import {
	RequestBoundEventEmitter,
	RequestBoundWorkflowExecutor,
	RequestBoundSocketEmitter
} from '../controllers/request-bound-emitters';

/**
 * Factory for creating socket contexts.
 * Encapsulates shared configuration (app context, logger options).
 *
 * @typeParam TSocket - The socket emitter type for typed access to custom methods.
 */
export class SocketContextFactory<TSocket extends SocketEmitter = SocketEmitter> {
	constructor(
		private readonly app: AppContext<TSocket>,
		private readonly loggerOptions: LoggerOptions
	) {}

	/**
	 * Create a new socket context for a WebSocket connection.
	 */
	public create<TData = unknown>(
		ws: WebSocketConnection<TData>,
		messageType: string,
		messageData: unknown,
		correlationId?: string
	): SocketContext<Record<string, unknown>, TData, TSocket> {
		return new SocketContext<Record<string, unknown>, TData, TSocket>(
			this.app,
			ws,
			messageType,
			messageData,
			correlationId ?? crypto.randomUUID(),
			this.loggerOptions
		);
	}
}

/**
 * Socket-scoped context passed to handlers and guards.
 * Created for each WebSocket message.
 *
 * Context variables (state) follow the same pattern as HTTP:
 * - Guards set values via `ctx.set('user', payload)`
 * - Handlers access via `ctx.state.user` or `ctx.get('user')`
 *
 * @typeParam TState - The shape of state variables. Declared at the controller
 *   level to provide type-safe access via `ctx.state`.
 *
 * @typeParam TData - The type of user data attached during WebSocket upgrade.
 *
 * @typeParam TSocket - The socket emitter type for typed access to custom methods.
 *
 * @example
 * ```ts
 * // Guard sets state
 * class AuthGuard implements SocketGuard {
 *   async canActivate(ctx: SocketContext): Promise<boolean> {
 *     ctx.set('user', { id: '123', name: 'Alice' });
 *     return true;
 *   }
 * }
 *
 * // Handler accesses typed state
 * interface AuthState { user: { id: string; name: string } }
 *
 * class MySocketRouter implements OriSocketRouter<AuthState> {
 *   configure(r: SocketRouteBuilder<AuthState>) {
 *     r.connectionGuard(AuthGuard);  // Runs ONCE on connect
 *     r.on('heartbeat', this.handleHeartbeat);
 *   }
 *
 *   private handleHeartbeat = (ctx: SocketContext<AuthState>) => {
 *     return { userId: ctx.state.user.id }; // Fully typed!
 *   };
 * }
 * ```
 */
export class SocketContext<
	TState extends object = Record<string, unknown>,
	TData = unknown,
	TSocket extends SocketEmitter = SocketEmitter
> implements BaseContext {
	private stateData: TState | null = null;

	// Cached lazy values
	private cachedLogger: Logger | null = null;
	private cachedEvents: EventEmitter | null = null;
	private cachedWorkflows: WorkflowExecutor | null = null;
	private cachedSocket: SocketEmitter | null = null;

	/**
	 * Access state variables set by guards.
	 * Lazily initialized on first access.
	 */
	get state(): TState {
		if (this.stateData === null) {
			this.stateData = {} as TState;
		}
		return this.stateData;
	}

	/**
	 * Set a state variable. Typically called by guards.
	 * Only keys defined in TState can be set, with type-safe values.
	 */
	public set<K extends keyof TState>(key: K, value: TState[K]): void {
		if (this.stateData === null) {
			this.stateData = {} as TState;
		}
		(this.stateData as Record<string, unknown>)[key as string] = value;
	}

	/**
	 * Get a state variable by key.
	 */
	public get<K extends keyof TState>(key: K): TState[K] {
		return this.state[key];
	}

	constructor(
		/** Application context with shared services (typed with socket emitter) */
		readonly app: AppContext<TSocket>,
		/** The WebSocket connection */
		readonly ws: WebSocketConnection<TData>,
		/** The message type being handled */
		readonly messageType: string,
		/** The parsed message data */
		readonly data: unknown,
		/** Correlation ID for tracing */
		readonly correlationId: string,
		private readonly loggerOptions: LoggerOptions
	) {}

	/**
	 * Get the WebSocket connection's socket ID.
	 */
	get socketId(): string {
		return this.ws.data.socketId;
	}

	/**
	 * Get the user data attached during WebSocket upgrade.
	 */
	get userData(): TData {
		return this.ws.data.data;
	}

	get log(): Logger {
		if (this.cachedLogger === null) {
			const logger = new Logger('Socket', this.loggerOptions).with({
				correlationId: this.correlationId,
				socketId: this.socketId,
				messageType: this.messageType
			});
			// Wire up callback so Logger.setMeta() updates AsyncLocalStorage
			logger.onSetMeta(setContextMeta);
			this.cachedLogger = logger;
		}
		return this.cachedLogger;
	}

	/**
	 * Event emitter for type-safe event emission.
	 * Automatically binds events to this socket context for correlation.
	 */
	get events(): EventEmitter {
		if (this.cachedEvents === null) {
			const coordinator = this.app.eventCoordinator;
			if (!coordinator) {
				throw new Error('Event system not configured. Register events with .event() before using ctx.events');
			}
			this.cachedEvents = new RequestBoundEventEmitter(coordinator, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedEvents;
	}

	/**
	 * Workflow executor for type-safe workflow execution.
	 * Automatically binds workflows to this socket context for correlation.
	 */
	get workflows(): WorkflowExecutor {
		if (this.cachedWorkflows === null) {
			const coordinator = this.app.workflowCoordinator;
			if (!coordinator) {
				throw new Error(
					'Workflow system not configured. Register workflows with .workflow() before using ctx.workflows'
				);
			}
			this.cachedWorkflows = new RequestBoundWorkflowExecutor(coordinator, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedWorkflows;
	}

	/**
	 * Socket emitter for WebSocket messaging.
	 * Provides access to the configured socket emitter for publishing messages.
	 */
	get socket(): SocketEmitter {
		if (this.cachedSocket === null) {
			const emitter = this.app.socket; // Throws if not configured
			this.cachedSocket = new RequestBoundSocketEmitter(emitter, {
				correlationId: this.correlationId,
				logger: this.log
			});
		}
		return this.cachedSocket;
	}

	/**
	 * Parse message data as a specific type.
	 * Uses Json.parse for prototype pollution protection if data is a string.
	 */
	public json<T = unknown>(): T {
		if (typeof this.data === 'string') {
			return Json.parse(this.data) as T;
		}
		return this.data as T;
	}

	/**
	 * Send a message back to this client.
	 */
	public send(data: unknown): void {
		const message = typeof data === 'string' ? data : JSON.stringify(data);
		this.ws.send(message);
	}

	/**
	 * Subscribe this connection to a topic.
	 */
	public subscribe(topic: string): void {
		this.ws.subscribe(topic);
	}

	/**
	 * Unsubscribe this connection from a topic.
	 */
	public unsubscribe(topic: string): void {
		this.ws.unsubscribe(topic);
	}

	/**
	 * Publish a message to a topic (all subscribers receive it).
	 */
	public publish(topic: string, data: unknown): void {
		const message = typeof data === 'string' ? data : JSON.stringify(data);
		this.ws.publish(topic, message);
	}
}
