/**
 * Handler Registry - Composable handler subscription management.
 *
 * Extracted from BaseOrchestrator to enable composition over inheritance.
 * Manages event handler subscriptions with O(1) lookup.
 *
 * @module events/handler-registry
 */

import type { EventHandlerFn } from './event-provider.types';

/**
 * Internal handler registration with type information.
 */
export interface HandlerRegistration {
	readonly handler: EventHandlerFn<unknown, unknown>;
}

/**
 * Interface for handler registry operations.
 */
export interface IHandlerRegistry {
	/**
	 * Registers a handler for an event.
	 */
	subscribe<TPayload = unknown, TReturn = void>(
		eventName: string,
		handler: EventHandlerFn<TPayload, TReturn>
	): void;

	/**
	 * Gets all handlers for an event.
	 */
	getHandlers(eventName: string): readonly HandlerRegistration[];

	/**
	 * Returns the count of registered handlers for an event.
	 */
	getHandlerCount(eventName: string): number;

	/**
	 * Clears all registered handlers.
	 */
	clear(): void;
}

/**
 * Default implementation of handler registry.
 *
 * Stores handlers in a Map for O(1) lookup by event name.
 *
 * @example
 * ```ts
 * const registry = new HandlerRegistry();
 * registry.subscribe('user.created', async (msg) => {
 *   console.log('User created:', msg.payload);
 * });
 *
 * const handlers = registry.getHandlers('user.created');
 * ```
 */
export class HandlerRegistry implements IHandlerRegistry {
	private readonly handlers: Map<string, HandlerRegistration[]> = new Map();

	/**
	 * Registers a handler for an event.
	 */
	public subscribe<TPayload = unknown, TReturn = void>(
		eventName: string,
		handler: EventHandlerFn<TPayload, TReturn>
	): void {
		const handlers = this.handlers.get(eventName) ?? [];
		handlers.push({ handler: handler as EventHandlerFn<unknown, unknown> });
		this.handlers.set(eventName, handlers);
	}

	/**
	 * Gets all handlers for an event.
	 */
	public getHandlers(eventName: string): readonly HandlerRegistration[] {
		return this.handlers.get(eventName) ?? [];
	}

	/**
	 * Returns the count of registered handlers for an event.
	 */
	public getHandlerCount(eventName: string): number {
		return this.handlers.get(eventName)?.length ?? 0;
	}

	/**
	 * Clears all registered handlers.
	 */
	public clear(): void {
		this.handlers.clear();
	}
}
