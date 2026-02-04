import { Logger } from '@orijs/logging';
import { validate } from '@orijs/validation';
import type { BunServer, WebSocketProvider, WebSocketProviderOptions, SocketMessageLike } from './types';
import { validateTopic, validateSocketId } from './validation';

/**
 * Options for InProcWsProvider.
 * Extends WebSocketProviderOptions for API consistency with RedisWsProviderOptions.
 * Currently empty - provider-specific options may be added in future.
 */
export interface InProcWsProviderOptions extends WebSocketProviderOptions {}

/**
 * In-process WebSocket provider for single-instance deployments.
 *
 * Uses Bun's native server.publish() for local pub/sub.
 * Does not support horizontal scaling - use RedisWsProvider for that.
 *
 * @remarks Thread safety: All operations are synchronous and JavaScript is
 * single-threaded, so no race conditions are possible. Cross-instance providers
 * (e.g., RedisWsProvider) must implement their own synchronization.
 */
export class InProcWsProvider implements WebSocketProvider {
	private readonly logger: Logger;
	private server: BunServer | null = null;
	private started = false;

	/**
	 * Tracks local subscriptions for metrics.
	 * Map of topic -> Set of socket IDs
	 */
	private readonly localSubscriptions: Map<string, Set<string>> = new Map();

	/**
	 * Reverse index: socket ID -> Set of topics.
	 * Enables O(1) hasAnySubscriptions check instead of O(T) topic scan.
	 */
	private readonly socketTopics: Map<string, Set<string>> = new Map();

	/**
	 * Tracks connected sockets for isConnected() check.
	 */
	private readonly connectedSockets: Set<string> = new Set();

	constructor(options: InProcWsProviderOptions = {}) {
		this.logger = options.logger ?? Logger.console('InProcWsProvider');
	}

	// ==========================================================================
	// SocketLifecycle Implementation
	// ==========================================================================

	/**
	 * Starts the provider.
	 * Idempotent - multiple calls do not throw.
	 */
	public async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.started = true;
		this.logger.info('InProcWsProvider started');
	}

	/**
	 * Stops the provider and cleans up resources.
	 * Idempotent - multiple calls do not throw.
	 */
	public async stop(): Promise<void> {
		if (!this.started) {
			return;
		}
		this.started = false;
		this.localSubscriptions.clear();
		this.socketTopics.clear();
		this.connectedSockets.clear();
		this.server = null;
		this.logger.info('InProcWsProvider stopped');
	}

	// ==========================================================================
	// SocketEmitter Implementation
	// ==========================================================================

	/**
	 * Publishes a message to all subscribers of a topic.
	 *
	 * @returns Promise that resolves immediately (in-process publish is synchronous)
	 * @throws {Error} If topic is empty or contains only whitespace
	 * @throws {Error} If provider is not ready (server not set)
	 */
	public publish(topic: string, message: string | ArrayBuffer): Promise<void> {
		validateTopic(topic);
		if (!this.server) {
			const errorMsg = `Cannot publish to topic "${topic}": Provider not ready`;
			this.logger.error(errorMsg);
			return Promise.reject(new Error(errorMsg));
		}
		this.server.publish(topic, message);
		return Promise.resolve();
	}

	/**
	 * Sends a message directly to a specific socket.
	 * Uses a socket-specific topic channel.
	 *
	 * @throws {Error} If socketId is empty or contains only whitespace
	 */
	public send(socketId: string, message: string | ArrayBuffer): void {
		validateSocketId(socketId);
		const topic = `__socket__:${socketId}`;
		this.publish(topic, message).catch(() => {}); // Errors already logged in publish()
	}

	/**
	 * Broadcasts a message to all connected sockets.
	 * Uses the special __broadcast__ topic.
	 */
	public broadcast(message: string | ArrayBuffer): void {
		this.publish('__broadcast__', message).catch(() => {}); // Errors already logged in publish()
	}

	/**
	 * Emits a typed socket message to a topic with runtime validation.
	 *
	 * Validates the data against the schema (TypeBox, Standard Schema, or custom validator),
	 * then serializes as JSON with format: { name, data, timestamp }.
	 *
	 * @throws {Error} If data fails schema validation
	 * @throws {Error} If topic is empty or contains only whitespace
	 * @throws {Error} If provider is not ready (server not set)
	 */
	public async emit<TData>(message: SocketMessageLike<TData>, topic: string, data: TData): Promise<void> {
		// Validate against schema (supports TypeBox, Standard Schema, or custom validator)
		const result = await validate(message.dataSchema, data);
		if (!result.success) {
			const details = result.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
			const errorMsg = `Socket message validation failed for "${message.name}": ${details}`;
			this.logger.error(errorMsg);
			throw new Error(errorMsg);
		}

		// Serialize with standard envelope format
		const payload = JSON.stringify({
			name: message.name,
			data: result.data,
			timestamp: Date.now()
		});

		return this.publish(topic, payload);
	}

	// ==========================================================================
	// WebSocketProvider Implementation
	// ==========================================================================

	/**
	 * Sets the Bun server reference for publishing.
	 */
	public setServer(server: BunServer): void {
		this.server = server;
	}

	/**
	 * Subscribes a socket to a topic.
	 * Tracks locally for metrics.
	 *
	 * @throws {Error} If socketId is empty or contains only whitespace
	 * @throws {Error} If topic is empty or contains only whitespace
	 */
	public subscribe(socketId: string, topic: string): void {
		validateSocketId(socketId);
		validateTopic(topic);

		// Update topic -> sockets index
		let subscribers = this.localSubscriptions.get(topic);
		if (!subscribers) {
			subscribers = new Set();
			this.localSubscriptions.set(topic, subscribers);
		}
		subscribers.add(socketId);

		// Update socket -> topics reverse index
		let topics = this.socketTopics.get(socketId);
		if (!topics) {
			topics = new Set();
			this.socketTopics.set(socketId, topics);
		}
		topics.add(topic);

		this.connectedSockets.add(socketId);
	}

	/**
	 * Unsubscribes a socket from a topic.
	 * Automatically marks socket as disconnected when no subscriptions remain.
	 *
	 * @throws {Error} If socketId is empty or contains only whitespace
	 * @throws {Error} If topic is empty or contains only whitespace
	 */
	public unsubscribe(socketId: string, topic: string): void {
		validateSocketId(socketId);
		validateTopic(topic);

		// Update topic -> sockets index
		const subscribers = this.localSubscriptions.get(topic);
		if (subscribers) {
			subscribers.delete(socketId);
			if (subscribers.size === 0) {
				this.localSubscriptions.delete(topic);
			}
		}

		// Update socket -> topics reverse index
		const topics = this.socketTopics.get(socketId);
		if (topics) {
			topics.delete(topic);
			if (topics.size === 0) {
				// No more subscriptions - clean up
				this.socketTopics.delete(socketId);
				this.connectedSockets.delete(socketId);
			}
		}
	}

	/**
	 * Disconnects a socket and removes it from all subscriptions.
	 * Should be called when a WebSocket connection closes to clean up state.
	 *
	 * @throws {Error} If socketId is empty or contains only whitespace
	 */
	public disconnect(socketId: string): void {
		validateSocketId(socketId);

		// Use reverse index for O(S) cleanup instead of O(T) topic scan
		const topics = this.socketTopics.get(socketId);
		if (topics) {
			for (const topic of topics) {
				const subscribers = this.localSubscriptions.get(topic);
				if (subscribers) {
					subscribers.delete(socketId);
					if (subscribers.size === 0) {
						this.localSubscriptions.delete(topic);
					}
				}
			}
			this.socketTopics.delete(socketId);
		}

		this.connectedSockets.delete(socketId);
	}

	/**
	 * Checks if a socket is currently connected.
	 * @returns true if socket is connected, false otherwise
	 */
	public isConnected(socketId: string): boolean {
		return this.connectedSockets.has(socketId);
	}

	/**
	 * Gets the total number of connected sockets.
	 * @returns Number of connected sockets
	 */
	public getConnectionCount(): number {
		return this.connectedSockets.size;
	}

	/**
	 * Gets the number of subscribers for a topic.
	 * @returns Number of subscribers (0 if topic doesn't exist)
	 */
	public getTopicSubscriberCount(topic: string): number {
		const subscribers = this.localSubscriptions.get(topic);
		return subscribers?.size ?? 0;
	}
}

/**
 * Factory function to create an InProcWsProvider.
 */
export function createInProcWsProvider(options?: InProcWsProviderOptions): InProcWsProvider {
	return new InProcWsProvider(options);
}
