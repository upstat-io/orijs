/**
 * Event Handler Builder - Builder for registering event handlers.
 *
 * Provides a fluent API for handler classes to register their
 * event handlers, similar to how controllers use RouteBuilder.
 *
 * @module events/event-handler-builder
 */

import type { EventContext, EventEmitFn } from './event-context';
import type { EventProvider, EventMessage } from './event-provider.types';
import { createEventContext, createChainedMeta } from './event-context';

/**
 * Event handler function type.
 *
 * @template TPayload - The event payload type
 * @template TReturn - The return type (void for fire-and-forget)
 */
export type EventHandler<TPayload = unknown, TReturn = void> = (
	ctx: EventContext<TPayload>
) => Promise<TReturn>;

/**
 * Interface for building event handler registrations.
 *
 * Used by handler classes in their configure() method.
 *
 * @template TEventNames - Union of valid event names from registry
 *
 * @example
 * ```ts
 * class OrderEventHandler {
 *   configure(e: EventBuilder<OrderEventNames>) {
 *     e.on('order.placed', this.handleOrderPlaced);
 *     e.on('order.shipped', this.handleOrderShipped);
 *   }
 *
 *   private handleOrderPlaced = async (ctx: EventContext<OrderPayload>) => {
 *     // Handle event...
 *   };
 * }
 * ```
 */
export interface EventBuilder<TEventNames extends string = string> {
	/**
	 * Registers a handler for an event.
	 *
	 * @template TPayload - The expected payload type
	 * @template TReturn - The return type
	 * @param eventName - The event name to handle
	 * @param handler - The handler function
	 */
	on<TPayload = unknown, TReturn = void>(
		eventName: TEventNames,
		handler: EventHandler<TPayload, TReturn>
	): void;
}

/**
 * Internal handler registration used by EventHandlerBuilder.
 */
export interface HandlerRegistration<TEventNames extends string = string> {
	readonly eventName: TEventNames;
	readonly handler: EventHandler<unknown, unknown>;
}

/**
 * Implementation of EventBuilder that collects handler registrations.
 *
 * @template TEventNames - Union of valid event names
 */
export class EventHandlerBuilder<TEventNames extends string = string> implements EventBuilder<TEventNames> {
	private readonly registrations: HandlerRegistration<TEventNames>[] = [];

	/**
	 * Registers a handler for an event.
	 */
	public on<TPayload = unknown, TReturn = void>(
		eventName: TEventNames,
		handler: EventHandler<TPayload, TReturn>
	): void {
		this.registrations.push({
			eventName,
			handler: handler as EventHandler<unknown, unknown>
		});
	}

	/**
	 * Returns all registered handlers.
	 */
	public getRegistrations(): readonly HandlerRegistration<TEventNames>[] {
		return this.registrations;
	}

	/**
	 * Registers all handlers with a provider.
	 *
	 * @param provider - The event provider to register with
	 * @param emitFn - Function to emit events (for context)
	 */
	public registerWith(
		provider: EventProvider,
		emitFn: (
			eventName: TEventNames,
			payload: unknown,
			options?: { delay?: number; causationId?: string }
		) => ReturnType<EventProvider['emit']>
	): void {
		for (const { eventName, handler } of this.registrations) {
			const wrappedHandler = this.createWrappedHandler(handler, emitFn);
			provider.subscribe(eventName, wrappedHandler);
		}
	}

	/**
	 * Creates a wrapped handler that provides EventContext instead of raw message.
	 *
	 * @param handler - The original handler function
	 * @param emitFn - Function to emit events (for context)
	 * @returns Wrapped handler that accepts EventMessage
	 */
	private createWrappedHandler(
		handler: EventHandler<unknown, unknown>,
		emitFn: (
			eventName: TEventNames,
			payload: unknown,
			options?: { delay?: number; causationId?: string }
		) => ReturnType<EventProvider['emit']>
	): (message: EventMessage) => Promise<unknown> {
		return async (message: EventMessage) => {
			const chainedEmitFn = this.createChainedEmitFn(message, emitFn);
			// TEventNames defaults to 'string' in both createEventContext and EventContext,
			// so types align without explicit assertion
			const ctx = createEventContext<unknown>({
				message,
				emitFn: chainedEmitFn
			});
			return handler(ctx);
		};
	}

	/**
	 * Creates an emit function for chained events that preserves correlation context.
	 *
	 * @param message - The original event message (for correlation)
	 * @param emitFn - The base emit function
	 * @returns Emit function with chained metadata
	 */
	private createChainedEmitFn(
		message: EventMessage,
		emitFn: (
			eventName: TEventNames,
			payload: unknown,
			options?: { delay?: number; causationId?: string }
		) => ReturnType<EventProvider['emit']>
	): EventEmitFn<string> {
		return ((chainedEventName: string, payload: unknown, options?: { delay?: number }) => {
			const { causationId } = createChainedMeta(message.meta, message.correlationId);
			return emitFn(chainedEventName as TEventNames, payload, {
				...options,
				causationId
			});
		}) as EventEmitFn<string>;
	}
}

/**
 * Interface for event handler classes.
 *
 * Handler classes use the configure() method to register their handlers,
 * similar to how controllers configure their routes.
 *
 * @template TEventNames - Union of valid event names
 */
export interface EventHandlerClass<TEventNames extends string = string> {
	configure(builder: EventBuilder<TEventNames>): void;
}
