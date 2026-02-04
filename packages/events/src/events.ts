/**
 * Events - Main facade for the OriJS event system.
 *
 * Creates an event system bound to a registry, providing type-safe
 * emit and subscribe functions.
 *
 * @module events/events
 */

import type { BuiltEventRegistry } from './event-registry.types';
import type { EventProvider } from './event-provider.types';
import type { EventSubscription } from './event-subscription';
import { InProcessEventProvider } from './in-process-orchestrator';
import { EventHandlerBuilder, type EventHandler, type EventBuilder } from './event-handler-builder';
import { capturePropagationMeta, type PropagationMeta } from '@orijs/logging';

/**
 * Type-safe emit function bound to a registry.
 *
 * This is a callable interface for the emit function used by EventSystem.
 * Not to be confused with EventEmitter from event-provider.types.ts which
 * is the consumer-facing ISP interface (emit + subscribe).
 *
 * @template TEventNames - Union of valid event names
 */
export interface TypedEmitFn<TEventNames extends string> {
	/**
	 * Emits an event.
	 *
	 * @template TReturn - Expected return type from handler
	 * @param eventName - The event name (type-checked)
	 * @param payload - The event payload
	 * @param options - Emit options (delay, causationId for event chains)
	 * @returns EventSubscription for request-response
	 */
	<TReturn = void>(
		eventName: TEventNames,
		payload: unknown,
		options?: { delay?: number; causationId?: string }
	): EventSubscription<TReturn>;
}

/**
 * Type-safe event system bound to a registry.
 *
 * @template TEventNames - Union of valid event names
 */
export interface EventSystem<TEventNames extends string = string> {
	/** Type-safe emit function */
	readonly emit: TypedEmitFn<TEventNames>;
	/** The underlying event provider */
	readonly provider: EventProvider;
	/** The event registry */
	readonly registry: BuiltEventRegistry<TEventNames>;

	/**
	 * Registers a handler for an event.
	 *
	 * @template TPayload - Expected payload type
	 * @template TReturn - Handler return type
	 * @param eventName - The event name
	 * @param handler - Handler function
	 */
	onEvent<TPayload = unknown, TReturn = void>(
		eventName: TEventNames,
		handler: EventHandler<TPayload, TReturn>
	): void;

	/**
	 * Creates a handler builder for class-based handlers.
	 *
	 * @returns EventBuilder for handler registration
	 */
	createBuilder(): EventBuilder<TEventNames>;

	/**
	 * Starts the event system.
	 */
	start(): Promise<void>;

	/**
	 * Stops the event system.
	 */
	stop(): Promise<void>;
}

/**
 * Options for creating an event system.
 */
export interface CreateEventSystemOptions {
	/** Custom event provider (default: InProcessEventProvider) */
	provider?: EventProvider;
	/** Default propagation metadata */
	defaultMeta?: PropagationMeta;
}

/**
 * Creates a type-safe event system bound to a registry.
 *
 * @template TEventNames - Union of valid event names (inferred from registry)
 * @param registry - The event registry
 * @param options - Creation options
 * @returns Type-safe EventSystem
 *
 * @example
 * ```ts
 * const Events = EventRegistry.create()
 *   .event<UserPayload>('user.created')
 *   .event<OrderPayload>('order.placed')
 *   .build();
 *
 * const events = createEventSystem(Events);
 *
 * // Type-safe emit
 * events.emit('user.created', { id: 1, name: 'Alice' });
 *
 * // Type-safe handler
 * events.onEvent<UserPayload>('user.created', async (ctx) => {
 *   console.log('User:', ctx.data.name);
 * });
 *
 * await events.start();
 * ```
 */
export function createEventSystem<TEventNames extends string>(
	registry: BuiltEventRegistry<TEventNames>,
	options?: CreateEventSystemOptions
): EventSystem<TEventNames> {
	const provider = options?.provider ?? new InProcessEventProvider();
	const defaultMeta = options?.defaultMeta ?? {};

	// Track propagation metadata (can be updated per-request)
	let currentMeta: PropagationMeta = defaultMeta;

	/**
	 * Type-safe emit function.
	 * Automatically propagates trace context from AsyncLocalStorage.
	 */
	const emit: TypedEmitFn<TEventNames> = <TReturn = void>(
		eventName: TEventNames,
		payload: unknown,
		emitOptions?: { delay?: number; causationId?: string }
	): EventSubscription<TReturn> => {
		// Validate event name against registry
		if (!registry.hasEvent(eventName)) {
			throw new Error(`Unknown event: ${eventName}`);
		}

		// Capture context from AsyncLocalStorage (shared across all OriJS systems)
		const capturedMeta = capturePropagationMeta();
		const meta: PropagationMeta = { ...currentMeta, ...capturedMeta };

		return provider.emit<TReturn>(eventName, payload, meta, emitOptions);
	};

	/**
	 * Registers a handler for an event.
	 */
	const onEvent = <TPayload = unknown, TReturn = void>(
		eventName: TEventNames,
		handler: EventHandler<TPayload, TReturn>
	): void => {
		// Validate event name against registry
		if (!registry.hasEvent(eventName)) {
			throw new Error(`Unknown event: ${eventName}`);
		}

		const builder = new EventHandlerBuilder<TEventNames>();
		builder.on(eventName, handler);
		builder.registerWith(provider, emit);
	};

	/**
	 * Creates a handler builder.
	 */
	const createBuilder = (): EventBuilder<TEventNames> => {
		const builder = new EventHandlerBuilder<TEventNames>();
		return builder;
	};

	return {
		emit,
		provider,
		registry,
		onEvent,
		createBuilder,
		start: () => provider.start(),
		stop: () => provider.stop()
	};
}

/**
 * Creates propagation metadata for use with emit.
 * Typically called from a request context to propagate request ID.
 *
 * @param correlationId - The request ID to propagate
 * @param additional - Additional metadata to propagate
 * @returns PropagationMeta object
 */
export function createPropagationMeta(
	correlationId?: string,
	additional?: Record<string, unknown>
): PropagationMeta {
	return {
		correlationId,
		...additional
	};
}
