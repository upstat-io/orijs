/**
 * Event Registry Types
 *
 * Type definitions for the EventRegistry fluent builder.
 * Provides compile-time type safety for event names.
 *
 * Key concepts:
 * - Events are registered by name only
 * - Accumulating generics track registered event names at compile time
 * - Registry is frozen after build (immutable)
 * - Payload types are defined separately via TypeScript interfaces
 */

// --- BUILDER INTERFACE ---

/**
 * Fluent builder interface for constructing an event registry.
 *
 * Use `EventRegistry.create()` to start building, then chain
 * `.event()` and `.use()` calls before `.build()`.
 *
 * @template TEventNames - Union of registered event names (accumulates)
 *
 * @example
 * ```typescript
 * const registry = EventRegistry.create()
 *   .event('user.created')
 *   .event('order.placed')
 *   .use(addAlertEvents)
 *   .build();
 * ```
 */
export interface EventRegistryBuilder<TEventNames extends string = never> {
	/**
	 * Register a new event by name.
	 *
	 * @param name - Unique name for this event (e.g., 'user.created')
	 * @returns Builder with event added
	 *
	 * @example
	 * .event('user.created')
	 * .event('order.placed')
	 */
	event<N extends string>(name: N): EventRegistryBuilder<TEventNames | N>;

	/**
	 * Apply a composition function to add multiple events.
	 *
	 * Enables modular organization of event definitions.
	 * The function receives the current builder and returns a new builder.
	 *
	 * @param fn - Function that adds events and returns the builder
	 * @returns Builder with events added by the function
	 *
	 * @example
	 * function addUserEvents<T extends string>(
	 *   reg: EventRegistryBuilder<T>
	 * ): EventRegistryBuilder<T | 'user.created' | 'user.deleted'> {
	 *   return reg
	 *     .event('user.created')
	 *     .event('user.deleted');
	 * }
	 *
	 * EventRegistry.create()
	 *   .use(addUserEvents)
	 *   .use(addOrderEvents)
	 *   .build();
	 */
	use<TNewNames extends string>(
		fn: (builder: EventRegistryBuilder<TEventNames>) => EventRegistryBuilder<TNewNames>
	): EventRegistryBuilder<TNewNames>;

	/**
	 * Build the final immutable event registry.
	 *
	 * @returns Frozen registry with lookup methods
	 */
	build(): BuiltEventRegistry<TEventNames>;
}

// --- BUILT REGISTRY INTERFACE ---

/**
 * A built, immutable event registry.
 *
 * Provides type-safe lookups for event names.
 * All data is frozen after build - cannot be modified.
 *
 * @template TEventNames - Union of valid event names
 *
 * @example
 * ```typescript
 * const registry = EventRegistry.create()
 *   .event('user.created')
 *   .build();
 *
 * registry.getEventNames(); // ['user.created']
 * registry.hasEvent('user.created'); // true
 * registry.hasEvent('invalid'); // false (but type-safe version would error)
 * ```
 */
export interface BuiltEventRegistry<TEventNames extends string = string> {
	/**
	 * Get all registered event names.
	 *
	 * @returns Array of event names
	 */
	getEventNames(): readonly TEventNames[];

	/**
	 * Check if an event exists in the registry.
	 *
	 * @param name - Event name to check
	 * @returns True if the event exists, false otherwise
	 */
	hasEvent(name: string): name is TEventNames;
}
