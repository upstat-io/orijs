import { describe, it, expect, beforeEach } from 'bun:test';
import { EventCoordinator } from '../src/event-coordinator.ts';
import { Container } from '../src/container.ts';
import { Logger } from '@orijs/logging';
import { Event } from '../src/types/event-definition.ts';
import { Type } from '@orijs/validation';
import type { IEventConsumer, EventContext } from '../src/types/consumer.ts';
import type { EventProvider, EventSubscription as EventSub } from '@orijs/events';

describe('EventCoordinator', () => {
	let container: Container;
	let logger: Logger;

	beforeEach(() => {
		container = new Container();
		logger = new Logger('test');
	});

	// Test event definition
	const TestEvent = Event.define({
		name: 'test.event',
		data: Type.Object({ message: Type.String() }),
		result: Type.Object({ received: Type.Boolean() })
	});

	// Test consumer class
	class TestEventConsumer implements IEventConsumer<
		(typeof TestEvent)['_data'],
		(typeof TestEvent)['_result']
	> {
		onEvent = async (_ctx: EventContext<(typeof TestEvent)['_data']>) => {
			return { received: true };
		};
	}

	// Helper to create a minimal mock provider
	const createMockProvider = (_overrides: Partial<EventProvider> = {}): EventProvider =>
		({
			start: async () => {},
			stop: async () => {},
			emit: () => ({}) as EventSub<any>,
			subscribe: () => {}
		}) as unknown as EventProvider;

	describe('Provider Factory Injection', () => {
		it('should use injected provider factory when registering consumers', () => {
			let factoryCalled = false;
			const mockProvider = createMockProvider();

			const customFactory = () => {
				factoryCalled = true;
				return mockProvider;
			};

			const coordinator = new EventCoordinator(container, logger, customFactory);

			// Register an event definition with consumer
			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);

			// Factory is called during registerConsumers
			coordinator.registerConsumers();

			expect(factoryCalled).toBe(true);
		});

		it('should NOT use factory when explicit provider is set', () => {
			let factoryCalled = false;
			const explicitProvider = createMockProvider();

			const customFactory = () => {
				factoryCalled = true;
				return createMockProvider();
			};

			const coordinator = new EventCoordinator(container, logger, customFactory);

			// Set provider explicitly BEFORE registering consumers
			coordinator.setProvider(explicitProvider);
			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);
			coordinator.registerConsumers();

			expect(factoryCalled).toBe(false);
			expect(coordinator.getProvider()).toBe(explicitProvider);
		});

		it('should use default InProcessEventProvider when no factory is injected', async () => {
			const coordinator = new EventCoordinator(container, logger);

			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);
			coordinator.registerConsumers();

			expect(coordinator.isConfigured()).toBe(true);
			expect(coordinator.getProvider()).not.toBeNull();

			await coordinator.start();
			await coordinator.stop();
		});
	});

	describe('Provider Lifecycle Error Handling', () => {
		it('should propagate provider.start() errors', async () => {
			// Create mock provider directly without helper to ensure override works
			const mockProvider: EventProvider = {
				start: async () => {
					throw new Error('Provider start failed');
				},
				stop: async () => {},
				emit: () => ({}) as EventSub<any>,
				subscribe: () => {}
			};

			const coordinator = new EventCoordinator(container, logger, () => mockProvider);
			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);
			coordinator.registerConsumers();

			await expect(coordinator.start()).rejects.toThrow('Provider start failed');
		});

		it('should propagate provider.stop() errors', async () => {
			let started = false;
			// Create mock provider directly without helper to ensure override works
			const mockProvider: EventProvider = {
				start: async () => {
					started = true;
				},
				stop: async () => {
					throw new Error('Provider stop failed');
				},
				emit: () => ({}) as EventSub<any>,
				subscribe: () => {}
			};

			const coordinator = new EventCoordinator(container, logger, () => mockProvider);
			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();
			expect(started).toBe(true);

			await expect(coordinator.stop()).rejects.toThrow('Provider stop failed');
		});

		it('should handle start() gracefully when no event system is configured', async () => {
			const coordinator = new EventCoordinator(container, logger);

			// Should not throw - just no-op
			await coordinator.start();
			expect(coordinator.isConfigured()).toBe(false);
		});

		it('should handle stop() gracefully when no event system is configured', async () => {
			const coordinator = new EventCoordinator(container, logger);

			// Should not throw - just no-op
			await coordinator.stop();
			expect(coordinator.isConfigured()).toBe(false);
		});
	});

	describe('Event Definition Registration', () => {
		it('should register event definition', () => {
			const coordinator = new EventCoordinator(container, logger);

			coordinator.registerEventDefinition(TestEvent);

			expect(coordinator.getEventDefinition('test.event')).toBeDefined();
			expect(coordinator.getEventDefinition('test.event')?.name).toBe('test.event');
		});

		it('should throw on duplicate event registration', () => {
			const coordinator = new EventCoordinator(container, logger);

			coordinator.registerEventDefinition(TestEvent);

			expect(() => {
				coordinator.registerEventDefinition(TestEvent);
			}).toThrow(/duplicate/i);
		});

		it('should return undefined for unregistered event', () => {
			const coordinator = new EventCoordinator(container, logger);

			expect(coordinator.getEventDefinition('non-existent')).toBeUndefined();
		});
	});

	describe('Consumer Registration', () => {
		it('should instantiate consumer via DI during registerConsumers()', () => {
			const coordinator = new EventCoordinator(container, logger);

			coordinator.registerEventDefinition(TestEvent);
			coordinator.addEventConsumer(TestEvent, TestEventConsumer, []);
			coordinator.registerConsumers();

			expect(coordinator.isConfigured()).toBe(true);
		});

		it('should return registered event names', () => {
			const SecondEvent = Event.define({
				name: 'second.event',
				data: Type.Object({ id: Type.Number() }),
				result: Type.Void()
			});

			const coordinator = new EventCoordinator(container, logger);

			coordinator.registerEventDefinition(TestEvent);
			coordinator.registerEventDefinition(SecondEvent);

			const names = coordinator.getRegisteredEventNames();
			expect(names).toContain('test.event');
			expect(names).toContain('second.event');
			expect(names).toHaveLength(2);
		});
	});

	describe('Worker Registration (CRITICAL - Subscribe Calls)', () => {
		// CRITICAL INVARIANT: Emitter-only apps must NOT call subscribe()
		// If BullMQ registers a worker for an app with no consumer, jobs will
		// be sent to that instance and silently fail/timeout since no handler exists.

		it('should NOT call subscribe for definition-only registration (emitter-only app)', async () => {
			let subscribeCount = 0;
			const subscribedEvents: string[] = [];

			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			const spyProvider: EventProvider = {
				start: () => realProvider.start(),
				stop: () => realProvider.stop(),
				emit: (eventName, payload, meta, options) => {
					return realProvider.emit(eventName, payload, meta ?? {}, options);
				},
				subscribe: (eventName, handler) => {
					subscribeCount++;
					subscribedEvents.push(eventName);
					return realProvider.subscribe(eventName, handler);
				}
			};

			const coordinator = new EventCoordinator(container, logger, () => spyProvider);

			// Register ONLY the event definition - NO consumer
			// This simulates an emitter-only app that just publishes events
			coordinator.registerEventDefinition(TestEvent);

			// Call registerConsumers even though we have no consumers
			coordinator.registerConsumers();

			await coordinator.start();

			// CRITICAL: subscribe should NOT have been called
			// An emitter-only app should NOT register as a worker
			expect(subscribeCount).toBe(0);
			expect(subscribedEvents).toEqual([]);

			await coordinator.stop();
		});

		it('should call subscribe ONLY for events with registered consumers', async () => {
			let subscribeCount = 0;
			const subscribedEvents: string[] = [];

			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			const spyProvider: EventProvider = {
				start: () => realProvider.start(),
				stop: () => realProvider.stop(),
				emit: (eventName, payload, meta, options) => {
					return realProvider.emit(eventName, payload, meta ?? {}, options);
				},
				subscribe: (eventName, handler) => {
					subscribeCount++;
					subscribedEvents.push(eventName);
					return realProvider.subscribe(eventName, handler);
				}
			};

			// Define a second event that will have a consumer
			const ConsumerEvent = Event.define({
				name: 'consumer.event',
				data: Type.Object({ data: Type.String() }),
				result: Type.Void()
			});

			class ConsumerEventHandler implements IEventConsumer<(typeof ConsumerEvent)['_data'], void> {
				onEvent = async (_ctx: EventContext<(typeof ConsumerEvent)['_data']>) => {};
			}

			const coordinator = new EventCoordinator(container, logger, () => spyProvider);

			// Register TestEvent definition ONLY (emitter-only for this event)
			coordinator.registerEventDefinition(TestEvent);

			// Register ConsumerEvent WITH a consumer (worker for this event)
			coordinator.registerEventDefinition(ConsumerEvent);
			coordinator.addEventConsumer(ConsumerEvent, ConsumerEventHandler, []);

			coordinator.registerConsumers();

			await coordinator.start();

			// subscribe should be called ONLY for ConsumerEvent
			expect(subscribeCount).toBe(1);
			expect(subscribedEvents).toEqual(['consumer.event']);
			// TestEvent should NOT appear - it's emitter-only
			expect(subscribedEvents).not.toContain('test.event');

			await coordinator.stop();
		});

		it('should allow emitting events without being subscribed (emitter-only pattern)', async () => {
			let subscribeCount = 0;
			const emittedEvents: Array<{ event: string; payload: unknown }> = [];

			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			const spyProvider: EventProvider = {
				start: () => realProvider.start(),
				stop: () => realProvider.stop(),
				emit: (eventName, payload, meta, options) => {
					emittedEvents.push({ event: eventName, payload });
					return realProvider.emit(eventName, payload, meta ?? {}, options);
				},
				subscribe: (eventName, handler) => {
					subscribeCount++;
					return realProvider.subscribe(eventName, handler);
				}
			};

			const coordinator = new EventCoordinator(container, logger, () => spyProvider);

			// Register definition only - emitter-only app
			coordinator.registerEventDefinition(TestEvent);
			coordinator.registerConsumers();

			await coordinator.start();

			// Emit event even though we're not subscribed
			const provider = coordinator.getProvider();
			provider!.emit('test.event', { message: 'hello from emitter' });

			// Verify we emitted but didn't subscribe
			expect(emittedEvents).toHaveLength(1);
			expect(emittedEvents[0]).toEqual({
				event: 'test.event',
				payload: { message: 'hello from emitter' }
			});
			expect(subscribeCount).toBe(0);

			await coordinator.stop();
		});
	});

	describe('Mock Provider for Testing', () => {
		it('should allow tracking emit calls with mock provider', async () => {
			const emittedEvents: Array<{ event: string; payload: unknown }> = [];
			let subscribeCount = 0;

			// Create a spy provider that wraps InProcessEventProvider
			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			const spyProvider: EventProvider = {
				start: () => realProvider.start(),
				stop: () => realProvider.stop(),
				emit: (eventName, payload, meta, options) => {
					emittedEvents.push({ event: eventName, payload });
					return realProvider.emit(eventName, payload, meta ?? {}, options);
				},
				subscribe: (eventName, handler) => {
					subscribeCount++;
					return realProvider.subscribe(eventName, handler);
				}
			};

			const UserCreatedEvent = Event.define({
				name: 'user.created',
				data: Type.Object({ userId: Type.Number() }),
				result: Type.Void()
			});

			let receivedPayload: unknown = null;

			class UserCreatedConsumer implements IEventConsumer<(typeof UserCreatedEvent)['_data'], void> {
				onEvent = async (ctx: EventContext<(typeof UserCreatedEvent)['_data']>) => {
					receivedPayload = ctx.data;
				};
			}

			const coordinator = new EventCoordinator(container, logger, () => spyProvider);

			coordinator.registerEventDefinition(UserCreatedEvent);
			coordinator.addEventConsumer(UserCreatedEvent, UserCreatedConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			const provider = coordinator.getProvider();
			provider!.emit('user.created', { userId: 123 });

			// Wait for async handler to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify spy captured the event
			expect(emittedEvents).toHaveLength(1);
			expect(emittedEvents[0]).toEqual({
				event: 'user.created',
				payload: { userId: 123 }
			});

			// Verify subscription was registered
			expect(subscribeCount).toBe(1);

			// Verify handler received payload
			expect(receivedPayload).toEqual({ userId: 123 });

			await coordinator.stop();
		});
	});

	describe('Event Chaining (ctx.emit)', () => {
		it('should allow emitting chained events from within a consumer', async () => {
			const emittedEvents: Array<{ event: string; payload: unknown; meta?: unknown; options?: unknown }> = [];

			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			const spyProvider: EventProvider = {
				start: () => realProvider.start(),
				stop: () => realProvider.stop(),
				emit: (eventName, payload, meta, options) => {
					emittedEvents.push({ event: eventName, payload, meta, options });
					return realProvider.emit(eventName, payload, meta ?? {}, options);
				},
				subscribe: (eventName, handler) => {
					return realProvider.subscribe(eventName, handler);
				}
			};

			// Primary event that will emit a chained event
			const PrimaryEvent = Event.define({
				name: 'primary.event',
				data: Type.Object({ userId: Type.Number() }),
				result: Type.Void()
			});

			// Secondary event to be emitted from within the primary consumer
			const SecondaryEvent = Event.define({
				name: 'secondary.event',
				data: Type.Object({ message: Type.String() }),
				result: Type.Void()
			});

			class PrimaryEventConsumer implements IEventConsumer<(typeof PrimaryEvent)['_data'], void> {
				onEvent = async (ctx: EventContext<(typeof PrimaryEvent)['_data']>) => {
					// Emit chained event using ctx.emit (fire-and-forget)
					ctx.emit('secondary.event', { message: `User ${ctx.data.userId} processed` });
				};
			}

			const coordinator = new EventCoordinator(container, logger, () => spyProvider);

			coordinator.registerEventDefinition(PrimaryEvent);
			coordinator.registerEventDefinition(SecondaryEvent);
			coordinator.addEventConsumer(PrimaryEvent, PrimaryEventConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			// Emit the primary event
			const provider = coordinator.getProvider();
			provider!.emit('primary.event', { userId: 123 }, { correlationId: 'corr-123' });

			// Wait for async handlers to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify both events were emitted
			expect(emittedEvents).toHaveLength(2);

			const primaryEvent = emittedEvents[0]!;
			const secondaryEvent = emittedEvents[1]!;

			// Primary event
			expect(primaryEvent.event).toBe('primary.event');
			expect(primaryEvent.payload).toEqual({ userId: 123 });

			// Chained secondary event
			expect(secondaryEvent.event).toBe('secondary.event');
			expect(secondaryEvent.payload).toEqual({ message: 'User 123 processed' });

			// Verify causation chain: secondary event's causationId should be the primary event's ID
			const secondaryMeta = secondaryEvent.meta as { correlationId?: string; causationId?: string };
			expect(secondaryMeta.correlationId).toBe('corr-123'); // Same correlation for tracing
			// causationId should be set (it's the primary event's eventId)
			expect(secondaryMeta.causationId).toBeDefined();

			await coordinator.stop();
		});

		it('should support waiting for chained event result', async () => {
			const { InProcessEventProvider } = await import('@orijs/events');
			const realProvider = new InProcessEventProvider();

			// Event that returns a result
			const ProcessEvent = Event.define({
				name: 'process.event',
				data: Type.Object({ input: Type.String() }),
				result: Type.Object({ output: Type.String() })
			});

			// Chained event that also returns a result
			const ValidateEvent = Event.define({
				name: 'validate.event',
				data: Type.Object({ value: Type.String() }),
				result: Type.Object({ valid: Type.Boolean() })
			});

			let chainedResult: { valid: boolean } | null = null;

			class ProcessConsumer implements IEventConsumer<
				(typeof ProcessEvent)['_data'],
				(typeof ProcessEvent)['_result']
			> {
				onEvent = async (ctx: EventContext<(typeof ProcessEvent)['_data']>) => {
					// Emit chained event and wait for result
					const handle = ctx.emit<{ valid: boolean }>('validate.event', { value: ctx.data.input });
					chainedResult = await handle.wait();
					return { output: `Processed: ${ctx.data.input}, valid: ${chainedResult.valid}` };
				};
			}

			class ValidateConsumer implements IEventConsumer<
				(typeof ValidateEvent)['_data'],
				(typeof ValidateEvent)['_result']
			> {
				onEvent = async (ctx: EventContext<(typeof ValidateEvent)['_data']>) => {
					return { valid: ctx.data.value.length > 0 };
				};
			}

			const coordinator = new EventCoordinator(container, logger, () => realProvider);

			coordinator.registerEventDefinition(ProcessEvent);
			coordinator.registerEventDefinition(ValidateEvent);
			coordinator.addEventConsumer(ProcessEvent, ProcessConsumer, []);
			coordinator.addEventConsumer(ValidateEvent, ValidateConsumer, []);
			coordinator.registerConsumers();

			await coordinator.start();

			// Emit the process event
			const provider = coordinator.getProvider();
			const result = await provider!.emit<{ output: string }>('process.event', { input: 'test' });

			// Verify the chain executed correctly
			expect(chainedResult).not.toBeNull();
			expect(chainedResult!.valid).toBe(true);
			expect(result).toEqual({ output: 'Processed: test, valid: true' });

			await coordinator.stop();
		});
	});
});
