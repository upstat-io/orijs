/**
 * Event Context - Context passed to event handlers.
 *
 * Provides handlers with:
 * - Typed event payload
 * - Logger with propagated context
 * - Event system for emitting chained events
 * - Correlation/causation IDs for tracing
 *
 * @module events/event-context
 */

import { Logger, type PropagationMeta } from '@orijs/logging';
import type { EventMessage } from './event-provider.types';
import type { EventSubscription } from './event-subscription';

/**
 * Emit function type for event context.
 * Allows handlers to emit additional events with proper context propagation.
 */
export type EventEmitFn<TEventNames extends string = string> = <TReturn = void>(
	eventName: TEventNames,
	payload: unknown,
	options?: { delay?: number }
) => EventSubscription<TReturn>;

/**
 * Context passed to event handlers.
 *
 * Provides access to:
 * - `data`: The typed event payload
 * - `log`: Logger with propagated correlationId/context
 * - `emit`: Function to emit chained events (with causationId auto-set)
 * - `correlationId`: Unique ID for request-response correlation
 * - `causationId`: ID of parent event (for chain tracking)
 *
 * @template TPayload - The type of the event payload
 * @template TEventNames - Union of valid event names
 *
 * @example
 * ```ts
 * .onEvent('order.placed', async (ctx) => {
 *   ctx.log.info('Processing order', { orderId: ctx.data.orderId });
 *
 *   // Emit chained event - causationId automatically set
 *   ctx.emit('inventory.reserve', { items: ctx.data.items });
 *
 *   return { status: 'processed' };
 * });
 * ```
 */
export interface EventContext<TPayload = unknown, TEventNames extends string = string> {
	/** Unique ID for this specific event instance (for idempotency) */
	readonly eventId: string;
	/** The event payload data */
	readonly data: TPayload;
	/** Logger with propagated context (correlationId, etc.) */
	readonly log: Logger;
	/** Emit function for chained events (causationId auto-set) */
	readonly emit: EventEmitFn<TEventNames>;
	/** Unique ID for request-response correlation */
	readonly correlationId: string;
	/** ID of parent event (for event chain tracking) */
	readonly causationId?: string;
	/** The event name being handled */
	readonly eventName: string;
	/** Timestamp when event was emitted */
	readonly timestamp: number;
}

/**
 * Options for creating an event context.
 */
export interface CreateEventContextOptions<TEventNames extends string = string> {
	/** The event message */
	message: EventMessage;
	/** Function to emit chained events */
	emitFn: EventEmitFn<TEventNames>;
	/** Optional logger name override */
	loggerName?: string;
}

/**
 * Creates an EventContext from an EventMessage.
 *
 * The logger is created using Logger.fromMeta() to preserve
 * correlationId and other propagated context from the original request.
 *
 * @template TPayload - Expected payload type
 * @template TEventNames - Valid event names
 * @param options - Context creation options
 * @returns EventContext for the handler
 */
export function createEventContext<TPayload = unknown, TEventNames extends string = string>(
	options: CreateEventContextOptions<TEventNames>
): EventContext<TPayload, TEventNames> {
	const { message, emitFn, loggerName } = options;

	// Create logger with propagated context
	const log = Logger.fromMeta(loggerName ?? `Event:${message.eventName}`, message.meta);

	return Object.freeze({
		eventId: message.eventId,
		data: message.payload as TPayload,
		log,
		emit: emitFn,
		correlationId: message.correlationId,
		causationId: message.causationId,
		eventName: message.eventName,
		timestamp: message.timestamp
	});
}

/**
 * Creates propagation metadata from an event context.
 * Used when emitting chained events to preserve context.
 *
 * @param ctx - The current event context
 * @param correlationId - New correlation ID for the chained event
 * @returns PropagationMeta for the chained event
 */
export function createChainedMeta(
	parentMeta: PropagationMeta,
	parentCorrelationId: string
): { meta: PropagationMeta; causationId: string } {
	return {
		meta: parentMeta,
		causationId: parentCorrelationId
	};
}
