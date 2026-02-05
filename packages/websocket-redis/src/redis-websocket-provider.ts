/**
 * Redis WebSocket Provider - Redis-backed WebSocket Implementation
 *
 * Implements the WebSocketProvider interface with Redis pub/sub backend
 * for horizontal scaling across multiple server instances.
 *
 * Uses two Redis connections:
 * - Publisher: for PUBLISH commands
 * - Subscriber: for SUBSCRIBE/UNSUBSCRIBE and receiving messages
 *
 * This separation is required because a Redis connection in subscriber mode
 * cannot issue PUBLISH commands.
 *
 * @example
 * ```typescript
 * const provider = new RedisWsProvider({
 *   connection: { host: 'localhost', port: 6379 }
 * });
 * await provider.start();
 * provider.setServer(server);
 * provider.publish('room:123', 'Hello!');
 * ```
 */

import { Redis } from 'ioredis';
import { Logger } from '@orijs/logging';
import { validate } from '@orijs/validation';
import type {
	BunServer,
	WebSocketProvider,
	WebSocketProviderOptions,
	SocketMessageLike
} from '@orijs/websocket';
import { validateTopic, validateSocketId } from '@orijs/websocket';

/**
 * Connection options for Redis.
 */
export interface RedisConnectionOptions {
	readonly host: string;
	readonly port: number;
}

/**
 * Options for RedisWsProvider.
 */
export interface RedisWsProviderOptions extends WebSocketProviderOptions {
	/** Redis connection configuration */
	readonly connection: RedisConnectionOptions;
	/** Prefix for Redis channels (default: 'ws') */
	readonly keyPrefix?: string;
	/** Connection timeout in milliseconds (default: 2000ms) */
	readonly connectTimeout?: number;
}

/**
 * Internal message envelope for Redis pub/sub.
 * This is a framework-internal protocol, not user-facing validation.
 */
interface RedisMessageEnvelope {
	readonly topic: string;
	readonly message: string;
	readonly isBinary: boolean;
}

/**
 * Keys that can trigger prototype pollution attacks.
 * These are stripped from parsed JSON to prevent security issues.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanitize an object to prevent prototype pollution.
 * Recursively removes dangerous keys from objects.
 */
function sanitizeJson<T>(obj: T): T {
	if (obj === null || typeof obj !== 'object') {
		return obj;
	}
	if (Array.isArray(obj)) {
		return obj.map(sanitizeJson) as T;
	}
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		if (!DANGEROUS_KEYS.has(key)) {
			result[key] = sanitizeJson((obj as Record<string, unknown>)[key]);
		}
	}
	return result as T;
}

/**
 * Validates that a parsed object conforms to the RedisMessageEnvelope structure.
 * Simple runtime type checking for internal protocol - not user-facing validation.
 */
function isValidMessageEnvelope(obj: unknown): obj is RedisMessageEnvelope {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}
	const candidate = obj as Record<string, unknown>;
	return (
		typeof candidate.topic === 'string' &&
		candidate.topic.length > 0 &&
		typeof candidate.message === 'string' &&
		typeof candidate.isBinary === 'boolean'
	);
}

/** Maximum retry attempts for Redis subscribe operations */
const SUBSCRIBE_MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff (with jitter) */
const SUBSCRIBE_BASE_DELAY_MS = 100;

/** Maximum channels to subscribe to in a single Redis command (prevents stack overflow from spread operator) */
const RESUBSCRIBE_BATCH_SIZE = 1000;

/**
 * Redis-backed WebSocket provider for horizontal scaling.
 *
 * Bridges Redis pub/sub to Bun's local server.publish().
 * Messages published on any instance are delivered to all instances
 * subscribed to the topic.
 */
export class RedisWsProvider implements WebSocketProvider {
	private readonly logger: Logger;
	private readonly keyPrefix: string;
	private readonly connectTimeout: number;
	private readonly connectionOptions: RedisConnectionOptions;

	private publisher: Redis | null = null;
	private subscriber: Redis | null = null;
	private server: BunServer | null = null;
	private started = false;

	/**
	 * Tracks which topics have local subscribers.
	 * Key: topic, Value: Set of socket IDs
	 * Used to determine when to SUBSCRIBE/UNSUBSCRIBE from Redis.
	 */
	private readonly localSubscriptions: Map<string, Set<string>> = new Map();

	/**
	 * Reverse index: socket ID -> Set of topics.
	 * Enables O(1) hasAnySubscriptions check instead of O(T) topic scan.
	 */
	private readonly socketTopics: Map<string, Set<string>> = new Map();

	/**
	 * Tracks connected socket IDs for isConnected() check.
	 */
	private readonly connectedSockets: Set<string> = new Set();

	/**
	 * Tracks which Redis channels we're subscribed to.
	 */
	private readonly redisSubscriptions: Set<string> = new Set();

	/**
	 * Tracks which Redis channels have pending subscribe operations.
	 * Prevents duplicate subscribe attempts while one is in-flight.
	 */
	private readonly pendingSubscriptions: Set<string> = new Set();

	/**
	 * Tracks which Redis channels have pending unsubscribe operations.
	 * Prevents race conditions when resubscribing to a channel being unsubscribed.
	 */
	private readonly pendingUnsubscriptions: Set<string> = new Set();

	/**
	 * Tracks pending retry timeouts for cleanup during stop().
	 */
	private readonly retryTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

	constructor(options: RedisWsProviderOptions) {
		this.logger = options.logger ?? Logger.console('RedisWsProvider');
		this.keyPrefix = options.keyPrefix ?? 'ws';
		this.connectTimeout = options.connectTimeout ?? 2000;
		this.connectionOptions = options.connection;
	}

	/**
	 * Returns the key prefix used for Redis channel names.
	 * Useful for debugging and testing.
	 * @returns The configured key prefix string
	 */
	public getKeyPrefix(): string {
		return this.keyPrefix;
	}

	/**
	 * Returns the configured connection timeout in milliseconds.
	 * Useful for debugging and testing.
	 * @returns Connection timeout in milliseconds
	 */
	public getConnectTimeout(): number {
		return this.connectTimeout;
	}

	// ==========================================================================
	// SocketLifecycle Implementation
	// ==========================================================================

	/**
	 * Starts the provider by establishing Redis connections.
	 * Idempotent - multiple calls do not throw.
	 */
	public async start(): Promise<void> {
		if (this.started) {
			return;
		}

		const redisOptions = {
			...this.connectionOptions,
			connectTimeout: this.connectTimeout,
			commandTimeout: this.connectTimeout, // Timeout for individual commands
			maxRetriesPerRequest: 1 // Fail fast on connection issues
		};

		// Create publisher connection
		this.publisher = new Redis(redisOptions);
		this.publisher.on('error', (err) => {
			this.logger.warn('Redis publisher error', { error: err.message });
		});

		// Create subscriber connection
		this.subscriber = new Redis(redisOptions);
		this.subscriber.on('error', (err) => {
			this.logger.warn('Redis subscriber error', { error: err.message });
		});

		// Handle incoming messages from Redis
		this.subscriber.on('message', (channel: string, rawMessage: string) => {
			this.handleRedisMessage(channel, rawMessage);
		});

		// Re-subscribe to all channels after reconnection
		this.subscriber.on('ready', () => {
			this.resubscribeAll();
		});

		this.started = true;
		this.logger.info('RedisWsProvider started');
	}

	/**
	 * Stops the provider and cleans up all resources.
	 * Idempotent - multiple calls do not throw.
	 */
	public async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		this.started = false;

		// Unsubscribe from all Redis channels
		if (this.subscriber && this.redisSubscriptions.size > 0) {
			const channels = Array.from(this.redisSubscriptions);
			try {
				await this.subscriber.unsubscribe(...channels);
			} catch (err) {
				// Log but don't fail during shutdown - connection may already be closed
				this.logger.debug('Unsubscribe failed during shutdown', {
					channelCount: channels.length,
					error: err instanceof Error ? err.message : 'Unknown error'
				});
			}
		}
		this.redisSubscriptions.clear();
		this.pendingSubscriptions.clear();
		this.pendingUnsubscriptions.clear();

		// Clear pending retry timeouts
		for (const timeoutId of this.retryTimeouts) {
			clearTimeout(timeoutId);
		}
		this.retryTimeouts.clear();

		// Remove event listeners before closing connections
		if (this.publisher) {
			this.publisher.removeAllListeners();
		}
		if (this.subscriber) {
			this.subscriber.removeAllListeners();
		}

		// Close Redis connections gracefully
		await this.closeRedisConnection(this.publisher, 'publisher');
		await this.closeRedisConnection(this.subscriber, 'subscriber');

		this.publisher = null;
		this.subscriber = null;
		this.server = null;
		this.localSubscriptions.clear();
		this.socketTopics.clear();
		this.connectedSockets.clear();

		this.logger.info('RedisWsProvider stopped');
	}

	/**
	 * Gracefully closes a Redis connection with fallback to disconnect.
	 */
	private async closeRedisConnection(redis: Redis | null, name: string): Promise<void> {
		if (!redis) {
			return;
		}

		try {
			if (redis.status === 'ready' || redis.status === 'connecting') {
				await redis.quit();
			}
		} catch {
			// Force disconnect if quit fails
			try {
				redis.disconnect();
			} catch (disconnectErr) {
				this.logger.warn(`Failed to disconnect Redis ${name}`, {
					error: disconnectErr instanceof Error ? disconnectErr.message : 'Unknown error'
				});
			}
		}
	}

	// ==========================================================================
	// SocketEmitter Implementation
	// ==========================================================================

	/**
	 * Publishes a message to all subscribers of a topic.
	 * Message is broadcast via Redis to all server instances.
	 *
	 * @returns Promise that resolves when published to Redis, rejects on failure
	 * @throws {Error} If topic is empty, too long, or contains invalid characters
	 * @throws {Error} If provider not started (Promise rejection)
	 *
	 * @remarks
	 * Callers can optionally await this for delivery confirmation.
	 * For fire-and-forget behavior, simply don't await the returned promise.
	 * Errors are always logged internally regardless of whether the promise is awaited.
	 */
	public publish(topic: string, message: string | ArrayBuffer): Promise<void> {
		validateTopic(topic);

		if (!this.publisher) {
			const errorMsg = `Cannot publish to topic "${topic}": Provider not ready`;
			this.logger.error(errorMsg);
			return Promise.reject(new Error(errorMsg));
		}

		const channel = this.getRedisChannel(topic);
		const envelope: RedisMessageEnvelope = {
			topic,
			message: message instanceof ArrayBuffer ? Buffer.from(message).toString('base64') : message,
			isBinary: message instanceof ArrayBuffer
		};

		return this.publisher
			.publish(channel, JSON.stringify(envelope))
			.then(() => {}) // Convert number result to void
			.catch((err) => {
				this.logger.error('Failed to publish to Redis', {
					topic,
					error: err instanceof Error ? err.message : 'Unknown error'
				});
				throw err; // Re-throw so promise rejects for callers who await
			});
	}

	/**
	 * Sends a message directly to a specific socket.
	 * Uses a socket-specific Redis channel.
	 *
	 * @throws {Error} If socketId is empty or not a valid UUID v4
	 */
	public send(socketId: string, message: string | ArrayBuffer): void {
		validateSocketId(socketId);
		// Publish to socket-specific channel (fire-and-forget)
		// Note: publish() logs errors internally before rejecting, so empty catch is intentional
		const topic = `__socket__:${socketId}`;
		this.publish(topic, message).catch(() => {});
	}

	/**
	 * Broadcasts a message to all connected sockets.
	 * Uses the special __broadcast__ topic.
	 */
	public broadcast(message: string | ArrayBuffer): void {
		// Note: publish() logs errors internally before rejecting, so empty catch is intentional
		this.publish('__broadcast__', message).catch(() => {});
	}

	/**
	 * Emits a typed socket message to a topic with runtime validation.
	 *
	 * Validates the data against the schema (TypeBox, Standard Schema, or custom validator),
	 * then serializes as JSON with format: { name, data, timestamp }.
	 *
	 * @throws {Error} If data fails schema validation
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
	 * Sets the Bun server reference for local publishing.
	 */
	public setServer(server: BunServer): void {
		this.server = server;
	}

	/**
	 * Subscribes a socket to a topic.
	 * Subscribes to Redis channel on first local subscriber.
	 *
	 * @throws {Error} If socketId is empty or not a valid UUID v4
	 * @throws {Error} If topic is empty, too long, or contains invalid characters
	 */
	public subscribe(socketId: string, topic: string): void {
		validateSocketId(socketId);
		validateTopic(topic);

		// Track local subscription (topic -> sockets)
		let subscribers = this.localSubscriptions.get(topic);
		if (!subscribers) {
			subscribers = new Set();
			this.localSubscriptions.set(topic, subscribers);
		}

		const wasEmpty = subscribers.size === 0;
		subscribers.add(socketId);

		// Update socket -> topics reverse index
		let topics = this.socketTopics.get(socketId);
		if (!topics) {
			topics = new Set();
			this.socketTopics.set(socketId, topics);
		}
		topics.add(topic);

		this.connectedSockets.add(socketId);

		// Subscribe to Redis channel if this is the first local subscriber
		if (wasEmpty && this.subscriber) {
			const channel = this.getRedisChannel(topic);

			// If there's a pending unsubscription, cancel it - the channel is still subscribed
			// (the Redis unsubscribe is in-flight but we'll keep receiving messages until it completes)
			if (this.pendingUnsubscriptions.has(channel)) {
				this.pendingUnsubscriptions.delete(channel);
				// Re-add to redisSubscriptions since we want to keep it
				this.redisSubscriptions.add(channel);
				// Channel is still subscribed, no need to resubscribe
				return;
			}

			// Skip if already subscribed or subscription is in progress
			if (!this.redisSubscriptions.has(channel) && !this.pendingSubscriptions.has(channel)) {
				this.pendingSubscriptions.add(channel);
				this.subscribeWithRetry(channel);
			}
		}
	}

	/**
	 * Attempts to subscribe to a Redis channel with exponential backoff retry.
	 */
	private subscribeWithRetry(channel: string, attempt = 1): void {
		if (!this.subscriber || !this.started) {
			this.pendingSubscriptions.delete(channel);
			return;
		}

		this.subscriber
			.subscribe(channel)
			.then(() => {
				// Success: move from pending to subscribed
				this.pendingSubscriptions.delete(channel);
				this.redisSubscriptions.add(channel);
			})
			.catch((err) => {
				const errorMessage = err instanceof Error ? err.message : 'Unknown error';

				if (attempt < SUBSCRIBE_MAX_RETRIES) {
					// Calculate delay with exponential backoff and jitter
					const delay = Math.pow(2, attempt - 1) * SUBSCRIBE_BASE_DELAY_MS * (0.5 + Math.random());

					this.logger.warn('Redis subscribe failed, retrying', {
						channel,
						attempt,
						nextRetryMs: Math.round(delay),
						error: errorMessage
					});

					const timeoutId = setTimeout(() => {
						this.retryTimeouts.delete(timeoutId);
						this.subscribeWithRetry(channel, attempt + 1);
					}, delay);
					this.retryTimeouts.add(timeoutId);
				} else {
					this.logger.error('Redis subscribe failed after max retries', {
						channel,
						attempts: attempt,
						error: errorMessage
					});
					// Final failure: remove from pending, don't add to subscribed
					this.pendingSubscriptions.delete(channel);
				}
			});
	}

	/**
	 * Unsubscribes a socket from a topic.
	 * Unsubscribes from Redis channel when last local subscriber leaves.
	 *
	 * @throws {Error} If socketId is empty or not a valid UUID v4
	 * @throws {Error} If topic is empty, too long, or contains invalid characters
	 */
	public unsubscribe(socketId: string, topic: string): void {
		validateSocketId(socketId);
		validateTopic(topic);

		const subscribers = this.localSubscriptions.get(topic);
		if (!subscribers) {
			return;
		}

		subscribers.delete(socketId);

		// Unsubscribe from Redis if no more local subscribers
		if (subscribers.size === 0) {
			this.localSubscriptions.delete(topic);
			const channel = this.getRedisChannel(topic);
			if (this.redisSubscriptions.has(channel) && this.subscriber) {
				this.redisSubscriptions.delete(channel);
				this.pendingUnsubscriptions.add(channel);
				this.subscriber
					.unsubscribe(channel)
					.catch((err) => {
						this.logger.warn('Failed to unsubscribe from Redis channel', {
							channel,
							error: err instanceof Error ? err.message : 'Unknown error'
						});
					})
					.finally(() => {
						this.pendingUnsubscriptions.delete(channel);
					});
			}
		}

		// Update socket -> topics reverse index
		const socketTopicSet = this.socketTopics.get(socketId);
		if (socketTopicSet) {
			socketTopicSet.delete(topic);
			if (socketTopicSet.size === 0) {
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
	 * @throws {Error} If socketId is empty or not a valid UUID v4
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
						const channel = this.getRedisChannel(topic);
						if (this.redisSubscriptions.has(channel) && this.subscriber) {
							this.redisSubscriptions.delete(channel);
							this.pendingUnsubscriptions.add(channel);
							this.subscriber
								.unsubscribe(channel)
								.catch((err) => {
									this.logger.warn('Failed to unsubscribe from Redis channel during disconnect', {
										channel,
										error: err instanceof Error ? err.message : 'Unknown error'
									});
								})
								.finally(() => {
									this.pendingUnsubscriptions.delete(channel);
								});
						}
					}
				}
			}
			this.socketTopics.delete(socketId);
		}

		this.connectedSockets.delete(socketId);
	}

	/**
	 * Checks if a socket is currently connected (on this instance).
	 * @returns true if socket is connected on this instance, false otherwise
	 */
	public isConnected(socketId: string): boolean {
		return this.connectedSockets.has(socketId);
	}

	/**
	 * Gets the total number of connected sockets (on this instance).
	 * @returns Number of sockets connected to this instance
	 */
	public getConnectionCount(): number {
		return this.connectedSockets.size;
	}

	/**
	 * Gets the number of subscribers for a topic (on this instance).
	 * @returns Number of local subscribers for the topic
	 */
	public getTopicSubscriberCount(topic: string): number {
		const subscribers = this.localSubscriptions.get(topic);
		return subscribers?.size ?? 0;
	}

	// ==========================================================================
	// Private Helpers
	// ==========================================================================

	/**
	 * Converts a topic to a Redis channel name with prefix.
	 */
	private getRedisChannel(topic: string): string {
		return `${this.keyPrefix}:${topic}`;
	}

	/**
	 * Handles an incoming message from Redis subscription.
	 * Forwards to local Bun server for WebSocket delivery.
	 *
	 * Uses safe JSON parsing (prototype pollution protection) and
	 * runtime type checking for the internal protocol envelope.
	 */
	private handleRedisMessage(channel: string, rawMessage: string): void {
		if (!this.server) {
			this.logger.warn('Cannot handle Redis message: Server not set');
			return;
		}

		try {
			// Parse JSON and sanitize to prevent prototype pollution
			const parsed = sanitizeJson(JSON.parse(rawMessage));

			// Validate internal protocol structure
			if (!isValidMessageEnvelope(parsed)) {
				this.logger.warn('Invalid Redis message format', { channel });
				return;
			}

			const { topic, message, isBinary } = parsed;
			const payload = isBinary ? Buffer.from(message, 'base64') : message;
			this.server.publish(topic, payload);
		} catch (error) {
			this.logger.warn('Failed to handle Redis message', {
				channel,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	}

	/**
	 * Re-subscribes to all tracked Redis channels after reconnection.
	 * Called when the subscriber connection emits 'ready'.
	 * Batches subscriptions to avoid stack overflow with large channel counts.
	 */
	private resubscribeAll(): void {
		if (!this.subscriber || !this.started || this.redisSubscriptions.size === 0) {
			return;
		}

		const channels = Array.from(this.redisSubscriptions);
		this.logger.info('Redis subscriber reconnected, resubscribing', { channelCount: channels.length });

		// Batch subscriptions to avoid stack overflow from spread operator
		const subscribeBatches = async (): Promise<void> => {
			for (let i = 0; i < channels.length; i += RESUBSCRIBE_BATCH_SIZE) {
				const batch = channels.slice(i, i + RESUBSCRIBE_BATCH_SIZE);
				await this.subscriber!.subscribe(...batch);
			}
		};

		subscribeBatches().catch((err) => {
			this.logger.error('Failed to resubscribe after reconnect', {
				channelCount: channels.length,
				error: err instanceof Error ? err.message : 'Unknown error'
			});
		});
	}
}

/**
 * Factory function to create a RedisWsProvider.
 *
 * @example
 * ```typescript
 * const provider = createRedisWsProvider({
 *   connection: { host: 'localhost', port: 6379 },
 *   keyPrefix: 'myapp',
 *   connectTimeout: 5000
 * });
 *
 * await provider.start();
 * provider.subscribe(socketId, 'room:123');
 * await provider.publish('room:123', 'Hello!');
 * ```
 */
export function createRedisWsProvider(options: RedisWsProviderOptions): RedisWsProvider {
	return new RedisWsProvider(options);
}
