/**
 * Tests for EventSubscription
 *
 * Covers:
 * - Resolve/reject lifecycle
 * - Callback invocation timing
 * - State tracking
 * - Chaining
 */

import { describe, it, expect } from 'bun:test';
import { EventSubscription, createSubscription } from '../src/event-subscription.ts';

describe('EventSubscription', () => {
	describe('construction', () => {
		it('should create subscription with correlationId', () => {
			const subscription = new EventSubscription<string>('corr-123');

			expect(subscription.correlationId).toBe('corr-123');
		});

		it('should start in unsettled state', () => {
			const subscription = new EventSubscription<string>('corr-123');

			expect(subscription.isSettled()).toBe(false);
			expect(subscription.isResolved()).toBe(false);
			expect(subscription.isRejected()).toBe(false);
		});
	});

	describe('createSubscription helper', () => {
		it('should create subscription with generated correlationId', () => {
			const subscription = createSubscription<number>();

			expect(subscription.correlationId).toBeDefined();
			expect(subscription.correlationId.length).toBe(36); // UUID format
		});

		it('should create unique correlationIds', () => {
			const sub1 = createSubscription<number>();
			const sub2 = createSubscription<number>();

			expect(sub1.correlationId).not.toBe(sub2.correlationId);
		});
	});

	describe('resolve', () => {
		it('should invoke subscribe callback with value', () => {
			const subscription = new EventSubscription<{ result: number }>('corr-123');
			let received: { result: number } | undefined = undefined;

			subscription.subscribe((value) => {
				received = value;
			});

			subscription._resolve({ result: 42 });

			expect(received).toBeDefined();
			expect(received!.result).toBe(42);
		});

		it('should mark as resolved after _resolve', () => {
			const subscription = new EventSubscription<string>('corr-123');

			subscription._resolve('done');

			expect(subscription.isResolved()).toBe(true);
			expect(subscription.isRejected()).toBe(false);
			expect(subscription.isSettled()).toBe(true);
		});

		it('should invoke callback immediately if already resolved', () => {
			const subscription = new EventSubscription<string>('corr-123');
			subscription._resolve('already-done');

			let received = '';
			subscription.subscribe((value) => {
				received = value;
			});

			expect(received).toBe('already-done');
		});

		it('should ignore subsequent resolves', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let callCount = 0;

			subscription.subscribe(() => {
				callCount++;
			});

			subscription._resolve('first');
			subscription._resolve('second');
			subscription._resolve('third');

			expect(callCount).toBe(1);
		});

		it('should work without subscribe callback', () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Should not throw
			subscription._resolve('value');

			expect(subscription.isResolved()).toBe(true);
		});
	});

	describe('reject', () => {
		it('should invoke catch callback with error', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let received: Error | null = null;

			subscription.catch((error) => {
				received = error;
			});

			subscription._reject(new Error('Handler failed'));

			expect(received).not.toBeNull();
			expect(received!.message).toBe('Handler failed');
		});

		it('should mark as rejected after _reject', () => {
			const subscription = new EventSubscription<string>('corr-123');

			subscription._reject(new Error('Failed'));

			expect(subscription.isResolved()).toBe(false);
			expect(subscription.isRejected()).toBe(true);
			expect(subscription.isSettled()).toBe(true);
		});

		it('should invoke callback immediately if already rejected', () => {
			const subscription = new EventSubscription<string>('corr-123');
			subscription._reject(new Error('already-failed'));

			let received: Error | null = null;
			subscription.catch((error) => {
				received = error;
			});

			expect(received).not.toBeNull();
			expect(received!.message).toBe('already-failed');
		});

		it('should ignore subsequent rejects', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let callCount = 0;

			subscription.catch(() => {
				callCount++;
			});

			subscription._reject(new Error('first'));
			subscription._reject(new Error('second'));
			subscription._reject(new Error('third'));

			expect(callCount).toBe(1);
		});

		it('should work without catch callback', () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Should not throw
			subscription._reject(new Error('value'));

			expect(subscription.isRejected()).toBe(true);
		});
	});

	describe('settlement priority', () => {
		it('should ignore reject after resolve', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let resolveCount = 0;
			let rejectCount = 0;

			subscription.subscribe(() => {
				resolveCount++;
			});
			subscription.catch(() => {
				rejectCount++;
			});

			subscription._resolve('done');
			subscription._reject(new Error('fail'));

			expect(resolveCount).toBe(1);
			expect(rejectCount).toBe(0);
			expect(subscription.isResolved()).toBe(true);
			expect(subscription.isRejected()).toBe(false);
		});

		it('should ignore resolve after reject', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let resolveCount = 0;
			let rejectCount = 0;

			subscription.subscribe(() => {
				resolveCount++;
			});
			subscription.catch(() => {
				rejectCount++;
			});

			subscription._reject(new Error('fail'));
			subscription._resolve('done');

			expect(resolveCount).toBe(0);
			expect(rejectCount).toBe(1);
			expect(subscription.isResolved()).toBe(false);
			expect(subscription.isRejected()).toBe(true);
		});
	});

	describe('chaining', () => {
		it('should return this from subscribe', () => {
			const subscription = new EventSubscription<string>('corr-123');

			const result = subscription.subscribe(() => {});

			expect(result).toBe(subscription);
		});

		it('should return this from catch', () => {
			const subscription = new EventSubscription<string>('corr-123');

			const result = subscription.catch(() => {});

			expect(result).toBe(subscription);
		});

		it('should support fluent chaining', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let subscribeValue = '';
			let catchCalled = false;

			subscription
				.subscribe((value) => {
					subscribeValue = value;
				})
				.catch(() => {
					catchCalled = true;
				});

			subscription._resolve('result');

			expect(subscribeValue).toBe('result');
			expect(catchCalled).toBe(false);
		});

		it('should support reverse chaining order', () => {
			const subscription = new EventSubscription<string>('corr-123');
			let subscribeValue: string | null = null;
			let catchError: Error | null = null;

			subscription
				.catch((error) => {
					catchError = error;
				})
				.subscribe((value) => {
					subscribeValue = value;
				});

			subscription._reject(new Error('error'));

			expect(subscribeValue).toBeNull();
			expect(catchError).not.toBeNull();
			expect(catchError!.message).toBe('error');
		});
	});

	describe('async/await support', () => {
		it('should be directly awaitable via then()', async () => {
			const subscription = new EventSubscription<{ value: number }>('corr-123');

			// Resolve after a short delay
			setTimeout(() => subscription._resolve({ value: 42 }), 10);

			// Direct await
			const result = await subscription;

			expect(result.value).toBe(42);
		});

		it('should reject when awaited and handler throws', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Reject after a short delay
			setTimeout(() => subscription._reject(new Error('Handler failed')), 10);

			// Await should throw
			let caught: Error | null = null;
			try {
				await subscription;
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).not.toBeNull();
			expect(caught!.message).toBe('Handler failed');
		});

		it('should resolve immediately if already resolved when awaited', async () => {
			const subscription = new EventSubscription<string>('corr-123');
			subscription._resolve('already-done');

			// Direct await should resolve immediately
			const result = await subscription;

			expect(result).toBe('already-done');
		});

		it('should support toPromise() for explicit conversion', async () => {
			const subscription = new EventSubscription<number>('corr-123');

			// Resolve after a short delay
			setTimeout(() => subscription._resolve(123), 10);

			const result = await subscription.toPromise();

			expect(result).toBe(123);
		});

		it('should reuse the same promise on multiple toPromise() calls', () => {
			const subscription = new EventSubscription<string>('corr-123');

			const promise1 = subscription.toPromise();
			const promise2 = subscription.toPromise();

			expect(promise1).toBe(promise2);
		});

		it('should work with void return type when awaited', async () => {
			const subscription = new EventSubscription<void>('corr-123');

			setTimeout(() => subscription._resolve(undefined), 10);

			// Should not throw
			await subscription;
		});
	});

	describe('type safety', () => {
		it('should preserve type through resolve', () => {
			interface CustomResult {
				id: number;
				name: string;
			}

			const subscription = new EventSubscription<CustomResult>('corr-123');
			let received: CustomResult | undefined = undefined;

			subscription.subscribe((value) => {
				// TypeScript should infer value as CustomResult
				received = value;
			});

			subscription._resolve({ id: 1, name: 'test' });

			expect(received).toBeDefined();
			expect(received!.id).toBe(1);
			expect(received!.name).toBe('test');
		});

		it('should work with void return type', () => {
			const subscription = new EventSubscription<void>('corr-123');
			let called = false;

			subscription.subscribe(() => {
				called = true;
			});

			subscription._resolve(undefined);

			expect(called).toBe(true);
		});
	});

	describe('timeout support', () => {
		it('should resolve before timeout if handler responds in time', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Resolve quickly (10ms)
			setTimeout(() => subscription._resolve('fast-result'), 10);

			// Wait with generous timeout (500ms)
			const result = await subscription.toPromise(500);

			expect(result).toBe('fast-result');
		});

		it('should reject with timeout error when handler does not respond', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Don't resolve - let it timeout

			let caught: Error | null = null;
			try {
				await subscription.toPromise(50); // 50ms timeout
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).not.toBeNull();
			expect(caught!.message).toBe('EventSubscription timeout after 50ms');
		});

		it('should not timeout if already resolved', async () => {
			const subscription = new EventSubscription<string>('corr-123');
			subscription._resolve('already-done');

			// Even with very short timeout, should resolve immediately
			const result = await subscription.toPromise(1);

			expect(result).toBe('already-done');
		});

		it('should not timeout if already rejected', async () => {
			const subscription = new EventSubscription<string>('corr-123');
			subscription._reject(new Error('already-failed'));

			// Even with very short timeout, should reject with original error
			let caught: Error | null = null;
			try {
				await subscription.toPromise(1);
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).not.toBeNull();
			expect(caught!.message).toBe('already-failed');
		});

		it('should not apply timeout when timeoutMs is 0', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Resolve after short delay
			setTimeout(() => subscription._resolve('result'), 10);

			// Zero timeout means no timeout
			const result = await subscription.toPromise(0);

			expect(result).toBe('result');
		});

		it('should not apply timeout when timeoutMs is negative', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Resolve after short delay
			setTimeout(() => subscription._resolve('result'), 10);

			// Negative timeout means no timeout
			const result = await subscription.toPromise(-100);

			expect(result).toBe('result');
		});

		it('should clear timeout when resolved', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Start promise with timeout
			const promise = subscription.toPromise(100);

			// Resolve before timeout
			subscription._resolve('quick-result');

			const result = await promise;

			expect(result).toBe('quick-result');
			// If timeout wasn't cleared, there would be a memory leak
			// (can't easily test this, but implementation clears it)
		});

		it('should clear timeout when rejected', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Start promise with timeout
			const promise = subscription.toPromise(100);

			// Reject before timeout
			subscription._reject(new Error('quick-error'));

			let caught: Error | null = null;
			try {
				await promise;
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).not.toBeNull();
			expect(caught!.message).toBe('quick-error');
		});

		it('should work with different timeout values for same subscription', async () => {
			const subscription = new EventSubscription<string>('corr-123');

			// Don't resolve - will timeout

			// First call with longer timeout
			const promise1 = subscription.toPromise(200);

			// Second call with shorter timeout
			const promise2 = subscription.toPromise(30);

			// The shorter timeout should reject first
			let caught2: Error | null = null;
			try {
				await promise2;
			} catch (e) {
				caught2 = e as Error;
			}

			expect(caught2).not.toBeNull();
			expect(caught2!.message).toBe('EventSubscription timeout after 30ms');

			// Clean up longer timeout by resolving
			subscription._resolve('late-resolve');
			const result1 = await promise1;
			expect(result1).toBe('late-resolve');
		});
	});
});
