/**
 * E2E Scenario: BullMQ Event Provider Realistic Workflows
 *
 * These tests verify BullMQEventProvider works correctly for real-world
 * event-driven scenarios, testing the full event lifecycle through Redis.
 *
 * Given: BullMQEventProvider connected to real Redis
 * When: Events are emitted following realistic application patterns
 * Then: Events flow correctly through queues with context preservation
 *
 * EntrypointType: event
 * EntrypointId: Various event types (monitor.check, monitor.failed, etc.)
 * Outputs: Handler results via subscription callbacks, cascading events
 * State: Jobs created in Redis, processed by workers, completions tracked
 * Messaging: emit -> BullMQ queue -> worker -> QueueEvents -> callback
 * Invariants: correlationId propagation, context preservation, exactly-once delivery
 * MockedExternals: None (uses real Redis via testcontainers)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady, createEventName, waitFor } from '../preload.ts';
import { BullMQEventProvider } from '../../src/events/bullmq-event-provider.ts';
import type { EventMessage } from '@orijs/events';
import type { PropagationMeta } from '@orijs/logging';

// Create unique event names for this test file to prevent parallel test interference
const eventName = createEventName('scenario');

/**
 * Test payload types for realistic scenarios
 */
interface MonitorCheckPayload {
	readonly monitorId: string;
	readonly url: string;
}

interface MonitorCheckResult {
	readonly monitorId: string;
	readonly healthy: boolean;
	readonly responseTime: number;
}

interface MonitorFailedPayload {
	readonly monitorId: string;
	readonly errorMessage: string;
}

interface AlertTriggeredPayload {
	readonly alertId: string;
	readonly monitorId: string;
	readonly severity: 'low' | 'medium' | 'high';
}

interface NotificationSentPayload {
	readonly alertId: string;
	readonly channel: string;
}

describe('BullMQ Event Provider E2E Scenarios', () => {
	let provider: BullMQEventProvider;

	beforeAll(() => {
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
	});

	/**
	 * Scenario 1: Monitor Check with Request-Response Pattern
	 *
	 * Given: A monitor.check handler that simulates health checking
	 * When: Service emits monitor.check event with request-response pattern
	 * Then: Event routes through queue, worker processes, result returns to caller
	 *
	 * Cardinality: emit.call = 1, handler.call = 1, callback.call = 1
	 */
	describe('Scenario: Monitor Check Request-Response', () => {
		it('should process monitor check and return health status', async () => {
			// ARRANGE: Register handler that simulates monitor checking
			const handlerCalls: MonitorCheckPayload[] = [];
			let result: MonitorCheckResult | null = null;

			await provider.subscribe<MonitorCheckPayload, MonitorCheckResult>(
				eventName('monitor.check'),
				async (msg: EventMessage<MonitorCheckPayload>) => {
					handlerCalls.push(msg.payload);

					// Simulate health check logic
					const isHealthy = msg.payload.url.includes('healthy');
					const responseTime = Math.floor(Math.random() * 100) + 50;

					return {
						monitorId: msg.payload.monitorId,
						healthy: isHealthy,
						responseTime
					};
				}
			);

			await provider.start();

			// ACT: Emit event with request-response
			const meta: PropagationMeta = {
				request_id: 'req-check-123',
				trace_id: 'trace-abc'
			};

			provider
				.emit<MonitorCheckResult>(
					eventName('monitor.check'),
					{ monitorId: 'mon-123', url: 'https://healthy.example.com' },
					meta
				)
				.subscribe((r: MonitorCheckResult) => {
					result = r;
				});

			// Wait for async processing
			await waitFor(() => result !== null, 2000);

			// ASSERT: Verify handler was called exactly once
			expect(handlerCalls).toHaveLength(1);
			expect(handlerCalls[0]?.monitorId).toBe('mon-123');

			// ASSERT: Verify result returned via callback
			expect(result).not.toBeNull();
			expect(result!.monitorId).toBe('mon-123');
			expect(result!.healthy).toBe(true);
			expect(result!.responseTime).toBeGreaterThan(0);
		});

		it('should preserve context (request_id, trace_id) through processing', async () => {
			let receivedMeta: PropagationMeta | null = null;

			await provider.subscribe<MonitorCheckPayload, MonitorCheckResult>(
				eventName('monitor.check.traced'),
				async (msg: EventMessage<MonitorCheckPayload>) => {
					receivedMeta = msg.meta;
					return { monitorId: msg.payload.monitorId, healthy: true, responseTime: 50 };
				}
			);

			await provider.start();

			const meta: PropagationMeta = {
				request_id: 'req-trace-456',
				trace_id: 'trace-xyz-789',
				user_id: 'user-admin',
				account_uuid: 'acct-abc-123'
			};

			provider
				.emit<MonitorCheckResult>(
					eventName('monitor.check.traced'),
					{ monitorId: 'mon-456', url: 'https://example.com' },
					meta
				)
				.subscribe(() => {});

			await waitFor(() => receivedMeta !== null, 2000);

			// ASSERT: All context fields preserved through queue
			expect(receivedMeta).not.toBeNull();
			expect(receivedMeta!.request_id).toBe('req-trace-456');
			expect(receivedMeta!.trace_id).toBe('trace-xyz-789');
			expect(receivedMeta!.user_id).toBe('user-admin');
			expect(receivedMeta!.account_uuid).toBe('acct-abc-123');
		});
	});

	/**
	 * Scenario 2: Cascading Events (Event Triggers Another Event)
	 *
	 * Given: Handlers for monitor.failed -> alert.triggered -> notification.sent
	 * When: monitor.failed event is emitted
	 * Then: Each handler fires in sequence, context preserved through chain
	 *
	 * Cardinality: monitor.failed = 1, alert.triggered = 1, notification.sent = 1
	 */
	describe('Scenario: Cascading Events', () => {
		it('should handle event chain: monitor.failed -> alert.triggered -> notification.sent', async () => {
			const eventLog: string[] = [];

			// Handler 1: Monitor failed -> triggers alert
			await provider.subscribe<MonitorFailedPayload>(eventName('cascade.monitor.failed'), async (msg) => {
				eventLog.push(`monitor.failed:${msg.payload.monitorId}`);

				// Emit cascading event with same context
				provider.emit(
					eventName('cascade.alert.triggered'),
					{
						alertId: `alert-${msg.payload.monitorId}`,
						monitorId: msg.payload.monitorId,
						severity: 'high'
					} as AlertTriggeredPayload,
					msg.meta,
					{ causationId: msg.correlationId }
				);
			});

			// Handler 2: Alert triggered -> sends notification
			await provider.subscribe<AlertTriggeredPayload>(eventName('cascade.alert.triggered'), async (msg) => {
				eventLog.push(`alert.triggered:${msg.payload.alertId}`);

				// Emit final notification event
				provider.emit(
					eventName('cascade.notification.sent'),
					{
						alertId: msg.payload.alertId,
						channel: 'slack'
					} as NotificationSentPayload,
					msg.meta,
					{ causationId: msg.correlationId }
				);
			});

			// Handler 3: Notification sent (terminal)
			await provider.subscribe<NotificationSentPayload>(
				eventName('cascade.notification.sent'),
				async (msg) => {
					eventLog.push(`notification.sent:${msg.payload.alertId}:${msg.payload.channel}`);
				}
			);

			await provider.start();

			// ACT: Trigger the cascade
			const meta: PropagationMeta = { request_id: 'req-cascade-001' };
			provider.emit(
				eventName('cascade.monitor.failed'),
				{ monitorId: 'mon-cascade', errorMessage: 'Connection timeout' } as MonitorFailedPayload,
				meta
			);

			// Wait for full cascade to complete
			await waitFor(() => eventLog.length === 3, 3000);

			// ASSERT: All three events processed in order
			expect(eventLog).toHaveLength(3);
			expect(eventLog[0]).toBe('monitor.failed:mon-cascade');
			expect(eventLog[1]).toBe('alert.triggered:alert-mon-cascade');
			expect(eventLog[2]).toBe('notification.sent:alert-mon-cascade:slack');
		});

		it('should preserve causation chain through cascading events', async () => {
			const causationChain: Array<{ event: string; causationId?: string; correlationId: string }> = [];

			await provider.subscribe<MonitorFailedPayload>(eventName('chain.monitor.failed'), async (msg) => {
				causationChain.push({
					event: 'monitor.failed',
					causationId: msg.causationId,
					correlationId: msg.correlationId
				});

				provider.emit(
					eventName('chain.alert.triggered'),
					{ alertId: 'a1', monitorId: 'mon1', severity: 'high' },
					msg.meta,
					{ causationId: msg.correlationId }
				);
			});

			await provider.subscribe<AlertTriggeredPayload>(eventName('chain.alert.triggered'), async (msg) => {
				causationChain.push({
					event: 'alert.triggered',
					causationId: msg.causationId,
					correlationId: msg.correlationId
				});
			});

			await provider.start();

			provider.emit(eventName('chain.monitor.failed'), { monitorId: 'mon1', errorMessage: 'fail' }, {});

			await waitFor(() => causationChain.length === 2, 3000);

			// ASSERT: First event has no causation, second has first's correlation as causation
			expect(causationChain).toHaveLength(2);
			expect(causationChain[0]?.causationId).toBeUndefined();
			expect(causationChain[1]?.causationId).toBe(causationChain[0]?.correlationId);
		});
	});

	/**
	 * Scenario 3: Delayed Event Processing with Context Propagation
	 *
	 * Given: A handler for scheduled health checks
	 * When: Event emitted with delay
	 * Then: Event processes after delay with all context preserved
	 */
	describe('Scenario: Delayed Event with Context', () => {
		it('should process delayed event with full context preservation', async () => {
			let processedAt: number = 0;
			let receivedPayload: MonitorCheckPayload | null = null;
			let receivedMeta: PropagationMeta | null = null;

			await provider.subscribe<MonitorCheckPayload>(eventName('delayed.monitor.check'), async (msg) => {
				processedAt = Date.now();
				receivedPayload = msg.payload;
				receivedMeta = msg.meta;
			});

			await provider.start();

			const emittedAt = Date.now();
			const meta: PropagationMeta = {
				request_id: 'req-delayed-123',
				trace_id: 'trace-delayed-456'
			};

			provider.emit(
				eventName('delayed.monitor.check'),
				{ monitorId: 'mon-delayed', url: 'https://example.com' } as MonitorCheckPayload,
				meta,
				{ delay: 100 }
			);

			// Wait for delayed processing
			await waitFor(() => processedAt > 0, 1000);

			// ASSERT: Event processed after delay
			expect(processedAt).toBeGreaterThan(0);
			expect(processedAt - emittedAt).toBeGreaterThanOrEqual(75); // Allow tolerance

			// ASSERT: Payload preserved
			expect(receivedPayload).not.toBeNull();
			expect(receivedPayload!.monitorId).toBe('mon-delayed');

			// ASSERT: Context preserved through delay
			expect(receivedMeta).not.toBeNull();
			expect(receivedMeta!.request_id).toBe('req-delayed-123');
			expect(receivedMeta!.trace_id).toBe('trace-delayed-456');
		});
	});

	/**
	 * Scenario 4: Error Handling in Event Chain
	 *
	 * Given: A handler that throws an error
	 * When: Event is emitted with request-response pattern
	 * Then: Error propagates to catch callback with error details
	 */
	describe('Scenario: Error Handling', () => {
		it('should propagate handler error to catch callback', async () => {
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
				await errorProvider.subscribe(eventName('error.scenario'), async () => {
					throw new Error('Simulated database connection failure');
				});

				await errorProvider.start();

				let result: unknown = null;
				let error: Error | null = null;

				errorProvider
					.emit(eventName('error.scenario'), { action: 'test' }, { request_id: 'req-error-001' })
					.subscribe((r: unknown) => {
						result = r;
					})
					.catch((e: Error) => {
						error = e;
					});

				// With no retries, error should propagate quickly
				await waitFor(() => error !== null, 5000);

				// ASSERT: Success callback not called
				expect(result).toBeNull();

				// ASSERT: Error callback called with error details
				expect(error).not.toBeNull();
				expect(error!.message).toContain('database connection failure');
			} finally {
				await errorProvider.stop();
			}
		}, 10000);

		it('should not affect other handlers when one fails', async () => {
			const successfulEvents: string[] = [];

			// Handler that fails
			await provider.subscribe(eventName('isolation.failing'), async () => {
				throw new Error('Handler crashed');
			});

			// Handler that succeeds
			await provider.subscribe(eventName('isolation.working'), async (msg: EventMessage) => {
				successfulEvents.push(msg.correlationId);
			});

			await provider.start();

			// Emit failing event
			provider.emit(eventName('isolation.failing'), {}, {});

			// Emit working event
			provider.emit(eventName('isolation.working'), {}, {});

			await waitFor(() => successfulEvents.length === 1, 2000);

			// ASSERT: Working handler processed despite other failing
			expect(successfulEvents).toHaveLength(1);
		});
	});

	/**
	 * Scenario 5: High-Volume Concurrent Events with Multiple App Instances
	 *
	 * Simulates real-world deployment with multiple application instances
	 * (like multiple Kubernetes pods) all consuming from the same Redis queues.
	 *
	 * This tests:
	 * - No message loss under load with competing consumers
	 * - No duplicate processing (exactly-once semantics)
	 * - Correct correlation ID mapping when responses arrive out of order
	 * - Context preservation across distributed workers
	 * - Request-response pattern works across multiple instances
	 */
	describe('Scenario: Multi-Instance Concurrent Processing', () => {
		it('should process 20 events across 3 app instances without message loss', async () => {
			const connection = getRedisConnectionOptions();
			const processedEvents: Array<{ id: number; instanceId: number; processedAt: number }> = [];
			const eventCount = 20;
			const instanceCount = 3;

			// Create multiple "app instances" - each with their own provider
			const instances: BullMQEventProvider[] = [];
			for (let i = 0; i < instanceCount; i++) {
				const instance = new BullMQEventProvider({ connection });
				const instanceId = i;

				// Each instance subscribes to same event - BullMQ distributes jobs
				await instance.subscribe<{ id: number; delay: number }>(
					eventName('multiinstance.test'),
					async (msg) => {
						await new Promise((r) => setTimeout(r, msg.payload.delay));
						processedEvents.push({
							id: msg.payload.id,
							instanceId,
							processedAt: Date.now()
						});
					}
				);

				instances.push(instance);
			}

			// Start all instances
			await Promise.all(instances.map((inst) => inst.start()));

			// Emit all events from the first instance (simulates API server)
			const emitter = instances[0];
			expect(emitter).toBeDefined();
			for (let i = 0; i < eventCount; i++) {
				// Variable delay: 5-30ms
				const delay = Math.floor(Math.random() * 25) + 5;
				emitter!.emit(eventName('multiinstance.test'), { id: i, delay }, { request_id: `req-${i}` });
			}

			// Wait for processing
			await waitFor(() => processedEvents.length === eventCount, 3000);

			// Stop all instances
			await Promise.all(instances.map((inst) => inst.stop()));

			// ASSERT: All events processed
			expect(processedEvents.length).toBe(eventCount);

			// ASSERT: No duplicates (exactly-once)
			const processedIds = new Set(processedEvents.map((e) => e.id));
			expect(processedIds.size).toBe(eventCount);

			// ASSERT: Work was distributed across instances
			const instanceCounts = new Map<number, number>();
			for (const event of processedEvents) {
				instanceCounts.set(event.instanceId, (instanceCounts.get(event.instanceId) ?? 0) + 1);
			}
			expect(instanceCounts.size).toBeGreaterThan(1);

			// ASSERT: Events completed out of order due to parallel processing
			let outOfOrderCount = 0;
			for (let i = 1; i < processedEvents.length; i++) {
				const current = processedEvents[i];
				const previous = processedEvents[i - 1];
				if (current && previous && current.id < previous.id) {
					outOfOrderCount++;
				}
			}
			expect(outOfOrderCount).toBeGreaterThan(1);
		}, 10000);

		it('should handle 15 request-response events with out-of-order completion across instances', async () => {
			const connection = getRedisConnectionOptions();
			const eventCount = 15;
			const instanceCount = 3;
			const results: Array<{ id: number; result: number; instanceId: number }> = [];
			const errors: Error[] = [];

			// Create worker instances (not the emitter)
			const workers: BullMQEventProvider[] = [];
			for (let i = 0; i < instanceCount; i++) {
				const worker = new BullMQEventProvider({ connection });
				const instanceId = i;

				await worker.subscribe<
					{ id: number; delay: number },
					{ id: number; doubled: number; instanceId: number }
				>(eventName('multiinstance.rr'), async (msg) => {
					await new Promise((r) => setTimeout(r, msg.payload.delay));
					return {
						id: msg.payload.id,
						doubled: msg.payload.id * 2,
						instanceId
					};
				});

				workers.push(worker);
			}

			// Start all workers
			await Promise.all(workers.map((w) => w.start()));

			// Emit from main provider (set up in beforeEach)
			// Earlier events get longer delays so they complete AFTER later events
			for (let i = 0; i < eventCount; i++) {
				const delay = Math.floor(((eventCount - i) / eventCount) * 60) + 15;

				provider
					.emit<{ id: number; doubled: number; instanceId: number }>(
						eventName('multiinstance.rr'),
						{ id: i, delay },
						{ request_id: `req-rr-${i}` }
					)
					.subscribe((r) => {
						results.push({
							id: r.id,
							result: r.doubled,
							instanceId: r.instanceId
						});
					})
					.catch((e: Error) => {
						errors.push(e);
					});
			}

			// Wait for completion
			await waitFor(() => results.length === eventCount, 3000);

			// Stop workers
			await Promise.all(workers.map((w) => w.stop()));

			// ASSERT: No errors
			expect(errors).toHaveLength(0);

			// ASSERT: All results received
			expect(results.length).toBe(eventCount);

			// ASSERT: Each result correctly maps to its event
			for (const r of results) {
				expect(r.result).toBe(r.id * 2);
			}

			// ASSERT: Work distributed across instances
			const instancesUsed = new Set(results.map((r) => r.instanceId));
			expect(instancesUsed.size).toBeGreaterThan(1);

			// ASSERT: Results arrived out of order
			const resultOrder = results.map((r) => r.id);
			let inversionsFound = 0;
			for (let i = 1; i < resultOrder.length; i++) {
				const current = resultOrder[i];
				const previous = resultOrder[i - 1];
				if (current !== undefined && previous !== undefined && current < previous) {
					inversionsFound++;
				}
			}
			expect(inversionsFound).toBeGreaterThan(eventCount * 0.1);
		}, 8000);

		it('should handle 3 event types across 3 instances without cross-contamination', async () => {
			const connection = getRedisConnectionOptions();
			const eventsPerType = 10;
			const instanceCount = 3;

			const typeAResults: Array<{ id: number; instanceId: number }> = [];
			const typeBResults: Array<{ id: number; instanceId: number }> = [];
			const typeCResults: Array<{ id: number; instanceId: number }> = [];

			// Create worker instances
			const workers: BullMQEventProvider[] = [];
			for (let i = 0; i < instanceCount; i++) {
				const worker = new BullMQEventProvider({ connection });
				const instanceId = i;

				await worker.subscribe<{ id: number }, { type: string; id: number; instanceId: number }>(
					eventName('mixed.multi.typeA'),
					async (msg) => {
						await new Promise((r) => setTimeout(r, Math.random() * 15 + 5));
						return { type: 'A', id: msg.payload.id, instanceId };
					}
				);

				await worker.subscribe<{ id: number }, { type: string; id: number; instanceId: number }>(
					eventName('mixed.multi.typeB'),
					async (msg) => {
						await new Promise((r) => setTimeout(r, Math.random() * 20 + 5));
						return { type: 'B', id: msg.payload.id, instanceId };
					}
				);

				await worker.subscribe<{ id: number }, { type: string; id: number; instanceId: number }>(
					eventName('mixed.multi.typeC'),
					async (msg) => {
						await new Promise((r) => setTimeout(r, Math.random() * 10 + 5));
						return { type: 'C', id: msg.payload.id, instanceId };
					}
				);

				workers.push(worker);
			}

			await Promise.all(workers.map((w) => w.start()));

			// Emit interleaved events
			for (let i = 0; i < eventsPerType; i++) {
				provider
					.emit<{
						type: string;
						id: number;
						instanceId: number;
					}>(eventName('mixed.multi.typeA'), { id: i }, {})
					.subscribe((r) => {
						expect(r.type).toBe('A');
						typeAResults.push({ id: r.id, instanceId: r.instanceId });
					});

				provider
					.emit<{
						type: string;
						id: number;
						instanceId: number;
					}>(eventName('mixed.multi.typeB'), { id: i + 1000 }, {})
					.subscribe((r) => {
						expect(r.type).toBe('B');
						typeBResults.push({ id: r.id, instanceId: r.instanceId });
					});

				provider
					.emit<{
						type: string;
						id: number;
						instanceId: number;
					}>(eventName('mixed.multi.typeC'), { id: i + 2000 }, {})
					.subscribe((r) => {
						expect(r.type).toBe('C');
						typeCResults.push({ id: r.id, instanceId: r.instanceId });
					});
			}

			await waitFor(
				() =>
					typeAResults.length === eventsPerType &&
					typeBResults.length === eventsPerType &&
					typeCResults.length === eventsPerType,
				3000
			);

			await Promise.all(workers.map((w) => w.stop()));

			// ASSERT: All events processed
			expect(typeAResults.length).toBe(eventsPerType);
			expect(typeBResults.length).toBe(eventsPerType);
			expect(typeCResults.length).toBe(eventsPerType);

			// ASSERT: Correct IDs (no cross-contamination)
			expect(typeAResults.every((r) => r.id >= 0 && r.id < eventsPerType)).toBe(true);
			expect(typeBResults.every((r) => r.id >= 1000 && r.id < 1000 + eventsPerType)).toBe(true);
			expect(typeCResults.every((r) => r.id >= 2000 && r.id < 2000 + eventsPerType)).toBe(true);

			// ASSERT: No duplicates
			expect(new Set(typeAResults.map((r) => r.id)).size).toBe(eventsPerType);
			expect(new Set(typeBResults.map((r) => r.id)).size).toBe(eventsPerType);
			expect(new Set(typeCResults.map((r) => r.id)).size).toBe(eventsPerType);

			// ASSERT: Work distributed across instances for each type
			expect(new Set(typeAResults.map((r) => r.instanceId)).size).toBeGreaterThan(1);
			expect(new Set(typeBResults.map((r) => r.instanceId)).size).toBeGreaterThan(1);
			expect(new Set(typeCResults.map((r) => r.instanceId)).size).toBeGreaterThan(1);
		}, 8000);

		it('should preserve context across all instances', async () => {
			const connection = getRedisConnectionOptions();
			const eventCount = 15;
			const instanceCount = 3;
			const contextResults: Array<{ id: number; request_id: string; trace_id: string; instanceId: number }> =
				[];

			const workers: BullMQEventProvider[] = [];
			for (let i = 0; i < instanceCount; i++) {
				const worker = new BullMQEventProvider({ connection });
				const instanceId = i;

				await worker.subscribe<{ id: number }>(eventName('context.multi'), async (msg) => {
					await new Promise((r) => setTimeout(r, Math.random() * 20 + 5));
					contextResults.push({
						id: msg.payload.id,
						request_id: (msg.meta.correlationId as string) ?? 'missing',
						trace_id: (msg.meta.traceId as string) ?? 'missing',
						instanceId
					});
				});

				workers.push(worker);
			}

			await Promise.all(workers.map((w) => w.start()));

			for (let i = 0; i < eventCount; i++) {
				provider.emit(
					eventName('context.multi'),
					{ id: i },
					{
						correlationId: `req-ctx-${i}`,
						traceId: `trace-ctx-${i}`
					}
				);
			}

			await waitFor(() => contextResults.length === eventCount, 3000);
			await Promise.all(workers.map((w) => w.stop()));

			// ASSERT: All processed
			expect(contextResults.length).toBe(eventCount);

			// ASSERT: Each event has correct context (not mixed up across instances)
			for (const result of contextResults) {
				expect(result.request_id).toBe(`req-ctx-${result.id}`);
				expect(result.trace_id).toBe(`trace-ctx-${result.id}`);
			}

			// ASSERT: Work distributed
			expect(new Set(contextResults.map((r) => r.instanceId)).size).toBeGreaterThan(1);
		}, 8000);
	});
});
