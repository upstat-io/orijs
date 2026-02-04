/**
 * Tests for EventDeliveryEngine
 *
 * Covers:
 * - Event delivery to handlers
 * - Request-response pattern (first handler resolves subscription)
 * - Fire-and-forget pattern (all handlers called)
 * - Error handling and logging
 * - Chained emit function creation
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
	EventDeliveryEngine,
	createChainedEmitFactory,
	type EventDeliveryLogger,
	type CreateChainedEmitFn
} from '../src/event-delivery.ts';
import { HandlerRegistry } from '../src/handler-registry.ts';
import { createSubscription } from '../src/event-subscription.ts';
import { EVENT_MESSAGE_VERSION, type EventMessage } from '../src/event-provider.types.ts';
import type { PropagationMeta } from '@orijs/logging';

describe('EventDeliveryEngine', () => {
	let registry: HandlerRegistry;
	let mockLogger: EventDeliveryLogger;
	let mockChainedEmit: CreateChainedEmitFn;
	let delivery: EventDeliveryEngine;

	const createTestMessage = (eventName: string, payload: unknown = {}): EventMessage => ({
		version: EVENT_MESSAGE_VERSION,
		eventId: crypto.randomUUID(),
		eventName,
		payload,
		meta: {
			correlationId: 'req-123',
			userId: 'user-456',
			accountUuid: 'acc-789'
		},
		correlationId: 'corr-abc',
		timestamp: Date.now()
	});

	beforeEach(() => {
		registry = new HandlerRegistry();
		mockLogger = {
			error: mock(() => {})
		};
		mockChainedEmit = mock((_message: EventMessage) => {
			return (<TChainReturn = void>(_eventName: string, _data: unknown, _options?: { delay?: number }) =>
				createSubscription<TChainReturn>()) as any;
		}) as CreateChainedEmitFn;
		delivery = new EventDeliveryEngine({
			registry,
			log: mockLogger,
			createChainedEmit: mockChainedEmit
		});
	});

	describe('deliver', () => {
		it('should do nothing when no handlers registered', async () => {
			const subscription = createSubscription<string>();
			const message = createTestMessage('no.handlers');

			delivery.deliver(message, subscription);

			// Wait for async execution
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(subscription.isSettled()).toBe(false);
		});

		it('should execute handler and resolve subscription with result', async () => {
			const subscription = createSubscription<{ processed: boolean }>();
			const message = createTestMessage('user.created', { userId: 123 });

			registry.subscribe('user.created', async (_msg: EventMessage) => {
				return { processed: true };
			});

			delivery.deliver(message, subscription);

			const result = await subscription.toPromise();
			expect(result).toEqual({ processed: true });
			expect(subscription.isResolved()).toBe(true);
		});

		it('should pass correct message to handler', async () => {
			const subscription = createSubscription<void>();
			const message = createTestMessage('test.event', { data: 'test-data' });
			let receivedMessage: EventMessage | undefined;

			registry.subscribe('test.event', async (msg: EventMessage) => {
				receivedMessage = msg;
			});

			delivery.deliver(message, subscription);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedMessage).toBeDefined();
			expect(receivedMessage!.eventName).toBe('test.event');
			expect(receivedMessage!.payload).toEqual({ data: 'test-data' });
			expect(receivedMessage!.correlationId).toBe('corr-abc');
		});

		it('should use first handler result for request-response', async () => {
			const subscription = createSubscription<number>();
			const message = createTestMessage('multi.handler');

			registry.subscribe('multi.handler', async () => 1);
			registry.subscribe('multi.handler', async () => 2);
			registry.subscribe('multi.handler', async () => 3);

			delivery.deliver(message, subscription);

			const result = await subscription.toPromise();
			expect(result).toBe(1);
		});

		it('should call all handlers for fire-and-forget', async () => {
			const subscription = createSubscription<void>();
			const message = createTestMessage('broadcast.event');
			const callOrder: number[] = [];

			registry.subscribe('broadcast.event', async () => {
				callOrder.push(1);
			});
			registry.subscribe('broadcast.event', async () => {
				callOrder.push(2);
			});
			registry.subscribe('broadcast.event', async () => {
				callOrder.push(3);
			});

			delivery.deliver(message, subscription);

			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(callOrder).toContain(1);
			expect(callOrder).toContain(2);
			expect(callOrder).toContain(3);
		});

		it('should reject subscription when first handler throws', async () => {
			const subscription = createSubscription<void>();
			const message = createTestMessage('error.event');
			const testError = new Error('Handler failed');

			registry.subscribe('error.event', async () => {
				throw testError;
			});

			delivery.deliver(message, subscription);

			await expect(subscription.toPromise()).rejects.toThrow('Handler failed');
			expect(subscription.isRejected()).toBe(true);
		});

		it('should log error for fire-and-forget handler failure', async () => {
			const subscription = createSubscription<string>();
			const message = createTestMessage('mixed.event');

			// First handler succeeds (request-response)
			registry.subscribe('mixed.event', async () => 'success');

			// Second handler fails (fire-and-forget - should log, not reject)
			registry.subscribe('mixed.event', async () => {
				throw new Error('Secondary handler failed');
			});

			delivery.deliver(message, subscription);

			const result = await subscription.toPromise();
			expect(result).toBe('success');

			// Wait for fire-and-forget handler to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(mockLogger.error).toHaveBeenCalled();
		});

		it('should include event details in error log', async () => {
			const subscription = createSubscription<string>();
			const message = createTestMessage('logging.test');

			// First handler succeeds
			registry.subscribe('logging.test', async () => 'ok');

			// Second handler fails
			registry.subscribe('logging.test', async () => {
				throw new Error('Detailed error message');
			});

			delivery.deliver(message, subscription);

			await subscription.toPromise();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const errorCall = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0];
			expect(errorCall).toBeDefined();
			expect(errorCall![0]).toBe('Fire-and-forget handler error');
			expect(errorCall![1]).toMatchObject({
				eventName: 'logging.test',
				correlationId: 'corr-abc'
			});
		});
	});

	describe('chained emit', () => {
		it('should call createChainedEmit with message', async () => {
			const subscription = createSubscription<void>();
			const message = createTestMessage('chain.test');

			registry.subscribe('chain.test', async () => {});

			delivery.deliver(message, subscription);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockChainedEmit).toHaveBeenCalledWith(message);
		});
	});
});

describe('createChainedEmitFactory', () => {
	// Helper to create a properly typed mock emit function
	const createMockEmit = () => {
		return <TReturn = void>(
			_eventName: string,
			_data: unknown,
			_meta: PropagationMeta,
			_options?: { delay?: number; causationId?: string }
		) => createSubscription<TReturn>();
	};

	it('should create factory that produces emit functions', () => {
		const mockEmit = createMockEmit();
		const factory = createChainedEmitFactory(mockEmit);

		expect(typeof factory).toBe('function');
	});

	it('should create emit function from message', () => {
		const mockEmit = createMockEmit();
		const factory = createChainedEmitFactory(mockEmit);

		const message: EventMessage = {
			version: EVENT_MESSAGE_VERSION,
			eventId: 'evt-create-1',
			eventName: 'original.event',
			payload: {},
			meta: { correlationId: 'req-1', userId: 'user-1', accountUuid: 'acc-1' },
			correlationId: 'corr-1',
			timestamp: Date.now()
		};

		const chainedEmit = factory(message);

		expect(typeof chainedEmit).toBe('function');
	});

	it('should emit chained event with updated meta', () => {
		const emittedEvents: Array<{
			eventName: string;
			payload: unknown;
			meta: PropagationMeta;
		}> = [];

		const trackingEmit = <TReturn = void>(
			eventName: string,
			payload: unknown,
			meta: PropagationMeta,
			_options?: { delay?: number; causationId?: string }
		) => {
			emittedEvents.push({ eventName, payload, meta });
			return createSubscription<TReturn>();
		};

		const factory = createChainedEmitFactory(trackingEmit);

		const originalMessage: EventMessage = {
			version: EVENT_MESSAGE_VERSION,
			eventId: 'evt-chain-1',
			eventName: 'order.placed',
			payload: { orderId: 123 },
			meta: {
				correlationId: 'req-original',
				userId: 'user-original',
				accountUuid: 'acc-original'
			},
			correlationId: 'corr-original',
			timestamp: Date.now()
		};

		const chainedEmit = factory(originalMessage);
		chainedEmit('inventory.reserve', { items: ['item1'] });

		expect(emittedEvents.length).toBe(1);
		expect(emittedEvents[0]!.eventName).toBe('inventory.reserve');
		expect(emittedEvents[0]!.payload).toEqual({ items: ['item1'] });
	});

	it('should pass delay option through to emit', () => {
		let capturedOptions: { delay?: number; causationId?: string } | undefined;

		const trackingEmit = <TReturn = void>(
			_eventName: string,
			_data: unknown,
			_meta: PropagationMeta,
			options?: { delay?: number; causationId?: string }
		) => {
			capturedOptions = options;
			return createSubscription<TReturn>();
		};

		const factory = createChainedEmitFactory(trackingEmit);

		const message: EventMessage = {
			version: EVENT_MESSAGE_VERSION,
			eventId: 'evt-delay-1',
			eventName: 'test.event',
			payload: {},
			meta: { correlationId: 'req', userId: 'user', accountUuid: 'acc' },
			correlationId: 'corr',
			timestamp: Date.now()
		};

		const chainedEmit = factory(message);
		chainedEmit('delayed.event', {}, { delay: 5000 });

		expect(capturedOptions).toBeDefined();
		expect(capturedOptions!.delay).toBe(5000);
	});
});
