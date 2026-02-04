/**
 * Tests for EventContext
 *
 * Covers:
 * - createEventContext() factory function
 * - Context immutability (Object.freeze)
 * - Logger creation with propagated metadata
 * - createChainedMeta() for event chaining
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createEventContext, createChainedMeta } from '../src/event-context.ts';
import { EVENT_MESSAGE_VERSION, type EventMessage } from '../src/event-provider.types.ts';
import type { PropagationMeta } from '@orijs/logging';
import type { EventEmitFn } from '../src/event-context.ts';
import { Logger } from '@orijs/logging';

describe('createEventContext', () => {
	// oxlint-disable-next-line unicorn/no-thenable -- Mock implements EventSubscription interface which has then()
	const mockEmitFn = mock(() => ({
		correlationId: 'test',
		_resolve: () => {},
		_reject: () => {},
		subscribe: () => {},
		catch: () => {},
		then: () => Promise.resolve(),
		toPromise: () => Promise.resolve()
	})) as unknown as EventEmitFn;

	const createTestMessage = (overrides: Partial<EventMessage> = {}): EventMessage => ({
		version: EVENT_MESSAGE_VERSION,
		eventId: 'evt-' + Math.random().toString(36).slice(2),
		eventName: 'test.event',
		payload: { key: 'value' },
		meta: { correlationId: 'req-123', userId: 'user-456' },
		correlationId: 'corr-789',
		causationId: 'cause-111',
		timestamp: 1704067200000,
		...overrides
	});

	beforeEach(() => {
		Logger.reset();
	});

	describe('context creation', () => {
		it('should create context with all required properties', () => {
			const message = createTestMessage({ eventId: 'evt-test-fixed-id' });
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn
			});

			expect(ctx.eventId).toBe('evt-test-fixed-id');
			expect(ctx.data).toEqual({ key: 'value' });
			expect(ctx.correlationId).toBe('corr-789');
			expect(ctx.causationId).toBe('cause-111');
			expect(ctx.eventName).toBe('test.event');
			expect(ctx.timestamp).toBe(1704067200000);
			expect(typeof ctx.emit).toBe('function');
			expect(ctx.log).toBeInstanceOf(Logger);
		});

		it('should create context without causationId when not provided', () => {
			const message = createTestMessage({ causationId: undefined });
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn
			});

			expect(ctx.causationId).toBeUndefined();
		});

		it('should use event name as default logger name', () => {
			const message = createTestMessage({ eventName: 'order.placed' });
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn
			});

			// Logger name is derived from event name
			expect(ctx.log).toBeInstanceOf(Logger);
		});

		it('should use custom logger name when provided', () => {
			const message = createTestMessage();
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn,
				loggerName: 'CustomHandler'
			});

			expect(ctx.log).toBeInstanceOf(Logger);
		});
	});

	describe('immutability', () => {
		it('should return a frozen object', () => {
			const message = createTestMessage();
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn
			});

			expect(Object.isFrozen(ctx)).toBe(true);
		});

		it('should not allow property modification', () => {
			const message = createTestMessage();
			const ctx = createEventContext({
				message,
				emitFn: mockEmitFn
			});

			// TypeScript prevents this at compile time, but runtime should also throw
			expect(() => {
				(ctx as any).data = { modified: true };
			}).toThrow();
		});
	});

	describe('typed payload access', () => {
		it('should provide typed access to payload data', () => {
			interface OrderPayload {
				orderId: string;
				amount: number;
			}

			const message = createTestMessage({
				payload: { orderId: 'order-123', amount: 99.99 }
			});

			const ctx = createEventContext<OrderPayload>({
				message,
				emitFn: mockEmitFn
			});

			// TypeScript knows these properties exist
			expect(ctx.data.orderId).toBe('order-123');
			expect(ctx.data.amount).toBe(99.99);
		});
	});

	describe('emit function', () => {
		it('should pass through emit function', () => {
			const calls: unknown[][] = [];
			const trackingEmit = ((...args: unknown[]) => {
				calls.push(args);
				return { correlationId: 'test' };
			}) as unknown as EventEmitFn;

			const message = createTestMessage();
			const ctx = createEventContext({
				message,
				emitFn: trackingEmit
			});

			ctx.emit('another.event', { data: 'test' });

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual(['another.event', { data: 'test' }]);
		});

		it('should support emit options', () => {
			const calls: unknown[][] = [];
			const trackingEmit = ((...args: unknown[]) => {
				calls.push(args);
				return { correlationId: 'test' };
			}) as unknown as EventEmitFn;

			const message = createTestMessage();
			const ctx = createEventContext({
				message,
				emitFn: trackingEmit
			});

			ctx.emit('delayed.event', { data: 'test' }, { delay: 1000 });

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual(['delayed.event', { data: 'test' }, { delay: 1000 }]);
		});
	});
});

describe('createChainedMeta', () => {
	it('should return parent meta and correlation id as causation id', () => {
		const parentMeta: PropagationMeta = {
			correlationId: 'req-123',
			userId: 'user-456',
			account_id: 'acc-789'
		};

		const result = createChainedMeta(parentMeta, 'parent-correlation-id');

		expect(result.meta).toBe(parentMeta);
		expect(result.causationId).toBe('parent-correlation-id');
	});

	it('should preserve all parent metadata', () => {
		const parentMeta: PropagationMeta = {
			correlationId: 'req-123',
			custom_field: 'custom-value'
		};

		const result = createChainedMeta(parentMeta, 'corr-id');

		expect(result.meta.correlationId).toBe('req-123');
		expect(result.meta.custom_field).toBe('custom-value');
	});

	it('should work with empty parent meta', () => {
		const parentMeta: PropagationMeta = {};

		const result = createChainedMeta(parentMeta, 'corr-id');

		expect(result.meta).toEqual({});
		expect(result.causationId).toBe('corr-id');
	});
});
