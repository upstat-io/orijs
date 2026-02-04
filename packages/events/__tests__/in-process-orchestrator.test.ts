/**
 * Tests for InProcessEventProvider
 *
 * Covers:
 * - Fire-and-forget pattern
 * - Request-response pattern
 * - Delayed events
 * - Error handling
 * - Context propagation
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { InProcessEventProvider } from '../src/in-process-orchestrator.ts';
import type { EventMessage } from '../src/event-provider.types.ts';
import type { PropagationMeta } from '@orijs/logging';
import { Logger } from '@orijs/logging';

describe('InProcessEventProvider', () => {
	let provider: InProcessEventProvider;

	beforeEach(() => {
		Logger.reset();
		provider = new InProcessEventProvider();
	});

	afterEach(async () => {
		await provider.stop();
	});

	describe('fire-and-forget pattern', () => {
		it('should deliver event to subscriber', async () => {
			const received: unknown[] = [];

			provider.subscribe('test.event', async (msg: EventMessage) => {
				received.push(msg.payload);
			});

			const meta: PropagationMeta = { correlationId: 'req-1' };
			provider.emit('test.event', { value: 42 }, meta);

			// Wait for async delivery
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received).toHaveLength(1);
			expect(received[0]).toEqual({ value: 42 });
		});

		it('should deliver event to multiple subscribers', async () => {
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			provider.subscribe('test.event', async (msg: EventMessage) => {
				received1.push(msg.payload);
			});

			provider.subscribe('test.event', async (msg: EventMessage) => {
				received2.push(msg.payload);
			});

			const meta: PropagationMeta = {};
			provider.emit('test.event', { value: 1 }, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(received1).toHaveLength(1);
			expect(received2).toHaveLength(1);
		});

		it('should not block when no subscribers exist', () => {
			const meta: PropagationMeta = {};
			const subscription = provider.emit('unknown.event', {}, meta);

			// Should not throw
			expect(subscription).toBeDefined();
			expect(subscription.isSettled()).toBe(false);
		});

		it('should propagate metadata to handler', async () => {
			let receivedMeta: PropagationMeta | null = null;

			provider.subscribe('test.event', async (msg: EventMessage) => {
				receivedMeta = msg.meta;
			});

			const meta: PropagationMeta = {
				correlationId: 'req-123',
				userId: 'user-456'
			};
			provider.emit('test.event', {}, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedMeta).not.toBeNull();
			expect(receivedMeta!.correlationId).toBe('req-123');
			expect(receivedMeta!.userId).toBe('user-456');
		});
	});

	describe('request-response pattern', () => {
		it('should return handler result via subscribe callback', async () => {
			let result: unknown = null;

			provider.subscribe<{ value: number }, { doubled: number }>(
				'double.event',
				async (msg: EventMessage<{ value: number }>) => {
					return { doubled: (msg.payload as { value: number }).value * 2 };
				}
			);

			const meta: PropagationMeta = {};
			provider
				.emit<{ doubled: number }>('double.event', { value: 21 }, meta)
				.subscribe((r: { doubled: number }) => {
					result = r;
				});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(result).toEqual({ doubled: 42 });
		});

		it('should handle handler errors via catch callback', async () => {
			let error: Error | null = null;

			provider.subscribe('error.event', async () => {
				throw new Error('Handler failed');
			});

			const meta: PropagationMeta = {};
			provider.emit('error.event', {}, meta).catch((e: Error) => {
				error = e;
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(error).not.toBeNull();
			expect(error!.message).toBe('Handler failed');
		});

		it('should resolve with undefined when handler returns nothing', async () => {
			let called = false;
			let result: unknown = 'not-set';

			provider.subscribe('void.event', async () => {
				// No return value
			});

			const meta: PropagationMeta = {};
			provider.emit('void.event', {}, meta).subscribe((r: void) => {
				called = true;
				result = r;
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(called).toBe(true);
			expect(result).toBeUndefined();
		});

		it('should include correlationId in message', async () => {
			let receivedCorrelationId = '';

			provider.subscribe('test.event', async (msg: EventMessage) => {
				receivedCorrelationId = msg.correlationId;
			});

			const meta: PropagationMeta = {};
			const subscription = provider.emit('test.event', {}, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedCorrelationId).not.toBe('');
			expect(receivedCorrelationId).toBe(subscription.correlationId);
		});
	});

	describe('delayed events', () => {
		it('should delay event delivery', async () => {
			const timestamps: number[] = [];

			provider.subscribe('delayed.event', async () => {
				timestamps.push(Date.now());
			});

			const startTime = Date.now();
			const meta: PropagationMeta = {};
			provider.emit('delayed.event', {}, meta, { delay: 50 });

			// Should not be delivered yet
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(timestamps).toHaveLength(0);

			// Wait for delivery
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(timestamps).toHaveLength(1);
			expect(timestamps[0]! - startTime).toBeGreaterThanOrEqual(45); // Allow some tolerance
		});

		it('should treat zero delay as immediate', async () => {
			let delivered = false;

			provider.subscribe('test.event', async () => {
				delivered = true;
			});

			const meta: PropagationMeta = {};
			provider.emit('test.event', {}, meta, { delay: 0 });

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(delivered).toBe(true);
		});

		it('should treat negative delay as immediate', async () => {
			let delivered = false;

			provider.subscribe('test.event', async () => {
				delivered = true;
			});

			const meta: PropagationMeta = {};
			provider.emit('test.event', {}, meta, { delay: -100 });

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(delivered).toBe(true);
		});

		it('should cancel delayed events on stop', async () => {
			let delivered = false;

			provider.subscribe('delayed.event', async () => {
				delivered = true;
			});

			const meta: PropagationMeta = {};
			provider.emit('delayed.event', {}, meta, { delay: 100 });

			// Stop before delivery
			await provider.stop();

			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(delivered).toBe(false);
		});
	});

	describe('lifecycle', () => {
		it('should track started state', async () => {
			expect(provider.isStarted()).toBe(false);

			await provider.start();
			expect(provider.isStarted()).toBe(true);

			await provider.stop();
			expect(provider.isStarted()).toBe(false);
		});

		it('should report handler count', () => {
			expect(provider.getHandlerCount('test.event')).toBe(0);

			provider.subscribe('test.event', async () => {});
			expect(provider.getHandlerCount('test.event')).toBe(1);

			provider.subscribe('test.event', async () => {});
			expect(provider.getHandlerCount('test.event')).toBe(2);

			expect(provider.getHandlerCount('other.event')).toBe(0);
		});
	});

	describe('causation tracking', () => {
		it('should pass causationId to handler when provided', async () => {
			let receivedCausationId: string | undefined;

			provider.subscribe('test.event', async (msg: EventMessage) => {
				receivedCausationId = msg.causationId;
			});

			const meta: PropagationMeta = {};
			provider.emit('test.event', {}, meta, { causationId: 'parent-event-123' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedCausationId).toBe('parent-event-123');
		});

		it('should not have causationId when not provided', async () => {
			let receivedCausationId: string | undefined = 'initial';

			provider.subscribe('test.event', async (msg: EventMessage) => {
				receivedCausationId = msg.causationId;
			});

			const meta: PropagationMeta = {};
			provider.emit('test.event', {}, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedCausationId).toBeUndefined();
		});
	});

	describe('idempotency', () => {
		it('should deduplicate events with same idempotencyKey', async () => {
			let deliveryCount = 0;

			provider.subscribe('test.event', async () => {
				deliveryCount++;
				return { processed: true };
			});

			const meta: PropagationMeta = {};
			const idempotencyKey = 'unique-key-123';

			// Emit same event twice with same idempotency key
			const subscription1 = provider.emit('test.event', { value: 1 }, meta, { idempotencyKey });
			const subscription2 = provider.emit('test.event', { value: 2 }, meta, { idempotencyKey });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// First emission should deliver
			expect(subscription1.isSettled()).toBe(true);
			// Second emission should be skipped (resolved with undefined)
			expect(subscription2.isSettled()).toBe(true);
			// Handler should only be called once
			expect(deliveryCount).toBe(1);
		});

		it('should allow different idempotencyKeys to deliver separately', async () => {
			let deliveryCount = 0;

			provider.subscribe('test.event', async () => {
				deliveryCount++;
			});

			const meta: PropagationMeta = {};

			// Emit with different keys
			provider.emit('test.event', {}, meta, { idempotencyKey: 'key-1' });
			provider.emit('test.event', {}, meta, { idempotencyKey: 'key-2' });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Both should deliver since different keys
			expect(deliveryCount).toBe(2);
		});

		it('should deliver events without idempotencyKey normally', async () => {
			let deliveryCount = 0;

			provider.subscribe('test.event', async () => {
				deliveryCount++;
			});

			const meta: PropagationMeta = {};

			// Emit twice without idempotency key
			provider.emit('test.event', {}, meta);
			provider.emit('test.event', {}, meta);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Both should deliver
			expect(deliveryCount).toBe(2);
		});

		it('should clear idempotency keys on stop', async () => {
			let deliveryCount = 0;

			provider.subscribe('test.event', async () => {
				deliveryCount++;
			});

			const meta: PropagationMeta = {};
			const idempotencyKey = 'reset-key';

			// Emit first time
			provider.emit('test.event', {}, meta, { idempotencyKey });
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(deliveryCount).toBe(1);

			// Stop and restart provider (simulating process restart)
			await provider.stop();
			provider = new InProcessEventProvider();
			provider.subscribe('test.event', async () => {
				deliveryCount++;
			});

			// Emit again with same key - should deliver since keys were cleared
			provider.emit('test.event', {}, meta, { idempotencyKey });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(deliveryCount).toBe(2);
		});

		it('should resolve duplicate emission with undefined', async () => {
			let result: unknown = 'not-set';

			provider.subscribe('test.event', async () => {
				return { success: true };
			});

			const meta: PropagationMeta = {};
			const idempotencyKey = 'dup-key';

			// First emission
			provider.emit('test.event', {}, meta, { idempotencyKey });

			// Second emission (duplicate)
			const duplicateSubscription = provider.emit('test.event', {}, meta, { idempotencyKey });
			duplicateSubscription.subscribe((r) => {
				result = r;
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Duplicate should resolve with undefined
			expect(result).toBeUndefined();
		});
	});
});
