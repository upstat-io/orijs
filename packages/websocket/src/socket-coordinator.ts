import { Logger } from '@orijs/logging';
import type { SocketCoordinatorOptions, WebSocketConnection, WebSocketProvider } from './types';

/**
 * Coordinates WebSocket connections and topic subscriptions.
 *
 * Tracks all connected sockets, manages topic subscriptions,
 * and delegates pub/sub operations to the provider.
 *
 * @remarks State ownership: The coordinator maintains local state (connections,
 * topicSubscriptions) for this server instance. The provider maintains its own
 * subscription state for cross-instance coordination (e.g., Redis pub/sub).
 * These are intentionally separate - coordinator state is authoritative for
 * local connections, provider state handles distributed messaging.
 */
export class SocketCoordinator {
	private readonly logger: Logger;
	private readonly provider: WebSocketProvider;
	/** Local WebSocket connections on this server instance */
	private readonly connections: Map<string, WebSocketConnection<unknown>> = new Map();
	/** Topic -> socket IDs for local subscribers (used by getTopicSubscribers) */
	private readonly topicSubscriptions: Map<string, Set<string>> = new Map();

	constructor(options: SocketCoordinatorOptions) {
		this.provider = options.provider;
		this.logger = options.logger ?? Logger.console('SocketCoordinator');
	}

	/**
	 * Adds a new WebSocket connection to track.
	 *
	 * @param ws - The WebSocket connection
	 * @remarks The connection is stored with type erasure (unknown). Callers
	 *          retrieve connections via getConnection<TData>() and are responsible
	 *          for providing the correct type parameter.
	 */
	public addConnection<TData>(ws: WebSocketConnection<TData>): void {
		const socketId = ws.data.socketId;

		// Defensive guard: if connection already exists, skip (idempotent)
		if (this.connections.has(socketId)) {
			this.logger.debug?.(`WebSocket connection already tracked: ${socketId}`);
			return;
		}

		// Safe: widening to unknown for storage; caller specifies type on retrieval
		this.connections.set(socketId, ws as WebSocketConnection<unknown>);
		this.logger.debug?.(`WebSocket connection added: ${socketId}`);
	}

	/**
	 * Removes a WebSocket connection and cleans up its subscriptions.
	 *
	 * @param socketId - The socket ID to remove
	 */
	public removeConnection(socketId: string): void {
		const ws = this.connections.get(socketId);
		if (!ws) {
			return;
		}

		// Clean up all topic subscriptions for this socket
		// Copy to array first to avoid concurrent modification (unsubscribeFromTopic modifies the Set)
		const topicsToClean = [...ws.data.topics];
		for (const topic of topicsToClean) {
			this.unsubscribeFromTopic(socketId, topic);
		}

		this.connections.delete(socketId);
		this.logger.debug?.(`WebSocket connection removed: ${socketId}`);
	}

	/**
	 * Subscribes a socket to a topic.
	 *
	 * @param socketId - The socket ID
	 * @param topic - The topic to subscribe to
	 */
	public subscribeToTopic(socketId: string, topic: string): void {
		const ws = this.connections.get(socketId);
		if (!ws) {
			this.logger.warn?.(`Cannot subscribe socket ${socketId} to topic "${topic}": socket not found`);
			return;
		}

		// Track subscription in coordinator
		let subscribers = this.topicSubscriptions.get(topic);
		if (!subscribers) {
			subscribers = new Set();
			this.topicSubscriptions.set(topic, subscribers);
		}

		// Idempotent: if already subscribed, do nothing
		if (subscribers.has(socketId)) {
			return;
		}

		subscribers.add(socketId);
		ws.data.topics.add(topic);

		// Subscribe via Bun's native topic system
		ws.subscribe(topic);

		// Delegate to provider for cross-instance subscriptions (Redis)
		this.provider.subscribe(socketId, topic);

		this.logger.debug?.(`Socket ${socketId} subscribed to topic: ${topic}`);
	}

	/**
	 * Unsubscribes a socket from a topic.
	 *
	 * @param socketId - The socket ID
	 * @param topic - The topic to unsubscribe from
	 */
	public unsubscribeFromTopic(socketId: string, topic: string): void {
		const ws = this.connections.get(socketId);
		if (!ws) {
			return;
		}

		const subscribers = this.topicSubscriptions.get(topic);
		if (subscribers) {
			subscribers.delete(socketId);
			if (subscribers.size === 0) {
				this.topicSubscriptions.delete(topic);
			}
		}

		ws.data.topics.delete(topic);

		// Unsubscribe via Bun's native topic system
		ws.unsubscribe(topic);

		// Delegate to provider for cross-instance unsubscriptions (Redis)
		this.provider.unsubscribe(socketId, topic);

		this.logger.debug?.(`Socket ${socketId} unsubscribed from topic: ${topic}`);
	}

	/**
	 * Gets a connection by socket ID.
	 *
	 * @param socketId - The socket ID
	 * @returns The connection, or undefined if not found
	 * @remarks Caller is responsible for providing correct TData type parameter.
	 *          No runtime validation is performed - the type is trusted.
	 */
	public getConnection<TData>(socketId: string): WebSocketConnection<TData> | undefined {
		return this.connections.get(socketId) as WebSocketConnection<TData> | undefined;
	}

	/**
	 * Gets all sockets subscribed to a topic.
	 *
	 * @param topic - The topic
	 * @returns Array of connected sockets subscribed to the topic
	 */
	public getTopicSubscribers(topic: string): WebSocketConnection<unknown>[] {
		const subscribers = this.topicSubscriptions.get(topic);
		if (!subscribers) {
			return [];
		}

		const connections: WebSocketConnection<unknown>[] = [];
		for (const socketId of subscribers) {
			const ws = this.connections.get(socketId);
			if (ws) {
				connections.push(ws);
			}
		}
		return connections;
	}

	/**
	 * Gets all active connections.
	 *
	 * @returns Array of all connected WebSocket connections
	 */
	public getAllConnections(): WebSocketConnection<unknown>[] {
		return Array.from(this.connections.values());
	}

	/**
	 * Gets the total number of connected sockets.
	 * @returns Number of active connections
	 */
	public getConnectionCount(): number {
		return this.connections.size;
	}

	/**
	 * Gets the WebSocket provider.
	 * @returns The WebSocket provider instance
	 */
	public getProvider(): WebSocketProvider {
		return this.provider;
	}
}
