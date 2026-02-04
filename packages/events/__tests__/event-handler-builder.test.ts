/**
 * Tests for EventHandlerBuilder
 *
 * Covers:
 * - Handler registration via .on()
 * - getRegistrations() to retrieve handlers
 * - registerWith() to bind to orchestrator
 * - EventContext wrapping of handlers
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EventHandlerBuilder } from '../src/event-handler-builder.ts';
import type { EventContext } from '../src/event-context.ts';
import {
	EVENT_MESSAGE_VERSION,
	type EventProvider,
	type EventHandlerFn
} from '../src/event-provider.types.ts';
import type { EventSubscription } from '../src/event-subscription.ts';
import { Logger } from '@orijs/logging';

describe('EventHandlerBuilder', () => {
	beforeEach(() => {
		Logger.reset();
	});

	describe('on()', () => {
		it('should register a handler for an event', () => {
			const builder = new EventHandlerBuilder<'test.event'>();
			const handler = async () => {};

			builder.on('test.event', handler);

			const registrations = builder.getRegistrations();
			expect(registrations).toHaveLength(1);
			expect(registrations[0]!.eventName).toBe('test.event');
		});

		it('should register multiple handlers for different events', () => {
			const builder = new EventHandlerBuilder<'event.a' | 'event.b' | 'event.c'>();

			builder.on('event.a', async () => {});
			builder.on('event.b', async () => {});
			builder.on('event.c', async () => {});

			const registrations = builder.getRegistrations();
			expect(registrations).toHaveLength(3);
			expect(registrations.map((r) => r.eventName)).toEqual(['event.a', 'event.b', 'event.c']);
		});

		it('should register multiple handlers for the same event', () => {
			const builder = new EventHandlerBuilder<'shared.event'>();

			builder.on('shared.event', async () => 'handler1');
			builder.on('shared.event', async () => 'handler2');

			const registrations = builder.getRegistrations();
			expect(registrations).toHaveLength(2);
			expect(registrations[0]!.eventName).toBe('shared.event');
			expect(registrations[1]!.eventName).toBe('shared.event');
		});
	});

	describe('getRegistrations()', () => {
		it('should return empty array when no handlers registered', () => {
			const builder = new EventHandlerBuilder();

			expect(builder.getRegistrations()).toEqual([]);
		});

		it('should return readonly array', () => {
			const builder = new EventHandlerBuilder<'test.event'>();
			builder.on('test.event', async () => {});

			const registrations = builder.getRegistrations();

			// TypeScript marks as readonly, verify at runtime
			expect(Array.isArray(registrations)).toBe(true);
		});
	});

	describe('registerWith()', () => {
		it('should register all handlers with the orchestrator', () => {
			const builder = new EventHandlerBuilder<'event.a' | 'event.b'>();
			builder.on('event.a', async () => {});
			builder.on('event.b', async () => {});

			const subscribeArgs: [string, EventHandlerFn][] = [];
			const mockProvider = {
				subscribe: (eventName: string, handler: EventHandlerFn) => {
					subscribeArgs.push([eventName, handler]);
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			const mockEmit = () => ({}) as EventSubscription<unknown>;

			builder.registerWith(mockProvider, mockEmit as any);

			expect(subscribeArgs).toHaveLength(2);
			expect(subscribeArgs[0]![0]).toBe('event.a');
			expect(subscribeArgs[1]![0]).toBe('event.b');
		});

		it('should wrap handler to provide EventContext', async () => {
			const builder = new EventHandlerBuilder<'test.event'>();
			let receivedCtx: EventContext<{ value: number }> | null = null;

			builder.on<{ value: number }>('test.event', async (ctx) => {
				receivedCtx = ctx;
			});

			// Create mock provider that captures the wrapped handler
			let capturedHandler: EventHandlerFn | null = null;
			const mockProvider = {
				subscribe: (_eventName: string, handler: EventHandlerFn) => {
					capturedHandler = handler;
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			const mockEmit = () => ({}) as EventSubscription<unknown>;

			builder.registerWith(mockProvider, mockEmit as any);

			// Simulate message delivery
			expect(capturedHandler).not.toBeNull();
			await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-test-123',
				eventName: 'test.event',
				payload: { value: 42 },
				meta: { correlationId: 'req-123' },
				correlationId: 'corr-456',
				timestamp: Date.now()
			});

			// Verify handler received EventContext, not raw message
			expect(receivedCtx).not.toBeNull();
			expect(receivedCtx!.data).toEqual({ value: 42 });
			expect(receivedCtx!.correlationId).toBe('corr-456');
			expect(receivedCtx!.eventName).toBe('test.event');
			expect(receivedCtx!.log).toBeInstanceOf(Logger);
		});

		it('should return handler result through wrapped handler', async () => {
			const builder = new EventHandlerBuilder<'test.event'>();

			builder.on<{ input: string }, { output: string }>('test.event', async (ctx) => {
				return { output: ctx.data.input.toUpperCase() };
			});

			let capturedHandler: EventHandlerFn<unknown, unknown> | null = null;
			const mockProvider = {
				subscribe: (_eventName: string, handler: EventHandlerFn<unknown, unknown>) => {
					capturedHandler = handler;
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			builder.registerWith(mockProvider, (() => ({}) as EventSubscription<any>) as any);

			const result = await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-test-456',
				eventName: 'test.event',
				payload: { input: 'hello' },
				meta: {},
				correlationId: 'corr-123',
				timestamp: Date.now()
			});

			expect(result).toEqual({ output: 'HELLO' });
		});

		it('should provide emit function in context', async () => {
			const builder = new EventHandlerBuilder<'first.event' | 'second.event'>();

			builder.on<{}, void>('first.event', async (ctx) => {
				ctx.emit('second.event', { chained: true });
			});

			let capturedHandler: EventHandlerFn | null = null;
			const mockProvider = {
				subscribe: (eventName: string, handler: EventHandlerFn) => {
					if (eventName === 'first.event') {
						capturedHandler = handler;
					}
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			const emitCalls: unknown[][] = [];
			const mockEmit = (...args: unknown[]) => {
				emitCalls.push(args);
				return {} as EventSubscription<any>;
			};

			builder.registerWith(mockProvider, mockEmit as any);

			await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-test-789',
				eventName: 'first.event',
				payload: {},
				meta: { correlationId: 'req-123' },
				correlationId: 'corr-456',
				timestamp: Date.now()
			});

			expect(emitCalls).toHaveLength(1);
			expect(emitCalls[0]![0]).toBe('second.event');
			expect(emitCalls[0]![1]).toEqual({ chained: true });
		});
	});

	describe('typed event names', () => {
		it('should enforce type-safe event names', () => {
			type AppEvents = 'user.created' | 'user.updated' | 'user.deleted';
			const builder = new EventHandlerBuilder<AppEvents>();

			// These should all be valid
			builder.on('user.created', async () => {});
			builder.on('user.updated', async () => {});
			builder.on('user.deleted', async () => {});

			expect(builder.getRegistrations()).toHaveLength(3);
		});
	});

	describe('EventHandlerClass pattern', () => {
		it('should work with handler classes', () => {
			type OrderEvents = 'order.placed' | 'order.shipped';

			class OrderHandler {
				public configure(e: EventHandlerBuilder<OrderEvents>): void {
					e.on('order.placed', this.handlePlaced);
					e.on('order.shipped', this.handleShipped);
				}

				private handlePlaced = async (_ctx: EventContext<{ orderId: string }>) => {
					return { processed: true };
				};

				private handleShipped = async (_ctx: EventContext<{ trackingNumber: string }>) => {
					return { shipped: true };
				};
			}

			const builder = new EventHandlerBuilder<OrderEvents>();
			const handler = new OrderHandler();
			handler.configure(builder);

			expect(builder.getRegistrations()).toHaveLength(2);
			expect(builder.getRegistrations()[0]!.eventName).toBe('order.placed');
			expect(builder.getRegistrations()[1]!.eventName).toBe('order.shipped');
		});
	});

	describe('edge cases', () => {
		it('should handle handler that returns undefined', async () => {
			const builder = new EventHandlerBuilder<'void.event'>();

			builder.on('void.event', async () => {
				// No return
			});

			let capturedHandler: EventHandlerFn<unknown, unknown> | null = null;
			const mockProvider = {
				subscribe: (_eventName: string, handler: EventHandlerFn<unknown, unknown>) => {
					capturedHandler = handler;
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			builder.registerWith(mockProvider, (() => ({}) as EventSubscription<any>) as any);

			const result = await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-void-123',
				eventName: 'void.event',
				payload: {},
				meta: {},
				correlationId: 'corr-123',
				timestamp: Date.now()
			});

			expect(result).toBeUndefined();
		});

		it('should handle chained emit with delay option', async () => {
			const builder = new EventHandlerBuilder<'first.event' | 'delayed.event'>();

			builder.on<{}, void>('first.event', async (ctx) => {
				ctx.emit('delayed.event', { delayed: true }, { delay: 1000 });
			});

			let capturedHandler: EventHandlerFn | null = null;
			const mockProvider = {
				subscribe: (eventName: string, handler: EventHandlerFn) => {
					if (eventName === 'first.event') {
						capturedHandler = handler;
					}
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			const emitCalls: unknown[][] = [];
			const mockEmit = (...args: unknown[]) => {
				emitCalls.push(args);
				return {} as EventSubscription<any>;
			};

			builder.registerWith(mockProvider, mockEmit as any);

			await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-delay-123',
				eventName: 'first.event',
				payload: {},
				meta: { correlationId: 'req-123' },
				correlationId: 'corr-456',
				timestamp: Date.now()
			});

			expect(emitCalls).toHaveLength(1);
			expect(emitCalls[0]![0]).toBe('delayed.event');
			expect(emitCalls[0]![1]).toEqual({ delayed: true });
			expect(emitCalls[0]![2]).toEqual({ delay: 1000, causationId: 'corr-456' });
		});

		it('should preserve correlation context in chained events', async () => {
			const builder = new EventHandlerBuilder<'parent.event' | 'child.event'>();

			builder.on<{}, void>('parent.event', async (ctx) => {
				// Access correlation data to verify it's available
				expect(ctx.correlationId).toBe('original-correlation');
				ctx.emit('child.event', { fromParent: true });
			});

			let capturedHandler: EventHandlerFn | null = null;
			const mockProvider = {
				subscribe: (eventName: string, handler: EventHandlerFn) => {
					if (eventName === 'parent.event') {
						capturedHandler = handler;
					}
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			const mockEmit = () => ({}) as EventSubscription<any>;

			builder.registerWith(mockProvider, mockEmit as any);

			await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-parent-123',
				eventName: 'parent.event',
				payload: {},
				meta: { correlationId: 'req-abc', spanId: 'span-xyz' },
				correlationId: 'original-correlation',
				timestamp: Date.now()
			});
		});

		it('should handle empty meta in event message', async () => {
			const builder = new EventHandlerBuilder<'empty.meta.event'>();

			let receivedCtx: EventContext<{}> | null = null;

			builder.on<{}>('empty.meta.event', async (ctx) => {
				receivedCtx = ctx;
			});

			let capturedHandler: EventHandlerFn | null = null;
			const mockProvider = {
				subscribe: (_eventName: string, handler: EventHandlerFn) => {
					capturedHandler = handler;
				},
				emit: () => ({}) as EventSubscription<any>,
				start: async () => {},
				stop: async () => {}
			} as unknown as EventProvider;

			builder.registerWith(mockProvider, (() => ({}) as EventSubscription<any>) as any);

			await capturedHandler!({
				version: EVENT_MESSAGE_VERSION,
				eventId: 'evt-empty-meta',
				eventName: 'empty.meta.event',
				payload: {},
				meta: {},
				correlationId: 'corr-empty',
				timestamp: Date.now()
			});

			expect(receivedCtx).not.toBeNull();
			expect(receivedCtx!.correlationId).toBe('corr-empty');
		});
	});
});
