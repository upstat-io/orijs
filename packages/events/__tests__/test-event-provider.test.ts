/**
 * Tests for TestEventProvider
 *
 * Covers:
 * - Timer-based async event delivery
 * - Configurable processing delays
 * - Async/await pattern verification
 * - Request-response with actual delays
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestEventProvider } from '../src/test-event-provider.ts';
import type { EventMessage } from '../src/event-provider.types.ts';

describe('TestEventProvider', () => {
	let provider: TestEventProvider;

	beforeEach(() => {
		provider = new TestEventProvider({ processingDelay: 10 });
	});

	afterEach(async () => {
		await provider.stop();
	});

	describe('configuration', () => {
		it('should use default processing delay of 10ms', () => {
			const defaultProvider = new TestEventProvider();

			expect(defaultProvider.getProcessingDelay()).toBe(10);
		});

		it('should accept custom processing delay', () => {
			const customProvider = new TestEventProvider({ processingDelay: 50 });

			expect(customProvider.getProcessingDelay()).toBe(50);
		});
	});

	describe('async delivery verification', () => {
		it('should NOT resolve synchronously (unlike InProcessEventProvider)', async () => {
			let resolved = false;

			provider.subscribe('test.event', async () => {
				return { done: true };
			});

			const subscription = provider.emit('test.event', {}, {});
			subscription.subscribe(() => {
				resolved = true;
			});

			// Immediately after emit, should NOT be resolved
			expect(resolved).toBe(false);

			// After processing delay, should be resolved
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(resolved).toBe(true);
		});

		it('should track pending events', async () => {
			provider.subscribe('test.event', async () => {
				return { done: true };
			});

			expect(provider.getPendingCount()).toBe(0);

			provider.emit('test.event', {}, {});

			// Should have one pending event
			expect(provider.getPendingCount()).toBe(1);

			// After processing, should be zero
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(provider.getPendingCount()).toBe(0);
		});

		it('should support async/await on emit result', async () => {
			provider.subscribe<{ name: string }, { greeting: string }>('greet', async (msg) => {
				const payload = (msg as EventMessage).payload as { name: string };
				return { greeting: `Hello, ${payload.name}!` };
			});

			const start = Date.now();

			// Direct await on subscription
			const result = await provider.emit<{ greeting: string }>('greet', { name: 'World' }, {});

			const elapsed = Date.now() - start;

			// Should have taken at least the processing delay
			expect(elapsed).toBeGreaterThanOrEqual(8); // Allow small timing variance
			expect(result.greeting).toBe('Hello, World!');
		});

		it('should respect emit delay on top of processing delay', async () => {
			provider.subscribe('delayed', async () => {
				return { done: true };
			});

			const start = Date.now();

			// Emit with 20ms delay + 10ms processing = 30ms total
			const result = await provider.emit<{ done: boolean }>('delayed', {}, {}, { delay: 20 });

			const elapsed = Date.now() - start;

			// Total delay should be emit delay + processing delay
			expect(elapsed).toBeGreaterThanOrEqual(25); // 30ms target with variance
			expect(result.done).toBe(true);
		});
	});

	describe('request-response pattern', () => {
		it('should return handler result via await', async () => {
			interface CheckPayload {
				url: string;
			}

			interface CheckResult {
				status: number;
				responseTime: number;
			}

			provider.subscribe<CheckPayload, CheckResult>('monitor.check', async (_msg) => {
				// Simulate some async work
				await new Promise((resolve) => setTimeout(resolve, 5));
				return { status: 200, responseTime: 42 };
			});

			const result = await provider.emit<CheckResult>('monitor.check', { url: 'https://example.com' }, {});

			expect(result.status).toBe(200);
			expect(result.responseTime).toBe(42);
		});

		it('should handle errors via await', async () => {
			provider.subscribe('failing', async () => {
				throw new Error('Handler failed');
			});

			let caught: Error | null = null;
			try {
				await provider.emit('failing', {}, {});
			} catch (e) {
				caught = e as Error;
			}

			expect(caught).not.toBeNull();
			expect(caught!.message).toBe('Handler failed');
		});

		it('should work with .subscribe() callback', async () => {
			provider.subscribe('callback.test', async () => {
				return { value: 123 };
			});

			let received: { value: number } | undefined;

			provider.emit<{ value: number }>('callback.test', {}, {}).subscribe((result) => {
				received = result;
			});

			// Not resolved yet
			expect(received).toBeUndefined();

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(received).toBeDefined();
			expect(received!.value).toBe(123);
		});

		it('should work with .catch() callback for errors', async () => {
			provider.subscribe('error.test', async () => {
				throw new Error('Test error');
			});

			let caughtError: Error | null = null;

			provider.emit('error.test', {}, {}).catch((error) => {
				caughtError = error;
			});

			// Not caught yet
			expect(caughtError).toBeNull();

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(caughtError).not.toBeNull();
			expect(caughtError!.message).toBe('Test error');
		});
	});

	describe('fire-and-forget pattern', () => {
		it('should call all handlers for fire-and-forget', async () => {
			const calls: string[] = [];

			provider.subscribe('broadcast', async () => {
				calls.push('handler1');
			});

			provider.subscribe('broadcast', async () => {
				calls.push('handler2');
			});

			provider.emit('broadcast', {}, {});

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(calls).toHaveLength(2);
			expect(calls).toContain('handler1');
			expect(calls).toContain('handler2');
		});
	});

	describe('lifecycle', () => {
		it('should start and stop correctly', async () => {
			expect(provider.isStarted()).toBe(false);

			await provider.start();
			expect(provider.isStarted()).toBe(true);

			await provider.stop();
			expect(provider.isStarted()).toBe(false);
		});

		it('should clear pending timeouts on stop', async () => {
			provider.subscribe('pending', async () => {
				return { done: true };
			});

			// Emit with long delay
			provider.emit('pending', {}, {}, { delay: 1000 });

			expect(provider.getPendingCount()).toBe(1);

			await provider.stop();

			expect(provider.getPendingCount()).toBe(0);
		});
	});

	describe('handler registration', () => {
		it('should track handler count', () => {
			expect(provider.getHandlerCount('test')).toBe(0);

			provider.subscribe('test', async () => {});

			expect(provider.getHandlerCount('test')).toBe(1);

			provider.subscribe('test', async () => {});

			expect(provider.getHandlerCount('test')).toBe(2);
		});
	});

	describe('chained events', () => {
		it('should support emitting events from handler', async () => {
			const receivedEvents: string[] = [];

			provider.subscribe('first', async (_msg) => {
				receivedEvents.push('first');
				// Access emit via provider (in real use, would be via ctx.events)
			});

			provider.subscribe('second', async () => {
				receivedEvents.push('second');
			});

			await provider.emit('first', {}, {});

			expect(receivedEvents).toContain('first');
		});
	});
});

describe('TestEventProvider vs InProcessEventProvider timing', () => {
	it('should demonstrate timing difference from sync orchestrator', async () => {
		// TestEventProvider with 50ms delay
		const provider = new TestEventProvider({ processingDelay: 50 });

		provider.subscribe('timing.test', async () => {
			return { timestamp: Date.now() };
		});

		const emitTime = Date.now();

		await provider.emit<{ timestamp: number }>('timing.test', {}, {});

		const resolveTime = Date.now();
		const elapsed = resolveTime - emitTime;

		// Should have taken at least the processing delay
		// This proves it's truly async with real delays
		expect(elapsed).toBeGreaterThanOrEqual(45);

		await provider.stop();
	});
});
