import type { Constructor, ConstructorDeps } from './types/index';
import type { EventProvider, EventMessage } from '@orijs/events';
import { InProcessEventProvider } from '@orijs/events';
import type { Logger } from '@orijs/logging';
import type { Container } from './container';
import type { EventDefinition, EventContext } from './types/event-definition';
import type { IEventConsumer } from './types/consumer';
import { Value } from '@orijs/validation';

/**
 * Pending event consumer registration (before bootstrap).
 */
interface PendingEventConsumer<TPayload = unknown, TResponse = unknown> {
	definition: EventDefinition<TPayload, TResponse>;
	consumerClass: Constructor<IEventConsumer<TPayload, TResponse>>;
	deps: Constructor[];
}

/**
 * Factory function for creating default event providers.
 * Allows injection of custom factory for testing.
 */
export type EventProviderFactory = () => EventProvider;

/**
 * Coordinates event system concerns.
 * Handles event definition registration, consumer instantiation, and lifecycle.
 *
 * The new definition-based API:
 * - Event definitions are registered with `registerEventDefinition()`
 * - Consumers are registered with `addEventConsumer()`
 * - On bootstrap, `registerConsumers()` instantiates consumers via DI
 */
export class EventCoordinator {
	/** The event provider (set via extension like addBullMQEvents) */
	private eventProvider: EventProvider | null = null;

	/** Registered event definitions (for emitter-only support and validation) */
	private eventDefinitions: Map<string, EventDefinition<unknown, unknown>> = new Map();

	/** Pending consumer registrations (processed during bootstrap) */
	private pendingConsumers: PendingEventConsumer[] = [];

	/** Event names that have registered consumers (populated after bootstrap) */
	private registeredConsumerEvents: Set<string> = new Set();

	constructor(
		private readonly container: Container,
		private readonly logger: Logger,
		private readonly defaultProviderFactory: EventProviderFactory = () => new InProcessEventProvider()
	) {}

	/**
	 * Sets the event provider for the application.
	 * Called by extension functions (e.g., addBullMQEvents).
	 */
	public setProvider(provider: EventProvider): void {
		if (this.eventProvider) {
			this.logger.warn('Event provider already set, replacing with new provider');
		}
		this.eventProvider = provider;
	}

	/**
	 * Returns the current event provider.
	 * Returns null if no provider is configured.
	 */
	public getProvider(): EventProvider | null {
		return this.eventProvider;
	}

	/**
	 * Registers an event definition for emission.
	 * This allows apps to emit events without needing a consumer.
	 */
	public registerEventDefinition<TPayload, TResponse>(
		definition: EventDefinition<TPayload, TResponse>
	): void {
		const eventName = definition.name;

		if (this.eventDefinitions.has(eventName)) {
			throw new Error(`Duplicate event registration: "${eventName}" is already registered`);
		}

		this.eventDefinitions.set(eventName, definition as EventDefinition<unknown, unknown>);
		this.logger.debug(`Event Definition Registered: ${eventName}`);
	}

	/**
	 * Adds a consumer for an event definition.
	 * Consumer will be instantiated during bootstrap via DI.
	 */
	public addEventConsumer<TPayload, TResponse>(
		definition: EventDefinition<TPayload, TResponse>,
		consumerClass: Constructor<IEventConsumer<TPayload, TResponse>>,
		deps: Constructor[]
	): void {
		this.pendingConsumers.push({
			definition: definition as EventDefinition<unknown, unknown>,
			consumerClass: consumerClass as Constructor<IEventConsumer<unknown, unknown>>,
			deps
		});
	}

	/**
	 * Instantiates all registered consumers via DI and wires them to the provider.
	 * Called during bootstrap after container is ready.
	 */
	public registerConsumers(): void {
		// Ensure provider exists (use default if not set via extension)
		if (!this.eventProvider) {
			if (this.pendingConsumers.length > 0 || this.eventDefinitions.size > 0) {
				this.logger.debug('No event provider configured, using InProcessEventProvider');
				this.eventProvider = this.defaultProviderFactory();
			} else {
				// No events configured at all - skip
				return;
			}
		}

		// Process pending consumers
		for (const { definition, consumerClass, deps } of this.pendingConsumers) {
			const eventName = definition.name;

			// Register consumer class with container
			this.container.register(consumerClass, deps as ConstructorDeps<typeof consumerClass>);
			const consumer = this.container.resolve<IEventConsumer<unknown, unknown>>(consumerClass);

			// Create wrapped handler with TypeBox validation
			const wrappedHandler = this.createValidatedHandler(definition, consumer);

			// Register with provider
			this.eventProvider.subscribe(eventName, wrappedHandler);

			// Track that this event has a consumer
			this.registeredConsumerEvents.add(eventName);

			this.logger.debug(`Event Consumer Registered: ${consumerClass.name} -> ${eventName}`);
		}

		this.pendingConsumers = [];
	}

	/**
	 * Creates a handler function that validates payload/response with TypeBox.
	 * The handler accepts EventMessage as per the EventProvider.subscribe signature.
	 */
	private createValidatedHandler<TPayload, TResponse>(
		definition: EventDefinition<TPayload, TResponse>,
		consumer: IEventConsumer<TPayload, TResponse>
	): (message: EventMessage<TPayload>) => Promise<TResponse> {
		return async (message: EventMessage<TPayload>): Promise<TResponse> => {
			const rawPayload = message.payload;

			// Validate payload against schema
			if (!Value.Check(definition.dataSchema, rawPayload)) {
				const errors = [...Value.Errors(definition.dataSchema, rawPayload)];
				const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
				throw new Error(`Event "${definition.name}" payload validation failed: ${errorDetails}`);
			}

			const payload = rawPayload as TPayload;

			// Create event context from EventMessage
			// Properties match the @orijs/events EventContext interface
			const ctx: EventContext<TPayload> = {
				eventId: message.eventId,
				data: payload,
				log: this.logger,
				eventName: message.eventName,
				timestamp: message.timestamp,
				correlationId: message.correlationId,
				causationId: message.causationId,
				emit: <TReturn = void>(
					eventName: string,
					eventPayload: unknown,
					options?: { delay?: number }
				): { wait: () => Promise<TReturn> } => {
					// Emit chained event with proper causation propagation:
					// - Same correlationId for end-to-end distributed tracing (from meta, not subscription ID)
					// - causationId = current eventId to track the event chain
					// Note: message.meta.correlationId is the tracing correlationId
					//       message.correlationId is the subscription ID for request-response
					const tracingCorrelationId = message.meta?.correlationId ?? message.correlationId;
					const subscription = this.eventProvider!.emit<TReturn>(
						eventName,
						eventPayload,
						{
							correlationId: tracingCorrelationId,
							causationId: message.eventId
						},
						{ delay: options?.delay, causationId: message.eventId }
					);
					return {
						wait: () => subscription.toPromise()
					};
				}
			};

			try {
				// Call consumer
				const response = await consumer.onEvent(ctx);

				// Validate response against schema
				if (!Value.Check(definition.resultSchema, response)) {
					const errors = [...Value.Errors(definition.resultSchema, response)];
					const errorDetails = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
					throw new Error(`Event "${definition.name}" response validation failed: ${errorDetails}`);
				}

				// Call success hook if defined
				if (consumer.onSuccess) {
					await consumer.onSuccess(ctx, response);
				}

				return response;
			} catch (error) {
				// Call error hook if defined
				if (consumer.onError) {
					const err = error instanceof Error ? error : new Error(String(error));
					await consumer.onError(ctx, err);
				}
				throw error;
			}
		};
	}

	/**
	 * Returns the event definition for a given name.
	 * Used by emitters to validate payloads before emission.
	 */
	public getEventDefinition(eventName: string): EventDefinition<unknown, unknown> | undefined {
		return this.eventDefinitions.get(eventName);
	}

	/**
	 * Returns whether a consumer is registered for the given event name.
	 * Useful for testing and debugging.
	 */
	public hasConsumer(eventName: string): boolean {
		return this.pendingConsumers.some((pc) => pc.definition.name === eventName);
	}

	/**
	 * Returns whether a consumer is registered for the given event name after bootstrap.
	 * This correctly distinguishes between events with definitions only vs events with consumers.
	 */
	public hasRegisteredConsumer(eventName: string): boolean {
		return this.registeredConsumerEvents.has(eventName);
	}

	/**
	 * Returns all registered event names.
	 */
	public getRegisteredEventNames(): string[] {
		return Array.from(this.eventDefinitions.keys());
	}

	/**
	 * Starts the event provider.
	 */
	public async start(): Promise<void> {
		if (this.eventProvider) {
			await this.eventProvider.start();
			this.logger.debug('Event Provider Started');
		}
	}

	/**
	 * Stops the event provider.
	 */
	public async stop(): Promise<void> {
		if (this.eventProvider) {
			await this.eventProvider.stop();
		}
	}

	/**
	 * Returns whether events are configured.
	 */
	public isConfigured(): boolean {
		return this.eventProvider !== null || this.eventDefinitions.size > 0;
	}
}
