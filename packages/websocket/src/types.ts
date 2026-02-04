import type { Logger } from '@orijs/logging';
import type { Schema } from '@orijs/validation';
import type { ServerWebSocket } from 'bun';

/** Bun server instance type */
export type BunServer = ReturnType<typeof Bun.serve>;

/**
 * Minimal interface for socket message definitions.
 *
 * This is a structural type that matches SocketMessageDefinition from @orijs/core.
 * We define it here to avoid circular dependency (websocket <- core <- websocket).
 *
 * @template TData - The message data type
 */
export interface SocketMessageLike<TData> {
	/** Unique message name */
	readonly name: string;
	/** Schema for runtime validation (TypeBox, Standard Schema, or custom validator) */
	readonly dataSchema: Schema<TData>;
	/** Type carrier (undefined at runtime) */
	readonly _data: TData;
}

/**
 * Data attached to a WebSocket connection.
 * Applications can extend this with custom data.
 */
export interface SocketData<TData = unknown> {
	/**
	 * Unique identifier for this connection.
	 * @security MUST be cryptographically random (UUID v4 via crypto.randomUUID())
	 *           to prevent socket enumeration and message injection attacks.
	 */
	socketId: string;
	/** Application-specific data attached during upgrade */
	data: TData;
	/** Topics this socket is subscribed to */
	topics: Set<string>;
}

/**
 * WebSocket connection with typed data.
 */
export type WebSocketConnection<TData = unknown> = ServerWebSocket<SocketData<TData>>;

/**
 * Options for upgrading an HTTP request to WebSocket.
 */
export interface WebSocketUpgradeOptions<TData = unknown> {
	/** Application-specific data to attach to the connection */
	data?: TData;
	/** Initial topics to subscribe to */
	topics?: string[];
	/** Custom headers for the upgrade response */
	headers?: Record<string, string>;
}

/**
 * Handler functions for WebSocket events.
 */
export interface WebSocketHandlers<TData = unknown> {
	/** Called when a new connection is established */
	open?(ws: WebSocketConnection<TData>): void | Promise<void>;
	/** Called when a message is received */
	message?(ws: WebSocketConnection<TData>, message: string | ArrayBuffer): void | Promise<void>;
	/** Called when the connection is closed */
	close?(ws: WebSocketConnection<TData>, code: number, reason: string): void | Promise<void>;
	/** Called when a ping is received */
	ping?(ws: WebSocketConnection<TData>, data: Buffer): void | Promise<void>;
	/** Called when a pong is received */
	pong?(ws: WebSocketConnection<TData>, data: Buffer): void | Promise<void>;
	/** Called on WebSocket errors */
	drain?(ws: WebSocketConnection<TData>): void | Promise<void>;
}

// =============================================================================
// ISP Interfaces - Interface Segregation Principle
// =============================================================================

/**
 * Consumer-facing interface - what SERVICES see via ctx.socket.
 *
 * This is the minimal interface that application code needs to emit messages.
 * Services should depend on this interface, not WebSocketProvider.
 *
 * @example
 * ```typescript
 * // In a service method:
 * async notifyUser(socket: SocketEmitter, userId: string, message: string): Promise<void> {
 *   socket.publish(`user:${userId}`, JSON.stringify({ type: 'notification', message }));
 * }
 *
 * // Broadcast to all connected clients:
 * socket.broadcast(JSON.stringify({ type: 'system', message: 'Server restarting' }));
 * ```
 */
export interface SocketEmitter {
	/**
	 * Publishes a message to all subscribers of a topic.
	 *
	 * @param topic - The topic to publish to
	 * @param message - The message to send (string or binary)
	 * @returns Promise that resolves when published, rejects on failure
	 *
	 * @remarks
	 * Callers can optionally await this for delivery confirmation.
	 * For fire-and-forget behavior, simply don't await the returned promise.
	 */
	publish(topic: string, message: string | ArrayBuffer): Promise<void>;

	/**
	 * Sends a message directly to a specific socket.
	 *
	 * @param socketId - The socket ID to send to
	 * @param message - The message to send
	 */
	send(socketId: string, message: string | ArrayBuffer): void;

	/**
	 * Broadcasts a message to all connected sockets.
	 *
	 * @param message - The message to broadcast
	 */
	broadcast(message: string | ArrayBuffer): void;

	/**
	 * Emits a typed socket message to a topic with runtime validation.
	 *
	 * The message data is validated against the schema before sending.
	 * Supports TypeBox schemas, Standard Schema, and custom validators.
	 * The message is serialized as JSON with the format:
	 * ```json
	 * { "name": "message.name", "data": { ... }, "timestamp": 1234567890 }
	 * ```
	 *
	 * @template TData - The message data type
	 * @param message - The socket message definition created via SocketMessage.define()
	 * @param topic - The topic to publish to
	 * @param data - The message data (validated against schema)
	 * @returns Promise that resolves when published
	 *
	 * @throws {Error} If data fails schema validation
	 *
	 * @example
	 * ```typescript
	 * const IncidentCreated = SocketMessage.define({
	 *   name: 'incident.created',
	 *   data: Type.Object({ uuid: Type.String(), title: Type.String() })
	 * });
	 *
	 * await socket.emit(IncidentCreated, 'account:123', {
	 *   uuid: 'inc-456',
	 *   title: 'Server Down'
	 * });
	 * ```
	 */
	emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void>;
}

/**
 * Framework-facing interface - what ORIJS APPLICATION manages.
 *
 * Hooks into OriJS lifecycle (onStartup, onShutdown).
 * Services should never call these directly.
 */
export interface SocketLifecycle {
	/**
	 * Starts the provider (connects to Redis, etc.).
	 * Called by OriJS during application startup.
	 * Must be idempotent - multiple calls should not throw.
	 *
	 * @remarks
	 * **Initialization order**: `start()` is called BEFORE `setServer()`.
	 * Implementations must NOT attempt to publish messages during `start()`
	 * as the Bun server reference will not yet be available. Use `start()`
	 * only for establishing connections (e.g., Redis) and internal setup.
	 */
	start(): Promise<void>;

	/**
	 * Stops the provider gracefully.
	 * Called by OriJS during application shutdown.
	 * Must be idempotent - multiple calls should not throw.
	 */
	stop(): Promise<void>;
}

/**
 * Full provider interface - what IMPLEMENTATIONS provide.
 *
 * Extends both SocketEmitter and SocketLifecycle.
 * Implementations (InMemoryWebSocketProvider, RedisWebSocketProvider) implement this.
 */
export interface WebSocketProvider extends SocketEmitter, SocketLifecycle {
	/**
	 * Subscribes a socket to a topic.
	 *
	 * @param socketId - The socket ID
	 * @param topic - The topic to subscribe to
	 */
	subscribe(socketId: string, topic: string): void;

	/**
	 * Unsubscribes a socket from a topic.
	 *
	 * @param socketId - The socket ID
	 * @param topic - The topic to unsubscribe from
	 */
	unsubscribe(socketId: string, topic: string): void;

	/**
	 * Disconnects a socket and removes it from all subscriptions.
	 * Should be called when a WebSocket connection closes to clean up state.
	 *
	 * @param socketId - The socket ID to disconnect
	 */
	disconnect(socketId: string): void;

	/**
	 * Checks if a socket is currently connected.
	 *
	 * @param socketId - The socket ID
	 * @returns true if connected, false otherwise
	 */
	isConnected(socketId: string): boolean;

	/**
	 * Gets the total number of connected sockets.
	 */
	getConnectionCount(): number;

	/**
	 * Gets the number of subscribers for a topic.
	 *
	 * @param topic - The topic to check
	 * @returns Number of subscribers (0 if topic doesn't exist)
	 */
	getTopicSubscriberCount(topic: string): number;

	/**
	 * Sets the Bun server reference for publishing.
	 * Called by Application when the server starts.
	 *
	 * @param server - The Bun server instance
	 */
	setServer(server: BunServer): void;
}

/**
 * Options for WebSocket providers.
 */
export interface WebSocketProviderOptions {
	/** Logger instance for the provider */
	logger?: Logger;
}

/**
 * Constructor type for custom socket emitters.
 * Used by Application.websocket<TEmitter>() for type inference.
 */
export type SocketEmitterConstructor<TEmitter extends SocketEmitter> = new (
	provider: WebSocketProvider
) => TEmitter;

/**
 * Options for SocketCoordinator.
 */
export interface SocketCoordinatorOptions {
	/** The WebSocket provider to use */
	provider: WebSocketProvider;
	/** Logger instance */
	logger?: Logger;
}

// =============================================================================
// Injection Tokens
// =============================================================================

/**
 * Typed injection token for WebSocketProvider.
 *
 * Use this token when registering or resolving the WebSocket provider
 * via dependency injection. This provides type safety compared to
 * using raw strings.
 *
 * @example
 * ```typescript
 * // Register provider
 * container.registerInstance(WebSocketProviderToken, provider);
 *
 * // Resolve provider
 * const provider = container.resolve(WebSocketProviderToken);
 * ```
 */
export const WebSocketProviderToken: symbol & { readonly __type?: WebSocketProvider } = Symbol(
	'WebSocketProvider'
) as symbol & { readonly __type?: WebSocketProvider };
