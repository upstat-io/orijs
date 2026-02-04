/**
 * Tests for EventIdempotency
 *
 * Covers:
 * - processOnce() deduplication
 * - isProcessed() checks
 * - markProcessed() manual marking
 * - LRU eviction when maxSize exceeded
 * - TTL expiration
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EventIdempotency } from '../src/event-idempotency.ts';

describe('EventIdempotency', () => {
	let idempotency: EventIdempotency;

	beforeEach(() => {
		idempotency = new EventIdempotency();
	});

	describe('processOnce', () => {
		it('should execute handler for new event ID', async () => {
			let callCount = 0;
			const result = await idempotency.processOnce('evt-1', async () => {
				callCount++;
				return 'processed';
			});

			expect(result.executed).toBe(true);
			expect(result.result).toBe('processed');
			expect(callCount).toBe(1);
		});

		it('should skip handler for duplicate event ID', async () => {
			let callCount = 0;
			const handler = async () => {
				callCount++;
				return 'processed';
			};

			const result1 = await idempotency.processOnce('evt-1', handler);
			const result2 = await idempotency.processOnce('evt-1', handler);

			expect(result1.executed).toBe(true);
			expect(result1.result).toBe('processed');
			expect(result2.executed).toBe(false);
			expect(result2.result).toBeUndefined();
			expect(callCount).toBe(1);
		});

		it('should process different event IDs independently', async () => {
			const results: string[] = [];

			await idempotency.processOnce('evt-1', async () => {
				results.push('evt-1');
			});
			await idempotency.processOnce('evt-2', async () => {
				results.push('evt-2');
			});
			await idempotency.processOnce('evt-1', async () => {
				results.push('evt-1-duplicate');
			});

			expect(results).toEqual(['evt-1', 'evt-2']);
		});

		it('should return handler result correctly', async () => {
			const result = await idempotency.processOnce('evt-1', async () => {
				return { orderId: 123, status: 'created' };
			});

			expect(result.executed).toBe(true);
			expect(result.result).toEqual({ orderId: 123, status: 'created' });
		});
	});

	describe('isProcessed', () => {
		it('should return false for unknown event ID', () => {
			expect(idempotency.isProcessed('unknown')).toBe(false);
		});

		it('should return true for processed event ID', async () => {
			await idempotency.processOnce('evt-1', async () => {});

			expect(idempotency.isProcessed('evt-1')).toBe(true);
		});

		it('should return false for expired event ID', async () => {
			const shortTtl = new EventIdempotency({ ttlMs: 50 });
			await shortTtl.processOnce('evt-1', async () => {});

			expect(shortTtl.isProcessed('evt-1')).toBe(true);

			// Wait for TTL to expire
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(shortTtl.isProcessed('evt-1')).toBe(false);
		});
	});

	describe('markProcessed', () => {
		it('should mark event ID as processed', () => {
			idempotency.markProcessed('evt-1');

			expect(idempotency.isProcessed('evt-1')).toBe(true);
		});

		it('should prevent processOnce from executing for marked ID', async () => {
			idempotency.markProcessed('evt-1');

			let executed = false;
			const result = await idempotency.processOnce('evt-1', async () => {
				executed = true;
			});

			expect(result.executed).toBe(false);
			expect(executed).toBe(false);
		});
	});

	describe('clear', () => {
		it('should remove all tracked event IDs', async () => {
			await idempotency.processOnce('evt-1', async () => {});
			await idempotency.processOnce('evt-2', async () => {});
			idempotency.markProcessed('evt-3');

			expect(idempotency.size).toBe(3);

			idempotency.clear();

			expect(idempotency.size).toBe(0);
			expect(idempotency.isProcessed('evt-1')).toBe(false);
			expect(idempotency.isProcessed('evt-2')).toBe(false);
			expect(idempotency.isProcessed('evt-3')).toBe(false);
		});
	});

	describe('size', () => {
		it('should return 0 for new instance', () => {
			expect(idempotency.size).toBe(0);
		});

		it('should track number of processed events', async () => {
			await idempotency.processOnce('evt-1', async () => {});
			expect(idempotency.size).toBe(1);

			await idempotency.processOnce('evt-2', async () => {});
			expect(idempotency.size).toBe(2);

			// Duplicate shouldn't increase size
			await idempotency.processOnce('evt-1', async () => {});
			expect(idempotency.size).toBe(2);
		});
	});

	describe('LRU eviction', () => {
		it('should evict oldest entries when maxSize exceeded', async () => {
			const smallCache = new EventIdempotency({ maxSize: 3 });

			await smallCache.processOnce('evt-1', async () => {});
			await smallCache.processOnce('evt-2', async () => {});
			await smallCache.processOnce('evt-3', async () => {});

			expect(smallCache.size).toBe(3);

			// Adding 4th should evict oldest (evt-1)
			await smallCache.processOnce('evt-4', async () => {});

			expect(smallCache.size).toBe(3);
			expect(smallCache.isProcessed('evt-1')).toBe(false);
			expect(smallCache.isProcessed('evt-2')).toBe(true);
			expect(smallCache.isProcessed('evt-3')).toBe(true);
			expect(smallCache.isProcessed('evt-4')).toBe(true);
		});

		it('should evict from markProcessed as well', () => {
			const smallCache = new EventIdempotency({ maxSize: 2 });

			smallCache.markProcessed('evt-1');
			smallCache.markProcessed('evt-2');
			smallCache.markProcessed('evt-3');

			expect(smallCache.size).toBe(2);
			expect(smallCache.isProcessed('evt-1')).toBe(false);
			expect(smallCache.isProcessed('evt-2')).toBe(true);
			expect(smallCache.isProcessed('evt-3')).toBe(true);
		});
	});

	describe('TTL expiration', () => {
		it('should allow reprocessing after TTL expires', async () => {
			// Use longer TTL and wait times to avoid flakiness under load
			const shortTtl = new EventIdempotency({ ttlMs: 100 });

			let callCount = 0;
			await shortTtl.processOnce('evt-1', async () => {
				callCount++;
			});

			expect(callCount).toBe(1);

			// Wait for TTL to expire (3x TTL for safety margin under load)
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Should be able to process again
			const result = await shortTtl.processOnce('evt-1', async () => {
				callCount++;
				return 'reprocessed';
			});

			expect(result.executed).toBe(true);
			expect(callCount).toBe(2);
		});

		it('should use default TTL of 1 hour', () => {
			const defaultInstance = new EventIdempotency();
			// We can't easily test 1 hour TTL, but we can verify it doesn't
			// expire quickly
			defaultInstance.markProcessed('evt-1');

			// Should still be processed after a short delay
			expect(defaultInstance.isProcessed('evt-1')).toBe(true);
		});
	});

	describe('options', () => {
		it('should use default maxSize of 10000', async () => {
			const defaultInstance = new EventIdempotency();

			// Add 10001 events
			for (let i = 0; i <= 10000; i++) {
				await defaultInstance.processOnce(`evt-${i}`, async () => {});
			}

			expect(defaultInstance.size).toBe(10000);
			// First event should be evicted
			expect(defaultInstance.isProcessed('evt-0')).toBe(false);
			expect(defaultInstance.isProcessed('evt-10000')).toBe(true);
		});

		it('should accept custom options', () => {
			const custom = new EventIdempotency({
				maxSize: 100,
				ttlMs: 60000
			});

			// Instance should be created without error
			expect(custom).toBeInstanceOf(EventIdempotency);
		});
	});
});
