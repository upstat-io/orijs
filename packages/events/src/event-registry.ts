/**
 * Event Registry
 *
 * Fluent builder for defining event names with compile-time type safety.
 * Produces a frozen, type-safe registry for event systems to consume.
 *
 * Key features:
 * - Type-safe event name registration
 * - Modular composition via .use() pattern
 * - Frozen (immutable) after build
 * - Full compile-time type safety for event names
 *
 * ## Event Naming Conventions
 *
 * Follow these conventions when defining events:
 *
 * ### Format
 * `<entity>.<action>` in **past tense**
 *
 * ### Good Examples
 * - `user.created` - User was created
 * - `order.placed` - Order was placed
 * - `payment.processed` - Payment was processed
 * - `task.status.failed` - Task status changed to failed
 *
 * ### Bad Examples (Avoid)
 * - `createUser` - Imperative, not past tense
 * - `user-created` - Use dot separator, not hyphen
 * - `userCreated` - Use lowercase with dots
 * - `USER_CREATED` - Not SCREAMING_SNAKE_CASE
 * - `handleUserCreation` - Avoid "handle", "process", "do"
 *
 * ### Multi-Level Events
 * Use dots for hierarchical grouping:
 * - `order.status.changed`
 * - `order.status.completed`
 * - `task.execution.finished`
 * - `notification.email.sent`
 *
 * ### Best Practices
 * 1. **Past tense** - Describes something that already happened
 * 2. **Entity first** - `user.created` not `created.user`
 * 3. **Granular events** - `order.placed` + `order.shipped` not `order.changed`
 * 4. **Noun entities** - `user`, `order`, `payment`, `task`
 * 5. **Verb actions** - `created`, `updated`, `deleted`, `failed`
 *
 * @example
 * ```typescript
 * const registry = EventRegistry.create()
 *   .event('user.created')
 *   .event('order.placed')
 *   .use(addAlertEvents)
 *   .build();
 *
 * registry.getEventNames(); // ['user.created', 'order.placed', ...]
 * registry.hasEvent('user.created'); // true
 * ```
 */

import type { EventRegistryBuilder, BuiltEventRegistry } from './event-registry.types';

// --- BUILDER IMPLEMENTATION ---

/**
 * Internal builder implementation.
 * Accumulates event names, then builds the final registry.
 */
class EventRegistryBuilderInternal<
	TEventNames extends string = never
> implements EventRegistryBuilder<TEventNames> {
	/** Accumulated event names */
	private readonly eventNames: Set<string> = new Set();

	/**
	 * Register a new event by name.
	 */
	public event<N extends string>(name: N): EventRegistryBuilder<TEventNames | N> {
		// Check for duplicate event
		if (this.eventNames.has(name)) {
			throw new Error(`Event '${name}' already defined`);
		}

		this.eventNames.add(name);

		// Type assertion is safe: same builder instance returned with expanded type params.
		// Standard TypeScript pattern for fluent builders with accumulating generics.
		return this as unknown as EventRegistryBuilder<TEventNames | N>;
	}

	/**
	 * Apply a composition function to add multiple events.
	 */
	public use<TNewNames extends string>(
		fn: (builder: EventRegistryBuilder<TEventNames>) => EventRegistryBuilder<TNewNames>
	): EventRegistryBuilder<TNewNames> {
		return fn(this);
	}

	/**
	 * Build the final immutable event registry.
	 */
	public build(): BuiltEventRegistry<TEventNames> {
		// Copy set for immutability (original builder can continue to be used)
		const eventSet = new Set(this.eventNames);

		// Freeze the event names array
		const eventNames = Object.freeze(Array.from(eventSet)) as readonly TEventNames[];

		// Create the registry object with closure over the set
		const registry: BuiltEventRegistry<TEventNames> = {
			getEventNames(): readonly TEventNames[] {
				return eventNames;
			},

			hasEvent(name: string): name is TEventNames {
				return eventSet.has(name);
			}
		};

		return Object.freeze(registry);
	}
}

// --- PUBLIC FACTORY ---

/**
 * Factory for creating event registries.
 *
 * Use `EventRegistry.create()` to start building a new registry.
 *
 * @example
 * ```typescript
 * const registry = EventRegistry.create()
 *   .event('user.created')
 *   .event('user.deleted')
 *   .build();
 *
 * // Type-safe: 'user.created' | 'user.deleted'
 * registry.getEventNames();
 * registry.hasEvent('user.created'); // true
 * ```
 */
export const EventRegistry = {
	/**
	 * Create a new event registry builder.
	 *
	 * @returns A new builder instance
	 */
	create(): EventRegistryBuilder<never> {
		return new EventRegistryBuilderInternal();
	}
};
