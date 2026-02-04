/**
 * Event Provider Types - Interface Segregation for Event System.
 *
 * Splits interfaces by consumer vs framework concerns:
 * - EventEmitter: Consumer-facing (services see this)
 * - EventLifecycle: Framework-facing (application manages this)
 * - EventProvider: Implementation interface (providers implement this)
 *
 * @module events/event-provider.types
 */

import type { EventSubscription } from './event-subscription';
import type { PropagationMeta } from '@orijs/logging';

/** Current event message schema version */
export const EVENT_MESSAGE_VERSION = '1';

/**
 * Internal message structure for event transport.
 * Used by providers to pass events between emit and subscribe.
 */
export interface EventMessage<TPayload = unknown> {
	/** Schema version for detecting incompatible messages during upgrades */
	readonly version: string;
	/** Unique ID for this specific event instance (for idempotency) */
	readonly eventId: string;
	/** The event name */
	readonly eventName: string;
	/** The event payload data */
	readonly payload: TPayload;
	/** Propagation metadata for context */
	readonly meta: PropagationMeta;
	/** Unique ID for request-response correlation */
	readonly correlationId: string;
	/** ID of parent event (for event chain tracking) */
	readonly causationId?: string;
	/** Timestamp when event was emitted */
	readonly timestamp: number;
}

/**
 * Handler function for processing events.
 * Can return a value for request-response pattern, or void for fire-and-forget.
 *
 * @template TPayload - The event payload type
 * @template TReturn - The return type (void for fire-and-forget)
 */
export type EventHandlerFn<TPayload = unknown, TReturn = void> = (
	message: EventMessage<TPayload>
) => Promise<TReturn>;

/**
 * Options for event emission.
 */
export interface EmitOptions {
	/** Delay in milliseconds before event delivery */
	readonly delay?: number;
	/** Parent event ID for chain tracking */
	readonly causationId?: string;
	/** Timeout in milliseconds for request-response pattern (0 = no timeout) */
	readonly timeout?: number;
	/**
	 * Optional idempotency key for deduplication.
	 *
	 * When provided, the event provider uses this key to deduplicate event submissions.
	 * For BullMQ provider: becomes the jobId, and BullMQ ignores duplicate jobs with
	 * the same ID that already exist in the queue (pending, active, or waiting).
	 *
	 * Use cases:
	 * - Prevent duplicate processing when clients retry due to network timeouts
	 * - Ensure exactly-once event delivery semantics
	 *
	 * @example
	 * ```ts
	 * // Use a deterministic key based on the operation
	 * const idempotencyKey = `order-created-${orderId}`;
	 * events.emit('order.created', payload, meta, { idempotencyKey });
	 * ```
	 *
	 * Note: For BullMQ, the key must NOT contain colons `:` as BullMQ uses them as separators.
	 */
	readonly idempotencyKey?: string;
}

/**
 * Consumer-facing interface - what SERVICES see.
 *
 * Only emit and subscribe. NO lifecycle methods.
 * Services should never need to start/stop the event system.
 *
 * @template TEventNames - Union of valid event names (for type safety)
 */
export interface EventEmitter<TEventNames extends string = string> {
	/**
	 * Emits an event to subscribers.
	 *
	 * @template TReturn - Expected return type from handler (for request-response)
	 * @param eventName - The event name
	 * @param payload - The event payload
	 * @param meta - Propagation metadata
	 * @param options - Emit options (delay, causationId)
	 * @returns EventSubscription for tracking result/errors
	 */
	emit<TReturn = void>(
		eventName: TEventNames,
		payload: unknown,
		meta?: PropagationMeta,
		options?: EmitOptions
	): EventSubscription<TReturn>;

	/**
	 * Subscribes a handler to an event.
	 * Handler can return a value (routed to emit's EventSubscription).
	 *
	 * For distributed providers (BullMQ), await this to ensure the worker
	 * is ready before emitting events. For in-process providers, this
	 * resolves immediately.
	 *
	 * @template TPayload - Expected payload type
	 * @template TReturn - Handler return type
	 * @param eventName - The event name to subscribe to
	 * @param handler - Handler function
	 */
	subscribe<TPayload = unknown, TReturn = void>(
		eventName: TEventNames,
		handler: EventHandlerFn<TPayload, TReturn>
	): void | Promise<void>;
}

/**
 * Framework-facing interface - what ORIJS APPLICATION manages.
 *
 * Hooks into OriJS lifecycle (onStartup, onShutdown).
 * Services should never call these directly.
 */
export interface EventLifecycle {
	/**
	 * Starts the provider (connects to queues, etc.).
	 * Called by OriJS during application startup.
	 */
	start(): Promise<void>;

	/**
	 * Stops the provider gracefully.
	 * Called by OriJS during application shutdown.
	 * Waits for in-flight events to complete.
	 */
	stop(): Promise<void>;
}

/**
 * Full provider interface - what IMPLEMENTATIONS provide.
 *
 * Extends both EventEmitter and EventLifecycle.
 * Implementations (InProcessEventProvider, BullMQEventProvider) implement this.
 *
 * @template TEventNames - Union of valid event names (for type safety)
 */
export interface EventProvider<TEventNames extends string = string>
	extends EventEmitter<TEventNames>, EventLifecycle {}
