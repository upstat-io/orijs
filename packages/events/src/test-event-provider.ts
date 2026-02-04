/**
 * Test Event Provider - Async event delivery with configurable delays.
 *
 * Unlike InProcessEventProvider which processes events on the next microtask,
 * TestEventProvider always uses setTimeout to simulate real queue processing.
 * This ensures async/await patterns are properly tested.
 *
 * Uses composition pattern for better testability:
 * - HandlerRegistry: manages subscriptions
 * - EventDeliveryEngine: handles execution
 *
 * @module events/test-event-provider
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
 * Configuration for TestEventProvider.
 */
export interface TestEventProviderConfig {
	/**
	 * Default processing delay in milliseconds.
	 * Simulates the time it takes for a queue to process an event.
	 * @default 10
	 */
	readonly processingDelay?: number;

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
}

/**
 * Test event provider with async timer-based delivery.
 *
 * This provider simulates real queue behavior by using setTimeout
 * for all event delivery, ensuring that:
 * - async/await patterns are properly tested
 * - Events are never resolved synchronously
 * - Processing delays can be configured
 *
 * Uses composition for better testability - you can inject mock
 * registry/delivery/logger for isolated testing.
 *
 * @example
 * ```ts
 * // Create with default 10ms delay
 * const provider = new TestEventProvider();
 *
 * // Create with custom delay
 * const slowProvider = new TestEventProvider({ processingDelay: 50 });
 *
 * provider.subscribe('user.created', async (msg) => {
 *   return { processed: true };
 * });
 *
 * // This will resolve after the processing delay
 * const result = await provider.emit<{ processed: boolean }>('user.created', {}, {});
 * ```
 */
export class TestEventProvider implements EventProvider {
	private readonly registry: IHandlerRegistry;
	private readonly delivery: IEventDelivery;
	private readonly pendingTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
	private readonly processingDelay: number;
	private started = false;

	/**
	 * Creates a new TestEventProvider.
	 *
	 * @param config - Configuration options
	 */
	public constructor(config: TestEventProviderConfig = {}) {
		this.processingDelay = config.processingDelay ?? 10;
		this.registry = config.registry ?? new HandlerRegistry();

		// Create delivery engine with injected or default components
		const log = config.log ?? new Logger('TestEventSystem');
		this.delivery =
			config.delivery ??
			new EventDeliveryEngine({
				registry: this.registry,
				log,
				createChainedEmit: createChainedEmitFactory(this.emit.bind(this))
			});
	}

	/**
	 * Emits an event to subscribers with timer-based async delivery.
	 *
	 * Unlike InProcessEventProvider, this ALWAYS uses setTimeout
	 * to ensure async patterns are properly tested.
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
		const message = this.createMessage(
			eventName,
			payload,
			meta,
			subscription.correlationId,
			options?.causationId
		);

		// Calculate total delay: emit delay + processing delay
		const emitDelay = options?.delay && options.delay > 0 ? options.delay : 0;
		const totalDelay = emitDelay + this.processingDelay;

		// Always use setTimeout - never synchronous
		this.scheduleDelivery(message, subscription, totalDelay);

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
	 * Returns the configured processing delay in milliseconds.
	 */
	public getProcessingDelay(): number {
		return this.processingDelay;
	}

	/**
	 * Returns the count of pending event deliveries.
	 * Useful for tests to verify events are in flight.
	 */
	public getPendingCount(): number {
		return this.pendingTimeouts.size;
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
	 * Schedules delayed delivery of an event.
	 */
	private scheduleDelivery<TReturn>(
		message: EventMessage,
		subscription: EventSubscription<TReturn>,
		delay: number
	): void {
		const timeout = setTimeout(() => {
			this.pendingTimeouts.delete(timeout);
			this.delivery.deliver(message, subscription);
		}, delay);
		this.pendingTimeouts.add(timeout);
	}
}
