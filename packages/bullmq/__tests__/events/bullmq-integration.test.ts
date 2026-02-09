/**
 * BullMQ Integration Tests
 *
 * Tests the BullMQEventProvider with real Redis via testcontainers.
 * Matches the same test coverage as InProcessEventProvider tests.
 *
 * Covers:
 * - Fire-and-forget pattern
 * - Request-response pattern
 * - Delayed events
 * - Error handling
 * - Context propagation
 * - Lifecycle management
 * - Scheduled events
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Worker } from 'bullmq';
import { getRedisConnectionOptions, isRedisReady, createEventName, waitFor } from '../preload.ts';
import { BullMQEventProvider } from '../../src/events/bullmq-event-provider.ts';
import { ScheduledEventManager } from '../../src/events/scheduled-event-manager.ts';
import type { EventMessage } from '@orijs/events';
import type { PropagationMeta } from '@orijs/logging';

// Create unique event names for this test file to prevent parallel test interference
const eventName = createEventName('integration');

describe('BullMQEventProvider Integration', () => {
	let provider: BullMQEventProvider;

	beforeAll(async () => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		// NOTE: We don't flush Redis as it would interfere with parallel test files
		// Unique event names per test file provide sufficient isolation
		const connection = getRedisConnectionOptions();
		provider = new BullMQEventProvider({ connection });
	});

	afterEach(async () => {
		await provider.stop();
		// Allow ioredis async cleanup to complete before next test starts.
		// BullMQ/ioredis has async operations that continue after stop() returns.
		// 100ms is needed to avoid "Connection is closed" errors from pending async ops.
		await new Promise((r) => setTimeout(r, 100));
	});

	describe('fire-and-forget pattern', () => {
		it('should deliver event to subscriber', async () => {
			const received: unknown[] = [];

			await provider.subscribe(eventName('test.event'), async (msg: EventMessage) => {
				received.push(msg.payload);
			});

			await provider.start();

			const meta: PropagationMeta = { request_id: 'req-1' };
			provider.emit(eventName('test.event'), { value: 42 }, meta);

			await waitFor(() => received.length === 1);

			expect(received[0]).toEqual({ value: 42 });
		});

		it('should deliver events to multiple subscribers for different event types', async () => {
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			await provider.subscribe(eventName('event.type1'), async (msg: EventMessage) => {
				received1.push(msg.payload);
			});

			await provider.subscribe(eventName('event.type2'), async (msg: EventMessage) => {
				received2.push(msg.payload);
			});

			await provider.start();

			const meta: PropagationMeta = {};
			provider.emit(eventName('event.type1'), { id: 'a' }, meta);
			provider.emit(eventName('event.type2'), { id: 'b' }, meta);
			provider.emit(eventName('event.type1'), { id: 'c' }, meta);

			await waitFor(() => received1.length === 2 && received2.length === 1);

			expect(received1.map((p: any) => p.id)).toEqual(['a', 'c']);
			expect(received2.map((p: any) => p.id)).toEqual(['b']);
		});

		it('should not throw when no subscribers exist', async () => {
			await provider.start();

			const meta: PropagationMeta = {};
			const subscription = provider.emit(eventName('unknown.event'), {}, meta);

			// Should not throw, should return subscription
			expect(subscription).toBeDefined();
			expect(subscription.correlationId).toBeDefined();
		});

		it('should propagate metadata to handler', async () => {
			let receivedMeta: PropagationMeta | null = null;

			await provider.subscribe(eventName('metadata.event'), async (msg: EventMessage) => {
				receivedMeta = msg.meta;
			});

			await provider.start();

			const meta: PropagationMeta = {
				request_id: 'req-123',
				user_id: 'user-456',
				trace_id: 'trace-789',
				account_uuid: 'acct-abc'
			};
			provider.emit(eventName('metadata.event'), {}, meta);

			await waitFor(() => receivedMeta !== null);

			expect(receivedMeta!.request_id).toBe('req-123');
			expect(receivedMeta!.user_id).toBe('user-456');
			expect(receivedMeta!.trace_id).toBe('trace-789');
			expect(receivedMeta!.account_uuid).toBe('acct-abc');
		});
	});

	describe('request-response pattern', () => {
		it('should return handler result via subscribe callback', async () => {
			let result: unknown = null;

			await provider.subscribe<{ value: number }, { doubled: number }>(
				eventName('double.event'),
				async (msg: EventMessage<{ value: number }>) => {
					return { doubled: msg.payload.value * 2 };
				}
			);

			await provider.start();

			const meta: PropagationMeta = {};
			provider
				.emit<{ doubled: number }>(eventName('double.event'), { value: 21 }, meta)
				.subscribe((r: { doubled: number }) => {
					result = r;
				});

			await waitFor(() => result !== null);

			expect(result).toEqual({ doubled: 42 });
		});

		it('should handle handler errors via catch callback', async () => {
			// Use dedicated provider with no retries for immediate error propagation
			// This avoids race conditions with test cleanup during retry backoff
			const errorProvider = new BullMQEventProvider({
				connection: getRedisConnectionOptions(),
				defaultJobOptions: {
					attempts: 1, // No retries - fail immediately on first error
					removeOnComplete: true,
					removeOnFail: true
				}
			});

			try {
				let error: Error | null = null;

				await errorProvider.subscribe(eventName('error.event'), async () => {
					throw new Error('Handler failed');
				});

				await errorProvider.start();

				const meta: PropagationMeta = {};
				errorProvider
					.emit(eventName('error.event'), {}, meta)
					.subscribe(() => {})
					.catch((e: Error) => {
						error = e;
					});

				// With no retries, error should propagate quickly
				await waitFor(() => error !== null, 5000);

				expect(error!.message).toContain('Handler failed');
			} finally {
				await errorProvider.stop();
			}
		}, 10000);

		it('should resolve with undefined when handler returns nothing', async () => {
			let called = false;
			let result: unknown = 'not-set';

			await provider.subscribe(eventName('void.event'), async () => {
				// No return value
			});

			await provider.start();

			const meta: PropagationMeta = {};
			provider.emit(eventName('void.event'), {}, meta).subscribe((r: void) => {
				called = true;
				result = r;
			});

			await waitFor(() => called);

			expect(result).toBeUndefined();
		});

		it('should include correlationId in message', async () => {
			let receivedCorrelationId = '';

			await provider.subscribe(eventName('corr.event'), async (msg: EventMessage) => {
				receivedCorrelationId = msg.correlationId;
			});

			await provider.start();

			const meta: PropagationMeta = {};
			const subscription = provider.emit(eventName('corr.event'), {}, meta);

			await waitFor(() => receivedCorrelationId !== '');

			expect(receivedCorrelationId).toBe(subscription.correlationId);
		});
	});

	describe('delayed events', () => {
		it('should delay event delivery', async () => {
			// Use dedicated provider with unique event name to avoid interference
			// from parallel tests and leftover jobs from previous runs
			const delayProvider = new BullMQEventProvider({
				connection: getRedisConnectionOptions()
			});
			// Unique event name per test prevents leftover jobs from previous runs
			const uniqueEvent = `delayed.event.${crypto.randomUUID().slice(0, 8)}`;

			try {
				const timestamps: number[] = [];

				await delayProvider.subscribe(uniqueEvent, async () => {
					timestamps.push(Date.now());
				});

				await delayProvider.start();

				const startTime = Date.now();
				const meta: PropagationMeta = {};
				delayProvider.emit(uniqueEvent, {}, meta, { delay: 100 });

				// Should not be delivered yet (wait less than delay)
				await new Promise((r) => setTimeout(r, 50));
				expect(timestamps).toHaveLength(0);

				// Wait for delivery - allow extra time for CI parallel test load
				await waitFor(() => timestamps.length === 1, 3000);
				expect(timestamps[0]! - startTime).toBeGreaterThanOrEqual(75); // Allow tolerance
			} finally {
				await delayProvider.stop();
			}
		});

		it('should treat zero delay as immediate', async () => {
			// Use dedicated provider with unique event name
			const immediateProvider = new BullMQEventProvider({
				connection: getRedisConnectionOptions()
			});
			const uniqueEvent = `immediate.event.${crypto.randomUUID().slice(0, 8)}`;

			try {
				let delivered = false;

				await immediateProvider.subscribe(uniqueEvent, async () => {
					delivered = true;
				});

				await immediateProvider.start();

				const meta: PropagationMeta = {};
				immediateProvider.emit(uniqueEvent, {}, meta, { delay: 0 });

				await waitFor(() => delivered, 3000);
				expect(delivered).toBe(true);
			} finally {
				await immediateProvider.stop();
			}
		});

		it('should deliver delayed event after immediate event', async () => {
			// Use dedicated provider with unique event name
			const orderedProvider = new BullMQEventProvider({
				connection: getRedisConnectionOptions()
			});
			const uniqueEvent = `ordered.event.${crypto.randomUUID().slice(0, 8)}`;

			try {
				const received: number[] = [];

				await orderedProvider.subscribe<{ value: number }>(uniqueEvent, async (msg) => {
					received.push(msg.payload.value);
				});

				await orderedProvider.start();

				const meta: PropagationMeta = {};
				// Emit delayed first (200ms delay)
				orderedProvider.emit(uniqueEvent, { value: 1 }, meta, { delay: 200 });
				// Emit immediate second
				orderedProvider.emit(uniqueEvent, { value: 2 }, meta);

				// Wait for both - allow extra time for CI parallel test load
				await waitFor(() => received.length === 2, 5000);

				expect(received[0]).toBe(2); // Immediate first
				expect(received[1]).toBe(1); // Delayed second
			} finally {
				await orderedProvider.stop();
			}
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

		it('should stop gracefully without errors', async () => {
			await provider.subscribe(eventName('lifecycle.event'), async () => {});

			await provider.start();

			// Should not throw
			await provider.stop();

			expect(provider.isStarted()).toBe(false);
		});
	});

	describe('causation tracking', () => {
		it('should pass causationId to handler when provided', async () => {
			let receivedCausationId: string | undefined;

			await provider.subscribe(eventName('causation.event'), async (msg: EventMessage) => {
				receivedCausationId = msg.causationId;
			});

			await provider.start();

			const meta: PropagationMeta = {};
			provider.emit(eventName('causation.event'), {}, meta, { causationId: 'parent-event-123' });

			await waitFor(() => receivedCausationId !== undefined);

			expect(receivedCausationId).toBe('parent-event-123');
		});

		it('should not have causationId when not provided', async () => {
			let receivedCausationId: string | undefined = 'initial';
			let processed = false;

			await provider.subscribe(eventName('no-causation.event'), async (msg: EventMessage) => {
				receivedCausationId = msg.causationId;
				processed = true;
			});

			await provider.start();

			const meta: PropagationMeta = {};
			provider.emit(eventName('no-causation.event'), {}, meta);

			await waitFor(() => processed);

			expect(receivedCausationId).toBeUndefined();
		});
	});

	describe('request-response timeout', () => {
		it('should timeout pending request when handler is slower than timeout', async () => {
			const connection = getRedisConnectionOptions();
			const shortTimeoutProvider = new BullMQEventProvider({
				connection,
				defaultTimeout: 50 // 50ms timeout (shorter than 100ms handler)
			});

			let error: Error | null = null;
			let result: unknown = null;
			let handlerCompleted = false;

			// Handler takes 100ms - longer than 50ms timeout to trigger timeout
			await shortTimeoutProvider.subscribe(eventName('slow.timeout.event'), async () => {
				await new Promise((r) => setTimeout(r, 100));
				handlerCompleted = true;
				return { completed: true };
			});

			await shortTimeoutProvider.start();

			shortTimeoutProvider
				.emit(eventName('slow.timeout.event'), {}, {})
				.subscribe((r) => {
					result = r;
				})
				.catch((e: Error) => {
					error = e;
				});

			// Wait for timeout to fire
			await waitFor(() => error !== null, 500);

			expect(error!.message).toContain('timeout');
			expect(result).toBeNull();

			// Wait for handler to complete so stop() can cleanly close
			await waitFor(() => handlerCompleted, 1000);

			await shortTimeoutProvider.stop();

			expect(handlerCompleted).toBe(true);
		});

		it('should use per-emit timeout to override default', async () => {
			const connection = getRedisConnectionOptions();
			const longTimeoutProvider = new BullMQEventProvider({
				connection,
				defaultTimeout: 60000 // 60 second default
			});

			let error: Error | null = null;
			let handlerCompleted = false;

			// Handler takes 100ms - longer than per-emit 50ms timeout to trigger timeout
			await longTimeoutProvider.subscribe(eventName('slow.override.event'), async () => {
				await new Promise((r) => setTimeout(r, 100));
				handlerCompleted = true;
				return { completed: true };
			});

			await longTimeoutProvider.start();

			// Emit with short per-emit timeout (50ms) that overrides long default
			longTimeoutProvider
				.emit(eventName('slow.override.event'), {}, {}, { timeout: 50 })
				.catch((e: Error) => {
					error = e;
				});

			// Wait for per-emit timeout to fire
			await waitFor(() => error !== null, 500);

			expect(error!.message).toContain('timeout');

			// Wait for handler to complete
			await waitFor(() => handlerCompleted, 1000);

			await longTimeoutProvider.stop();

			expect(handlerCompleted).toBe(true);
		});
	});

	describe('scheduled events', () => {
		it('should schedule event via provider', async () => {
			await provider.start();

			// Schedule an event - should not throw
			await provider.scheduleEvent(eventName('health.ping'), {
				scheduleId: 'test-ping',
				every: 60000, // Every minute (won't fire in test)
				payload: { service: 'test' }
			});

			// Unschedule - should not throw
			await provider.unscheduleEvent(eventName('health.ping'), 'test-ping');
		});

		it('should handle unscheduling non-existent schedule gracefully', async () => {
			await provider.start();

			// Should not throw
			await provider.unscheduleEvent(eventName('health.ping'), 'non-existent');
		});

		it('should deliver scheduled events to subscribe() handlers', async () => {
			const received: unknown[] = [];
			const uniqueEvent = `scheduled.e2e.${crypto.randomUUID().slice(0, 8)}`;

			// Register subscriber first (creates worker on event.* queue)
			await provider.subscribe(uniqueEvent, async (msg: EventMessage) => {
				received.push(msg.payload);
			});

			await provider.start();

			// Schedule event with short interval
			await provider.scheduleEvent(uniqueEvent, {
				scheduleId: 'fast-e2e',
				every: 100,
				payload: { scheduled: true }
			});

			// Scheduled jobs should reach the subscribe() handler
			await waitFor(() => received.length >= 2, 3000);

			expect(received[0]).toEqual({ scheduled: true });

			await provider.unscheduleEvent(uniqueEvent, 'fast-e2e');
		});
	});
});

/**
 * Direct ScheduledEventManager Integration Tests
 *
 * Tests the scheduled event system with real Redis and real BullMQ workers.
 * Verifies that repeatable jobs actually fire at the scheduled interval.
 */
describe('ScheduledEventManager Integration', () => {
	let manager: ScheduledEventManager;
	let worker: Worker | null = null;

	beforeAll(() => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(async () => {
		// NOTE: We don't flush Redis as it would interfere with parallel test files
		// Unique event names per test file provide sufficient isolation
		const connection = getRedisConnectionOptions();
		manager = new ScheduledEventManager({ connection });
	});

	afterEach(async () => {
		if (worker) {
			// Add error handlers before close to handle expected shutdown errors
			const ignoreError = () => {};
			// Use type assertions to access internal BullMQ properties for cleanup
			(worker as any).connection?._client?.on('error', ignoreError);
			(worker as any).blockingConnection?._client?.on('error', ignoreError);
			await worker.close();
			worker = null;
		}
		await manager.stop();
		// Allow ioredis async cleanup to complete
		await new Promise((r) => setTimeout(r, 25));
	});

	it('should fire scheduled event at interval', async () => {
		const connection = getRedisConnectionOptions();
		const received: any[] = [];
		// Use unique queue name per test to avoid interference from leftover jobs
		const queueName = `interval.test.${crypto.randomUUID().slice(0, 8)}`;

		// Create worker on scheduled queue to receive jobs
		worker = new Worker(
			`scheduled.${queueName}`,
			async (job) => {
				received.push(job.data);
			},
			{ connection }
		);

		// Wait for worker to be ready before scheduling - prevents race under parallel load
		await worker.waitUntilReady();

		// Schedule event with short interval for testing
		await manager.schedule(queueName, {
			scheduleId: 'fast-interval',
			every: 100, // Every 100ms
			payload: { counter: 1 }
		});

		// Wait for at least 2 scheduled fires
		await waitFor(() => received.length >= 2, 1000);

		expect(received[0].payload).toEqual({ counter: 1 });

		// Clean up - unschedule
		await manager.unschedule(queueName, 'fast-interval');
	});

	it('should track schedules correctly', async () => {
		// Use unique queue name per test
		const queueName = `tracking.test.${crypto.randomUUID().slice(0, 8)}`;

		// Schedule multiple events
		await manager.schedule(queueName, {
			scheduleId: 'schedule-a',
			every: 10000,
			payload: { id: 'a' }
		});

		await manager.schedule(queueName, {
			scheduleId: 'schedule-b',
			every: 20000,
			payload: { id: 'b' }
		});

		// Get schedules
		const schedules = manager.getSchedules(queueName);

		expect(schedules.length).toBe(2);
		expect(schedules.find((s) => s.scheduleId === 'schedule-a')).toBeDefined();
		expect(schedules.find((s) => s.scheduleId === 'schedule-b')).toBeDefined();

		// Unschedule one
		await manager.unschedule(queueName, 'schedule-a');

		const remaining = manager.getSchedules(queueName);
		expect(remaining.length).toBe(1);
		expect(remaining[0]?.scheduleId).toBe('schedule-b');
	});

	it('should support cron patterns', async () => {
		const connection = getRedisConnectionOptions();
		const received: any[] = [];
		// Use unique queue name per test to avoid interference from leftover jobs
		const queueName = `cron.test.${crypto.randomUUID().slice(0, 8)}`;

		// Create worker on scheduled queue
		worker = new Worker(
			`scheduled.${queueName}`,
			async (job) => {
				received.push(job.data);
			},
			{ connection }
		);

		// Wait for worker to be ready before scheduling - prevents race under parallel load
		await worker.waitUntilReady();

		// Schedule event with cron pattern (every second for testing)
		await manager.schedule(queueName, {
			scheduleId: 'every-second',
			cron: '* * * * * *', // Every second (6-field cron with seconds)
			payload: { type: 'cron' }
		});

		// Wait for at least 2 cron triggers
		await waitFor(() => received.length >= 2, 3000);

		expect(received[0].payload).toEqual({ type: 'cron' });

		// Clean up
		await manager.unschedule(queueName, 'every-second');
	});
});
