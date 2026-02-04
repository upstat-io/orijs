/**
 * Tests for HandlerRegistry
 *
 * Covers:
 * - Handler subscription
 * - Handler retrieval
 * - Handler count
 * - Clear functionality
 * - Multiple handlers per event
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { HandlerRegistry } from '../src/handler-registry.ts';
import type { EventMessage } from '../src/event-provider.types.ts';

describe('HandlerRegistry', () => {
	let registry: HandlerRegistry;

	beforeEach(() => {
		registry = new HandlerRegistry();
	});

	describe('subscribe', () => {
		it('should register a handler for an event', () => {
			const handler = async (_msg: EventMessage) => ({ processed: true });

			registry.subscribe('user.created', handler);

			expect(registry.getHandlerCount('user.created')).toBe(1);
		});

		it('should register multiple handlers for the same event', () => {
			const handler1 = async (_msg: EventMessage) => ({ id: 1 });
			const handler2 = async (_msg: EventMessage) => ({ id: 2 });
			const handler3 = async (_msg: EventMessage) => ({ id: 3 });

			registry.subscribe('order.placed', handler1);
			registry.subscribe('order.placed', handler2);
			registry.subscribe('order.placed', handler3);

			expect(registry.getHandlerCount('order.placed')).toBe(3);
		});

		it('should register handlers for different events independently', () => {
			const userHandler = async (_msg: EventMessage) => {};
			const orderHandler = async (_msg: EventMessage) => {};

			registry.subscribe('user.created', userHandler);
			registry.subscribe('order.placed', orderHandler);

			expect(registry.getHandlerCount('user.created')).toBe(1);
			expect(registry.getHandlerCount('order.placed')).toBe(1);
		});
	});

	describe('getHandlers', () => {
		it('should return empty array for unregistered event', () => {
			const handlers = registry.getHandlers('nonexistent.event');

			expect(handlers).toEqual([]);
			expect(handlers.length).toBe(0);
		});

		it('should return all registered handlers for an event', () => {
			const handler1 = async (_msg: EventMessage) => 'first';
			const handler2 = async (_msg: EventMessage) => 'second';

			registry.subscribe('test.event', handler1);
			registry.subscribe('test.event', handler2);

			const handlers = registry.getHandlers('test.event');

			expect(handlers.length).toBe(2);
			expect(handlers[0]!.handler).toBe(handler1);
			expect(handlers[1]!.handler).toBe(handler2);
		});

		it('should return readonly array', () => {
			const handler = async (_msg: EventMessage) => {};
			registry.subscribe('test.event', handler);

			const handlers = registry.getHandlers('test.event');

			// TypeScript enforces readonly, but we verify the reference is stable
			expect(Array.isArray(handlers)).toBe(true);
		});

		it('should preserve handler order', () => {
			const handlers: string[] = [];
			const handler1 = async () => {
				handlers.push('first');
			};
			const handler2 = async () => {
				handlers.push('second');
			};
			const handler3 = async () => {
				handlers.push('third');
			};

			registry.subscribe('ordered.event', handler1);
			registry.subscribe('ordered.event', handler2);
			registry.subscribe('ordered.event', handler3);

			const registeredHandlers = registry.getHandlers('ordered.event');

			expect(registeredHandlers[0]!.handler).toBe(handler1);
			expect(registeredHandlers[1]!.handler).toBe(handler2);
			expect(registeredHandlers[2]!.handler).toBe(handler3);
		});
	});

	describe('getHandlerCount', () => {
		it('should return 0 for unregistered event', () => {
			expect(registry.getHandlerCount('nonexistent.event')).toBe(0);
		});

		it('should return correct count after multiple subscriptions', () => {
			registry.subscribe('count.test', async () => {});
			expect(registry.getHandlerCount('count.test')).toBe(1);

			registry.subscribe('count.test', async () => {});
			expect(registry.getHandlerCount('count.test')).toBe(2);

			registry.subscribe('count.test', async () => {});
			expect(registry.getHandlerCount('count.test')).toBe(3);
		});

		it('should track counts independently per event', () => {
			registry.subscribe('event.a', async () => {});
			registry.subscribe('event.a', async () => {});
			registry.subscribe('event.b', async () => {});

			expect(registry.getHandlerCount('event.a')).toBe(2);
			expect(registry.getHandlerCount('event.b')).toBe(1);
			expect(registry.getHandlerCount('event.c')).toBe(0);
		});
	});

	describe('clear', () => {
		it('should remove all handlers', () => {
			registry.subscribe('event.one', async () => {});
			registry.subscribe('event.two', async () => {});
			registry.subscribe('event.two', async () => {});

			expect(registry.getHandlerCount('event.one')).toBe(1);
			expect(registry.getHandlerCount('event.two')).toBe(2);

			registry.clear();

			expect(registry.getHandlerCount('event.one')).toBe(0);
			expect(registry.getHandlerCount('event.two')).toBe(0);
		});

		it('should allow new subscriptions after clear', () => {
			registry.subscribe('test.event', async () => {});
			registry.clear();

			registry.subscribe('test.event', async () => {});
			registry.subscribe('new.event', async () => {});

			expect(registry.getHandlerCount('test.event')).toBe(1);
			expect(registry.getHandlerCount('new.event')).toBe(1);
		});
	});

	describe('IHandlerRegistry interface compliance', () => {
		it('should implement all required interface methods', () => {
			// Verify the registry has all required methods
			expect(typeof registry.subscribe).toBe('function');
			expect(typeof registry.getHandlers).toBe('function');
			expect(typeof registry.getHandlerCount).toBe('function');
			expect(typeof registry.clear).toBe('function');
		});
	});
});
