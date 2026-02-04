/**
 * Tests for EventSystem
 *
 * Covers:
 * - createEventSystem factory
 * - Type-safe emit and handlers
 * - Registry validation
 * - Builder integration
 * - Lifecycle management
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventRegistry } from '../src/event-registry.ts';
import { createEventSystem, createPropagationMeta } from '../src/events.ts';
import { InProcessEventProvider } from '../src/in-process-orchestrator.ts';
import { Logger, runWithContext, createTraceContext } from '@orijs/logging';
import type { EventSystem } from '../src/events.ts';
import type { EventContext } from '../src/event-context.ts';
import type { PropagationMeta } from '@orijs/logging';

// Test event payloads
interface UserCreatedPayload {
	id: number;
	name: string;
	email: string;
}

interface OrderPlacedPayload {
	orderId: string;
	userId: number;
	total: number;
}

interface OrderResult {
	confirmed: boolean;
	estimatedDelivery: string;
}

describe('EventSystem', () => {
	// Build a test registry - .event() takes only the name, payload types are defined separately
	const TestEvents = EventRegistry.create()
		.event('user.created')
		.event('order.placed')
		.event('system.ping')
		.build();

	type TestEventNames = 'user.created' | 'order.placed' | 'system.ping';

	let eventSystem: EventSystem<TestEventNames>;

	beforeEach(() => {
		Logger.reset();
		eventSystem = createEventSystem(TestEvents);
	});

	afterEach(async () => {
		await eventSystem.stop();
	});

	describe('createEventSystem', () => {
		it('should create event system with default InProcessEventProvider', () => {
			const system = createEventSystem(TestEvents);

			expect(system.provider).toBeInstanceOf(InProcessEventProvider);
			expect(system.registry).toBe(TestEvents);
		});

		it('should accept custom orchestrator', () => {
			const customProvider = new InProcessEventProvider();
			const system = createEventSystem(TestEvents, { provider: customProvider });

			expect(system.provider).toBe(customProvider);
		});
	});

	describe('emit', () => {
		it('should emit events and deliver to handlers', async () => {
			const received: UserCreatedPayload[] = [];

			eventSystem.onEvent<UserCreatedPayload>('user.created', async (ctx) => {
				received.push(ctx.data);
			});

			eventSystem.emit('user.created', { id: 1, name: 'Alice', email: 'alice@example.com' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toHaveLength(1);
			expect(received[0]).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });
		});

		it('should throw for unknown events', () => {
			expect(() => {
				// Cast to any to test runtime validation of invalid event name
				(eventSystem.emit as (n: string, p: unknown) => unknown)('unknown.event', {});
			}).toThrow('Unknown event: unknown.event');
		});

		it('should return EventSubscription for request-response', async () => {
			eventSystem.onEvent<OrderPlacedPayload, OrderResult>('order.placed', async () => {
				return { confirmed: true, estimatedDelivery: '2024-01-15' };
			});

			let result: OrderResult | undefined = undefined;

			eventSystem
				.emit<OrderResult>('order.placed', { orderId: 'ORD-123', userId: 1, total: 99.99 })
				.subscribe((r) => {
					result = r;
				});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(result).toBeDefined();
			expect(result!.confirmed).toBe(true);
			expect(result!.estimatedDelivery).toBe('2024-01-15');
		});

		it('should support delayed emit', async () => {
			let delivered = false;

			eventSystem.onEvent('system.ping', async () => {
				delivered = true;
			});

			eventSystem.emit('system.ping', undefined, { delay: 50 });

			// Should not be delivered yet
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(delivered).toBe(false);

			// Should be delivered after delay
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(delivered).toBe(true);
		});
	});

	describe('onEvent', () => {
		it('should register handler for event', async () => {
			let callCount = 0;

			eventSystem.onEvent('user.created', async () => {
				callCount++;
			});

			eventSystem.emit('user.created', { id: 1, name: 'Test', email: 'test@test.com' });
			eventSystem.emit('user.created', { id: 2, name: 'Test2', email: 'test2@test.com' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(callCount).toBe(2);
		});

		it('should throw for unknown events', () => {
			expect(() => {
				// Cast to any to test runtime validation of invalid event name
				(eventSystem.onEvent as (n: string, h: () => Promise<void>) => void)('unknown.event', async () => {});
			}).toThrow('Unknown event: unknown.event');
		});

		it('should provide EventContext to handler', async () => {
			let receivedContext: EventContext<UserCreatedPayload> | null = null;

			eventSystem.onEvent<UserCreatedPayload>('user.created', async (ctx) => {
				receivedContext = ctx;
			});

			eventSystem.emit('user.created', { id: 1, name: 'Alice', email: 'alice@example.com' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedContext).not.toBeNull();
			expect(receivedContext!.data).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });
			expect(receivedContext!.eventName).toBe('user.created');
			expect(receivedContext!.correlationId).toBeDefined();
			expect(receivedContext!.log).toBeDefined();
			expect(receivedContext!.timestamp).toBeGreaterThan(0);
		});
	});

	describe('createBuilder', () => {
		it('should return EventBuilder for handler registration', () => {
			const builder = eventSystem.createBuilder();

			expect(builder).toBeDefined();
			expect(typeof builder.on).toBe('function');
		});
	});

	describe('lifecycle', () => {
		it('should start and stop provider', async () => {
			const customProvider = new InProcessEventProvider();
			const system = createEventSystem(TestEvents, { provider: customProvider });

			expect(customProvider.isStarted()).toBe(false);

			await system.start();
			expect(customProvider.isStarted()).toBe(true);

			await system.stop();
			expect(customProvider.isStarted()).toBe(false);
		});
	});

	describe('createPropagationMeta', () => {
		it('should create meta with request_id', () => {
			const meta = createPropagationMeta('req-123');

			expect(meta.correlationId).toBe('req-123');
		});

		it('should create meta without request_id', () => {
			const meta = createPropagationMeta();

			expect(meta.correlationId).toBeUndefined();
		});

		it('should include additional fields', () => {
			const meta = createPropagationMeta('req-123', {
				userId: 'user-456',
				traceId: 'trace-789'
			});

			expect(meta.correlationId).toBe('req-123');
			expect(meta.userId).toBe('user-456');
			expect(meta.traceId).toBe('trace-789');
		});
	});
});

describe('EventSystem Integration', () => {
	// Integration test for complete flow
	const Events = EventRegistry.create().event('payment.initiated').event('payment.completed').build();

	it('should support async/await for request-response', async () => {
		const system = createEventSystem(Events);

		// Handler returns a result
		system.onEvent<{ amount: number }, { transactionId: string }>('payment.initiated', async (ctx) => {
			return { transactionId: `TXN-${ctx.data.amount}` };
		});

		// Await the result directly
		const result = await system.emit<{ transactionId: string }>('payment.initiated', { amount: 100 });

		expect(result.transactionId).toBe('TXN-100');

		await system.stop();
	});

	it('should support chained event emission from handler', async () => {
		const system = createEventSystem(Events);
		const completedPayments: Array<{ paymentId: string; status: string }> = [];

		// Handler that emits another event
		system.onEvent<{ amount: number }>('payment.initiated', async (ctx) => {
			// Simulate payment processing
			ctx.emit('payment.completed', { paymentId: 'PAY-001', status: 'success' });
		});

		// Handler for completed events
		system.onEvent<{ paymentId: string; status: string }>('payment.completed', async (ctx) => {
			completedPayments.push(ctx.data);
		});

		// Trigger the chain
		system.emit('payment.initiated', { amount: 100 });

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(completedPayments).toHaveLength(1);
		expect(completedPayments[0]).toEqual({ paymentId: 'PAY-001', status: 'success' });

		await system.stop();
	});

	it('should isolate errors to individual handlers', async () => {
		const system = createEventSystem(Events);
		const results: string[] = [];

		// Handler that throws
		system.onEvent('payment.initiated', async () => {
			throw new Error('Handler 1 failed');
		});

		// Handler that succeeds
		system.onEvent('payment.initiated', async () => {
			results.push('handler2-success');
		});

		// Error callback
		let capturedError: Error | null = null;
		system.emit('payment.initiated', { amount: 100 }).catch((e) => {
			capturedError = e;
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		// First handler's error should be captured
		expect(capturedError).not.toBeNull();
		expect(capturedError!.message).toBe('Handler 1 failed');

		await system.stop();
	});
});

describe('EventSystem Context Propagation', () => {
	const Events = EventRegistry.create().event('test.event').build();

	it('should propagate trace context from AsyncLocalStorage to event metadata', async () => {
		const system = createEventSystem(Events);
		let receivedMeta: PropagationMeta | null = null;

		// Register handler to capture the metadata
		system.provider.subscribe<unknown>('test.event', async (message) => {
			receivedMeta = message.meta;
		});

		// Create trace context
		const trace = createTraceContext('parent-trace-id', 'parent-span-id');

		// Emit within runWithContext
		await runWithContext({ log: Logger.console(), correlationId: 'req-123', trace }, async () => {
			system.emit('test.event', { value: 1 });
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		expect(receivedMeta).not.toBeNull();
		expect(receivedMeta!.correlationId).toBe('req-123');
		expect(receivedMeta!.traceId).toBe('parent-trace-id');
		// span_id should be a NEW child span, not the parent
		expect(receivedMeta!.spanId).toBeDefined();
		expect(receivedMeta!.spanId).not.toBe('parent-span-id');
		// parent_span_id should be the original span
		expect(receivedMeta!.parentSpanId).toBe(trace.spanId);

		await system.stop();
	});

	it('should generate new trace context when none exists in AsyncLocalStorage', async () => {
		const system = createEventSystem(Events);
		let receivedMeta: PropagationMeta | null = null;

		system.provider.subscribe<unknown>('test.event', async (message) => {
			receivedMeta = message.meta;
		});

		// Emit without runWithContext (no trace context)
		system.emit('test.event', { value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Should still have metadata, but trace fields may be undefined
		expect(receivedMeta).not.toBeNull();

		await system.stop();
	});

	it('should propagate only correlationId when trace context is missing', async () => {
		const system = createEventSystem(Events);
		let receivedMeta: PropagationMeta | null = null;

		system.provider.subscribe<unknown>('test.event', async (message) => {
			receivedMeta = message.meta;
		});

		// Emit within runWithContext with correlationId but no trace
		await runWithContext({ log: Logger.console(), correlationId: 'req-456' }, async () => {
			system.emit('test.event', { value: 1 });
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		expect(receivedMeta).not.toBeNull();
		expect(receivedMeta!.correlationId).toBe('req-456');

		await system.stop();
	});

	it('should create child span for each event emission', async () => {
		const system = createEventSystem(Events);
		const receivedSpans: string[] = [];

		system.provider.subscribe<unknown>('test.event', async (message) => {
			if (message.meta.spanId) {
				receivedSpans.push(message.meta.spanId as string);
			}
		});

		const trace = createTraceContext('trace-id');

		// Emit multiple events within same context
		await runWithContext({ log: Logger.console(), correlationId: 'req-789', trace }, async () => {
			system.emit('test.event', { value: 1 });
			system.emit('test.event', { value: 2 });
			system.emit('test.event', { value: 3 });
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		// Each emission should have a unique span_id
		expect(receivedSpans.length).toBe(3);
		expect(new Set(receivedSpans).size).toBe(3); // All unique

		await system.stop();
	});
});
