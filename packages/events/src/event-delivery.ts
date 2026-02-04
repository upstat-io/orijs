/**
 * Event Delivery Engine - Composable event execution logic.
 *
 * Extracted from BaseOrchestrator to enable composition over inheritance.
 * Handles event delivery to handlers and subscription resolution.
 *
 * @module events/event-delivery
 */

import type { EventMessage, EmitOptions } from './event-provider.types';
import type { PropagationMeta } from '@orijs/logging';
import type { EventSubscription } from './event-subscription';
import type { HandlerRegistration, IHandlerRegistry } from './handler-registry';
import { createChainedMeta } from './event-context';

/**
 * Minimal logger interface for event delivery error logging.
 */
export interface EventDeliveryLogger {
	error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Emit function type for chained events.
 */
export type ChainedEmitFn = <TChainReturn = void>(
	eventName: string,
	payload: unknown,
	options?: { delay?: number }
) => EventSubscription<TChainReturn>;

/**
 * Function that creates chained emit function for event chaining.
 */
export type CreateChainedEmitFn = (message: EventMessage) => ChainedEmitFn;

/**
 * Configuration for EventDeliveryEngine.
 */
export interface EventDeliveryConfig {
	/**
	 * Handler registry to get handlers from.
	 */
	readonly registry: IHandlerRegistry;

	/**
	 * Logger for error reporting.
	 */
	readonly log: EventDeliveryLogger;

	/**
	 * Function to create chained emit function for event chaining.
	 */
	readonly createChainedEmit: CreateChainedEmitFn;
}

/**
 * Interface for event delivery operations.
 */
export interface IEventDelivery {
	/**
	 * Delivers an event to registered handlers.
	 */
	deliver<TReturn>(message: EventMessage, subscription: EventSubscription<TReturn>): void;
}

/**
 * Default implementation of event delivery engine.
 *
 * Executes event handlers asynchronously:
 * - First handler's return value resolves the subscription (request-response)
 * - All handlers are called for fire-and-forget pattern
 * - Errors are logged for fire-and-forget, propagated for request-response
 *
 * @example
 * ```ts
 * const delivery = new EventDeliveryEngine({
 *   registry: handlerRegistry,
 *   log: logger,
 *   createChainedEmit: (msg) => (name, payload, opts) => provider.emit(name, payload, meta, opts),
 * });
 *
 * delivery.deliver(message, subscription);
 * ```
 */
export class EventDeliveryEngine implements IEventDelivery {
	private readonly registry: IHandlerRegistry;
	private readonly log: EventDeliveryLogger;
	private readonly createChainedEmit: CreateChainedEmitFn;

	public constructor(config: EventDeliveryConfig) {
		this.registry = config.registry;
		this.log = config.log;
		this.createChainedEmit = config.createChainedEmit;
	}

	/**
	 * Delivers an event to registered handlers.
	 *
	 * First handler's return value resolves the subscription (request-response).
	 * All handlers are called for fire-and-forget pattern.
	 */
	public deliver<TReturn>(message: EventMessage, subscription: EventSubscription<TReturn>): void {
		const handlers = this.registry.getHandlers(message.eventName);

		if (handlers.length === 0) {
			// No handlers - subscription stays unresolved (fire-and-forget)
			return;
		}

		const emitFn = this.createChainedEmit(message);

		// Execute first handler and capture return value (request-response)
		const firstHandler = handlers[0]!;
		this.executeHandler(firstHandler.handler, message, emitFn, subscription);

		// Execute remaining handlers (fire-and-forget - ignore return values)
		for (let i = 1; i < handlers.length; i++) {
			const handler = handlers[i]!;
			this.executeHandler(handler.handler, message, emitFn, null);
		}
	}

	/**
	 * Executes a single handler and optionally resolves the subscription.
	 *
	 * Note: Handler receives EventMessage for low-level provider usage.
	 * High-level EventSystem wraps handlers to receive EventContext.
	 */
	private executeHandler<TReturn>(
		handler: HandlerRegistration['handler'],
		message: EventMessage,
		_emitFn: ChainedEmitFn,
		subscription: EventSubscription<TReturn> | null
	): void {
		// Execute async - don't block
		Promise.resolve()
			.then(async () => {
				const result = await handler(message);
				if (subscription) {
					subscription._resolve(result as TReturn);
				}
			})
			.catch((error: Error) => {
				if (!subscription) {
					// Log error for fire-and-forget handlers with full context for debugging
					this.log.error('Fire-and-forget handler error', {
						eventName: message.eventName,
						eventId: message.eventId,
						correlationId: message.correlationId,
						causationId: message.causationId,
						error: error.message,
						stack: error.stack
					});
				}
				if (subscription) {
					subscription._reject(error);
				}
			});
	}
}

/**
 * Creates a chained emit function factory for use with EventDeliveryEngine.
 *
 * @param emitFn - The provider's emit function
 * @returns Factory that creates chained emit functions from messages
 */
export function createChainedEmitFactory(
	emitFn: <TReturn = void>(
		eventName: string,
		payload: unknown,
		meta: PropagationMeta,
		options?: EmitOptions
	) => EventSubscription<TReturn>
): CreateChainedEmitFn {
	return (message: EventMessage): ChainedEmitFn => {
		return <TChainReturn = void>(
			eventName: string,
			payload: unknown,
			options?: { delay?: number }
		): EventSubscription<TChainReturn> => {
			const { meta, causationId } = createChainedMeta(message.meta, message.correlationId);
			return emitFn(eventName, payload, meta, {
				...options,
				causationId
			});
		};
	};
}
