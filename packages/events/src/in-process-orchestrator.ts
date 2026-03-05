/**
 * In-Process Event Provider - Local synchronous event delivery.
 *
 * Delivers events synchronously within the same process.
 * Ideal for development and testing where distributed queues
 * aren't needed.
 *
 * Uses composition pattern for better testability:
 * - HandlerRegistry: manages subscriptions
 * - EventDeliveryEngine: handles execution
 *
 * @module events/in-process-orchestrator
 */

import {
	EVENT_MESSAGE_VERSION,
	type EventProvider,
	type EventHandlerFn,
	type EmitOptions,
	type EventMessage
} from './event-provider.types';
import { Logger, type PropagationMeta } from '@orijs/logging';
import type { EventSubscription } from './event-subscription';
import { createSubscription } from './event-subscription';
import { HandlerRegistry, type IHandlerRegistry } from './handler-registry';
import {
	EventDeliveryEngine,
	createChainedEmitFactory,
	type IEventDelivery,
	type EventDeliveryLogger
} from './event-delivery';

/**
 * Configuration options for InProcessEventProvider.
 */
export interface InProcessEventProviderOptions {
	/**
	 * Custom handler registry (for testing).
	 */
	readonly registry?: IHandlerRegistry;

	/**
	 * Custom delivery engine (for testing).
	 */
	readonly delivery?: IEventDelivery;

	/**
	 * Custom logger (for testing).
	 */
	readonly log?: EventDeliveryLogger;

	/**
	 * TTL for idempotency keys in milliseconds.
	 * Keys older than this are removed during cleanup.
	 * Default: 300000 (5 minutes)
	 */
	readonly idempotencyKeyTtlMs?: number;

	/**
	 * Interval for cleaning up expired idempotency keys in milliseconds.
	 * Default: 60000 (1 minute)
	 */
	readonly idempotencyCleanupIntervalMs?: number;
}

/**
 * In-process event provider for local delivery.
 *
 * Events are delivered synchronously within the same process.
 * Handler return values flow back to the emitter's EventSubscription.
 *
 * Uses composition for better testability - you can inject mock
 * registry/delivery/logger for isolated testing.
 *
 * @example
 * ```ts
 * const provider = new InProcessEventProvider();
 *
 * // Subscribe to events
 * provider.subscribe('user.created', async (msg) => {
 *   console.log('User created:', msg.payload);
 *   return { processed: true };
 * });
 *
 * // Emit with request-response
 * provider.emit<{ processed: boolean }>('user.created', { id: 1 }, {})
 *   .subscribe((result) => console.log('Result:', result));
 *
 * await provider.start();
 * ```
 *
 * @example Testing with mocks
 * ```ts
 * const mockRegistry = { subscribe: mock(), getHandlers: mock(), ... };
 * const provider = new InProcessEventProvider({ registry: mockRegistry });
 * // Now you can verify registry interactions independently
 * ```
 */
export class InProcessEventProvider implements EventProvider {
	private readonly registry: IHandlerRegistry;
	private readonly delivery: IEventDelivery;
	private readonly pendingTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
	/**
	 * Tracks pending delayed events by key for cancellation.
	 * Maps key -> { timeout, subscription } so cancellation can reject the subscription.
	 */
	private readonly pendingDelayedByKey = new Map<string, { timeout: ReturnType<typeof setTimeout>; subscription: EventSubscription<unknown> }>();
	/**
	 * Tracks processed idempotency keys to prevent duplicate event delivery.
	 * Maps idempotencyKey -> timestamp for TTL-based cleanup.
	 */
	private readonly processedIdempotencyKeys = new Map<string, number>();
	private started = false;
	/** TTL for idempotency keys in milliseconds */
	private readonly idempotencyKeyTtlMs: number;
	/** Interval for cleaning up expired idempotency keys */
	private idempotencyCleanupInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * Creates a new InProcessEventProvider.
	 *
	 * @param options - Optional configuration for dependency injection
	 */
	public constructor(options: InProcessEventProviderOptions = {}) {
		this.registry = options.registry ?? new HandlerRegistry();
		this.idempotencyKeyTtlMs = options.idempotencyKeyTtlMs ?? 5 * 60 * 1000; // 5 minutes default

		// Create delivery engine with injected or default components
		const log = options.log ?? new Logger('EventSystem');
		this.delivery =
			options.delivery ??
			new EventDeliveryEngine({
				registry: this.registry,
				log,
				createChainedEmit: createChainedEmitFactory(this.emit.bind(this))
			});

		// Start cleanup interval for idempotency keys
		const cleanupIntervalMs = options.idempotencyCleanupIntervalMs ?? 60 * 1000; // 1 minute default
		this.idempotencyCleanupInterval = setInterval(() => {
			this.cleanupExpiredIdempotencyKeys();
		}, cleanupIntervalMs);
		// Don't keep process alive just for cleanup
		this.idempotencyCleanupInterval.unref?.();
	}

	/**
	 * Removes idempotency keys older than the TTL.
	 */
	private cleanupExpiredIdempotencyKeys(): void {
		const now = Date.now();
		for (const [key, timestamp] of this.processedIdempotencyKeys) {
			if (now - timestamp > this.idempotencyKeyTtlMs) {
				this.processedIdempotencyKeys.delete(key);
			}
		}
	}

	/**
	 * Emits an event to subscribers.
	 *
	 * For request-response, the first handler's return value is passed
	 * to the subscription. For fire-and-forget, all handlers are called.
	 *
	 * @template TReturn - Expected return type from handler
	 * @param eventName - The event name
	 * @param payload - The event payload
	 * @param meta - Propagation metadata
	 * @param options - Emit options (delay, causationId)
	 * @returns EventSubscription for tracking result/errors
	 */
	public emit<TReturn = void>(
		eventName: string,
		payload: unknown,
		meta: PropagationMeta,
		options?: EmitOptions
	): EventSubscription<TReturn> {
		const subscription = createSubscription<TReturn>();

		// Check idempotency key - skip delivery if duplicate
		if (options?.idempotencyKey) {
			if (this.processedIdempotencyKeys.has(options.idempotencyKey)) {
				// Duplicate key - resolve with undefined (no delivery)
				subscription._resolve(undefined as TReturn);
				return subscription;
			}
			// Mark key as processed
			this.processedIdempotencyKeys.set(options.idempotencyKey, Date.now());
		}

		const message = this.createMessage(
			eventName,
			payload,
			meta,
			subscription.correlationId,
			options?.causationId
		);

		const delay = options?.delay;

		if (delay && delay > 0) {
			this.scheduleDelivery(message, subscription, delay, options?.idempotencyKey);
		} else {
			this.delivery.deliver(message, subscription);
		}

		return subscription;
	}

	/**
	 * Subscribes a handler to an event.
	 *
	 * @template TPayload - Expected payload type
	 * @template TReturn - Handler return type
	 * @param eventName - The event name to subscribe to
	 * @param handler - Handler function
	 */
	public subscribe<TPayload = unknown, TReturn = void>(
		eventName: string,
		handler: EventHandlerFn<TPayload, TReturn>
	): void {
		this.registry.subscribe(eventName, handler);
	}

	/**
	 * Starts the provider.
	 */
	public async start(): Promise<void> {
		this.started = true;
	}

	/**
	 * Stops the provider and clears pending timeouts.
	 */
	public async stop(): Promise<void> {
		for (const timeout of this.pendingTimeouts) {
			clearTimeout(timeout);
		}
		this.pendingTimeouts.clear();
		// Reject all pending delayed subscriptions before clearing
		for (const entry of this.pendingDelayedByKey.values()) {
			entry.subscription._reject(new Error('Event provider stopped'));
		}
		this.pendingDelayedByKey.clear();
		this.processedIdempotencyKeys.clear();
		if (this.idempotencyCleanupInterval) {
			clearInterval(this.idempotencyCleanupInterval);
			this.idempotencyCleanupInterval = null;
		}
		this.started = false;
	}

	/**
	 * Returns whether the provider has been started.
	 */
	public isStarted(): boolean {
		return this.started;
	}

	/**
	 * Returns the count of registered handlers for an event.
	 */
	public getHandlerCount(eventName: string): number {
		return this.registry.getHandlerCount(eventName);
	}

	/**
	 * Creates an EventMessage from emit parameters.
	 */
	private createMessage(
		eventName: string,
		payload: unknown,
		meta: PropagationMeta,
		correlationId: string,
		causationId?: string
	): EventMessage {
		return {
			version: EVENT_MESSAGE_VERSION,
			eventId: crypto.randomUUID(),
			eventName,
			payload,
			meta,
			correlationId,
			causationId,
			timestamp: Date.now()
		};
	}

	/**
	 * Cancels a pending delayed event by its key.
	 *
	 * @param _eventName - The event name (unused for in-process, key is globally unique)
	 * @param key - The idempotency key identifying the pending event
	 * @returns true if the event was found and cancelled, false otherwise
	 */
	public async cancel(_eventName: string, key: string): Promise<boolean> {
		const entry = this.pendingDelayedByKey.get(key);
		if (!entry) {
			return false;
		}
		clearTimeout(entry.timeout);
		this.pendingDelayedByKey.delete(key);
		this.pendingTimeouts.delete(entry.timeout);
		// Reject the pending subscription so callers don't hang
		entry.subscription._reject(new Error('Event cancelled'));
		// Remove idempotency key so the event can be re-emitted
		this.processedIdempotencyKeys.delete(key);
		return true;
	}

	/**
	 * Schedules delayed delivery of an event.
	 */
	private scheduleDelivery<TReturn>(
		message: EventMessage,
		subscription: EventSubscription<TReturn>,
		delay: number,
		key?: string
	): void {
		const timeout = setTimeout(() => {
			this.pendingTimeouts.delete(timeout);
			if (key) {
				this.pendingDelayedByKey.delete(key);
			}
			this.delivery.deliver(message, subscription);
		}, delay);
		this.pendingTimeouts.add(timeout);
		if (key) {
			this.pendingDelayedByKey.set(key, { timeout, subscription: subscription as EventSubscription<unknown> });
		}
	}
}
