import { describe, expect, test } from 'bun:test';
import {
	requestContext,
	runWithContext,
	generateCorrelationId,
	capturePropagationMeta,
	createTraceContext,
	setMeta,
	Logger
} from '../src/index.ts';

describe('requestContext', () => {
	test('should return fallback when no context is set', () => {
		const ctx = requestContext();
		expect(ctx.log).toBeInstanceOf(Logger);
		expect(ctx.correlationId).toBe('');
	});

	test('should return context when set via runWithContext', async () => {
		const testLogger = new Logger('Test');
		const testRequestId = 'test-123';

		await runWithContext({ log: testLogger, correlationId: testRequestId }, async () => {
			const ctx = requestContext();
			expect(ctx.correlationId).toBe('test-123');
			expect(ctx.log).toBe(testLogger);
		});
	});

	test('should propagate context through async calls', async () => {
		const testLogger = new Logger('Test');
		const testRequestId = 'async-456';

		async function nestedCall() {
			const ctx = requestContext();
			return ctx.correlationId;
		}

		await runWithContext({ log: testLogger, correlationId: testRequestId }, async () => {
			const correlationId = await nestedCall();
			expect(correlationId).toBe('async-456');
		});
	});

	test('should isolate context between concurrent requests', async () => {
		const log1 = new Logger('Test1');
		const log2 = new Logger('Test2');

		const results: string[] = [];

		await Promise.all([
			runWithContext({ log: log1, correlationId: 'req-1' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(requestContext().correlationId);
			}),
			runWithContext({ log: log2, correlationId: 'req-2' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(requestContext().correlationId);
			})
		]);

		expect(results).toContain('req-1');
		expect(results).toContain('req-2');
	});
});

describe('generateCorrelationId', () => {
	test('should generate unique IDs', () => {
		const id1 = generateCorrelationId();
		const id2 = generateCorrelationId();
		expect(id1).not.toBe(id2);
	});

	test('should generate valid UUID format', () => {
		const id = generateCorrelationId();
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		expect(id).toMatch(uuidRegex);
	});
});

describe('capturePropagationMeta', () => {
	test('should return undefined when no context is set', () => {
		const meta = capturePropagationMeta();
		expect(meta).toBeUndefined();
	});

	test('should capture request_id from requestContext', async () => {
		const testLogger = new Logger('Test');
		const testRequestId = 'req-capture-123';

		await runWithContext({ log: testLogger, correlationId: testRequestId }, async () => {
			const meta = capturePropagationMeta();
			expect(meta).toBeDefined();
			expect(meta!.correlationId).toBe(testRequestId);
		});
	});

	test('should create child trace span when trace context exists', async () => {
		const testLogger = new Logger('Test');
		const testRequestId = 'req-trace-456';
		const trace = createTraceContext('trace-id-789');

		await runWithContext({ log: testLogger, correlationId: testRequestId, trace }, async () => {
			const meta = capturePropagationMeta();

			expect(meta).toBeDefined();
			expect(meta!.correlationId).toBe(testRequestId);
			expect(meta!.traceId).toBe('trace-id-789');
			expect(meta!.spanId).toBeDefined();
			expect(meta!.parentSpanId).toBe(trace.spanId);
		});
	});

	test('should create unique child spans for each capture', async () => {
		const testLogger = new Logger('Test');
		const trace = createTraceContext();

		await runWithContext({ log: testLogger, correlationId: 'req-1', trace }, async () => {
			const meta1 = capturePropagationMeta();
			const meta2 = capturePropagationMeta();

			expect(meta1!.spanId).not.toBe(meta2!.spanId);
			expect(meta1!.traceId).toBe(meta2!.traceId);
		});
	});

	test('should capture application-injected metadata from setMeta', async () => {
		const testLogger = new Logger('Test');
		const trace = createTraceContext('trace-123');

		await runWithContext({ log: testLogger, correlationId: 'req-meta-test', trace }, async () => {
			// Inject application-specific metadata (like AuthGuard would do)
			setMeta({ userId: 'user-abc', accountUuid: 'acc-xyz' });

			const meta = capturePropagationMeta();

			expect(meta).toBeDefined();
			expect(meta!.correlationId).toBe('req-meta-test');
			expect(meta!.traceId).toBe('trace-123');
			expect(meta!.userId).toBe('user-abc');
			expect(meta!.accountUuid).toBe('acc-xyz');
		});
	});
});

/**
 * Cross-Service Propagation Tests
 *
 * These tests verify that logging context (including application-injected metadata)
 * properly propagates across service boundaries. This simulates:
 *
 * 1. App Instance 1: HTTP request → AuthGuard sets metadata → workflow step 1 → publish to queue
 * 2. Queue/Event transport: Metadata serialized as JSON
 * 3. App Instance 2: Receives from queue → restores context → workflow step 2 → logs have all context
 *
 * CRITICAL: App Instance 2 must be completely isolated - it only receives the serialized
 * metadata, NOT any shared AsyncLocalStorage state.
 */
describe('cross-service propagation', () => {
	test('should propagate all context across service boundaries via serialized metadata', async () => {
		// ========================================
		// APP INSTANCE 1: Origin service
		// ========================================
		let serializedMetadata: string = '';

		// Simulate App Instance 1's request handling
		await runWithContext(
			{
				log: new Logger('AppInstance1'),
				correlationId: 'req-origin-123',
				trace: createTraceContext('trace-distributed-abc')
			},
			async () => {
				// AuthGuard injects application-specific metadata
				setMeta({
					userId: 'user-12345',
					accountUuid: 'account-67890',
					projectUuid: 'project-abcde'
				});

				// Service captures context before publishing to queue/event
				const propagationMeta = capturePropagationMeta();

				// Serialize for transport (this is what goes over the wire)
				serializedMetadata = JSON.stringify(propagationMeta);
			}
		);

		// ========================================
		// TRANSPORT: Metadata travels over the wire
		// ========================================
		// At this point, App Instance 1's AsyncLocalStorage is gone.
		// The only context that survives is what's in serializedMetadata.

		// Verify we're outside any context
		const outsideContext = capturePropagationMeta();
		expect(outsideContext).toBeUndefined();

		// ========================================
		// APP INSTANCE 2: Receiving service (completely isolated)
		// ========================================
		// Deserialize metadata (as if received from queue/event)
		const receivedMeta = JSON.parse(serializedMetadata);

		// App Instance 2 creates its own context from received metadata
		await runWithContext(
			{
				log: Logger.fromMeta('AppInstance2-Workflow', receivedMeta),
				correlationId: receivedMeta.correlationId,
				trace: {
					traceId: receivedMeta.traceId,
					spanId: receivedMeta.spanId,
					parentSpanId: receivedMeta.parentSpanId
				},
				meta: {
					userId: receivedMeta.userId,
					accountUuid: receivedMeta.accountUuid,
					projectUuid: receivedMeta.projectUuid
				}
			},
			async () => {
				const ctx = requestContext();

				// Verify ALL context was propagated
				expect(ctx.correlationId).toBe('req-origin-123');

				// Verify trace context
				expect(ctx.trace?.traceId).toBe('trace-distributed-abc');
				expect(ctx.trace?.spanId).toBeDefined();
				expect(ctx.trace?.parentSpanId).toBeDefined();

				// Verify application-injected metadata
				expect(ctx.meta?.userId).toBe('user-12345');
				expect(ctx.meta?.accountUuid).toBe('account-67890');
				expect(ctx.meta?.projectUuid).toBe('project-abcde');

				// Verify logger has all context for logging
				const logMeta = ctx.log.propagationMeta();
				expect(logMeta.correlationId).toBe('req-origin-123');
				expect(logMeta.traceId).toBe('trace-distributed-abc');
				expect(logMeta.userId).toBe('user-12345');
				expect(logMeta.accountUuid).toBe('account-67890');
				expect(logMeta.projectUuid).toBe('project-abcde');
			}
		);
	});

	test('should maintain context through multiple service hops', async () => {
		// ========================================
		// HOP 1: Origin HTTP request
		// ========================================
		let hop1Metadata: string = '';

		await runWithContext(
			{
				log: new Logger('Service-A'),
				correlationId: 'req-multi-hop',
				trace: createTraceContext('trace-multi-hop')
			},
			async () => {
				setMeta({ userId: 'user-hop', accountUuid: 'account-hop' });
				hop1Metadata = JSON.stringify(capturePropagationMeta());
			}
		);

		// ========================================
		// HOP 2: First background service
		// ========================================
		let hop2Metadata: string = '';
		const hop1Received = JSON.parse(hop1Metadata);

		await runWithContext(
			{
				log: Logger.fromMeta('Service-B', hop1Received),
				correlationId: hop1Received.correlationId,
				trace: {
					traceId: hop1Received.traceId,
					spanId: hop1Received.spanId,
					parentSpanId: hop1Received.parentSpanId
				},
				meta: { userId: hop1Received.userId, accountUuid: hop1Received.accountUuid }
			},
			async () => {
				// Service B adds more context
				setMeta({ serviceB_processed: true });

				// Capture for next hop
				hop2Metadata = JSON.stringify(capturePropagationMeta());
			}
		);

		// ========================================
		// HOP 3: Second background service
		// ========================================
		const hop2Received = JSON.parse(hop2Metadata);

		await runWithContext(
			{
				log: Logger.fromMeta('Service-C', hop2Received),
				correlationId: hop2Received.correlationId,
				trace: {
					traceId: hop2Received.traceId,
					spanId: hop2Received.spanId,
					parentSpanId: hop2Received.parentSpanId
				},
				meta: {
					userId: hop2Received.userId,
					accountUuid: hop2Received.accountUuid,
					serviceB_processed: hop2Received.serviceB_processed
				}
			},
			async () => {
				const ctx = requestContext();

				// Original context preserved
				expect(ctx.correlationId).toBe('req-multi-hop');
				expect(ctx.trace?.traceId).toBe('trace-multi-hop');
				expect(ctx.meta?.userId).toBe('user-hop');
				expect(ctx.meta?.accountUuid).toBe('account-hop');

				// Context added by intermediate service
				expect(ctx.meta?.serviceB_processed).toBe(true);

				// Span chain: each hop creates child span
				// Service-C's parentSpanId should be Service-B's spanId
				expect(ctx.trace?.parentSpanId).toBeDefined();
			}
		);
	});

	test('should isolate context between concurrent cross-service operations', async () => {
		// Simulate two completely independent request chains happening concurrently
		const results: { chain: string; userId: string; accountUuid: string }[] = [];

		// ========================================
		// CHAIN A: User Alice's request
		// ========================================
		const chainA = async () => {
			let metaA: string = '';

			// Origin
			await runWithContext(
				{
					log: new Logger('ChainA-Origin'),
					correlationId: 'req-alice',
					trace: createTraceContext('trace-alice')
				},
				async () => {
					setMeta({ userId: 'alice-123', accountUuid: 'alice-account' });
					metaA = JSON.stringify(capturePropagationMeta());
				}
			);

			// Add delay to interleave with Chain B
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Downstream service
			const receivedA = JSON.parse(metaA);
			await runWithContext(
				{
					log: Logger.fromMeta('ChainA-Downstream', receivedA),
					correlationId: receivedA.correlationId,
					trace: {
						traceId: receivedA.traceId,
						spanId: receivedA.spanId,
						parentSpanId: receivedA.parentSpanId
					},
					meta: { userId: receivedA.userId, accountUuid: receivedA.accountUuid }
				},
				async () => {
					const ctx = requestContext();
					results.push({
						chain: 'A',
						userId: ctx.meta?.userId as string,
						accountUuid: ctx.meta?.accountUuid as string
					});
				}
			);
		};

		// ========================================
		// CHAIN B: User Bob's request
		// ========================================
		const chainB = async () => {
			let metaB: string = '';

			// Origin
			await runWithContext(
				{
					log: new Logger('ChainB-Origin'),
					correlationId: 'req-bob',
					trace: createTraceContext('trace-bob')
				},
				async () => {
					setMeta({ userId: 'bob-456', accountUuid: 'bob-account' });
					metaB = JSON.stringify(capturePropagationMeta());
				}
			);

			// Add delay to interleave with Chain A
			await new Promise((resolve) => setTimeout(resolve, 5));

			// Downstream service
			const receivedB = JSON.parse(metaB);
			await runWithContext(
				{
					log: Logger.fromMeta('ChainB-Downstream', receivedB),
					correlationId: receivedB.correlationId,
					trace: {
						traceId: receivedB.traceId,
						spanId: receivedB.spanId,
						parentSpanId: receivedB.parentSpanId
					},
					meta: { userId: receivedB.userId, accountUuid: receivedB.accountUuid }
				},
				async () => {
					const ctx = requestContext();
					results.push({
						chain: 'B',
						userId: ctx.meta?.userId as string,
						accountUuid: ctx.meta?.accountUuid as string
					});
				}
			);
		};

		// Run both chains concurrently
		await Promise.all([chainA(), chainB()]);

		// Verify isolation - each chain got its own context
		const chainAResult = results.find((r) => r.chain === 'A');
		const chainBResult = results.find((r) => r.chain === 'B');

		expect(chainAResult).toBeDefined();
		expect(chainAResult!.userId).toBe('alice-123');
		expect(chainAResult!.accountUuid).toBe('alice-account');

		expect(chainBResult).toBeDefined();
		expect(chainBResult!.userId).toBe('bob-456');
		expect(chainBResult!.accountUuid).toBe('bob-account');
	});

	test('should propagate context set via Logger.setMeta across services', async () => {
		// This test specifically verifies that ctx.log.setMeta() (not the standalone setMeta)
		// properly propagates across service boundaries
		//
		// In production, RequestContext.log wires up the callback via logger.onSetMeta(setMeta).
		// Here we simulate that by wiring up the callback ourselves.

		let serializedMetadata: string = '';

		// ========================================
		// APP INSTANCE 1: Uses Logger.setMeta
		// ========================================
		// Create logger with callback wired up (simulating what RequestContext does)
		const appInstance1Logger = new Logger('AppInstance1');
		appInstance1Logger.onSetMeta(setMeta); // This is what RequestContext.log does

		await runWithContext(
			{
				log: appInstance1Logger,
				correlationId: 'req-logger-setmeta',
				trace: createTraceContext('trace-logger-setmeta')
			},
			async () => {
				const ctx = requestContext();

				// This is the pattern used in guards: ctx.log.setMeta()
				ctx.log.setMeta({
					userId: 'user-from-logger',
					accountUuid: 'account-from-logger'
				});

				// Capture should include the metadata set via Logger.setMeta
				const meta = capturePropagationMeta();
				serializedMetadata = JSON.stringify(meta);
			}
		);

		// ========================================
		// APP INSTANCE 2: Verify metadata arrived
		// ========================================
		const received = JSON.parse(serializedMetadata);

		expect(received.correlationId).toBe('req-logger-setmeta');
		expect(received.traceId).toBe('trace-logger-setmeta');
		expect(received.userId).toBe('user-from-logger');
		expect(received.accountUuid).toBe('account-from-logger');

		// Restore on receiving side
		await runWithContext(
			{
				log: Logger.fromMeta('AppInstance2', received),
				correlationId: received.correlationId,
				trace: { traceId: received.traceId, spanId: received.spanId, parentSpanId: received.parentSpanId },
				meta: { userId: received.userId, accountUuid: received.accountUuid }
			},
			async () => {
				const ctx = requestContext();

				// All context available
				expect(ctx.meta?.userId).toBe('user-from-logger');
				expect(ctx.meta?.accountUuid).toBe('account-from-logger');

				// Logger also has context
				expect(ctx.log.propagationMeta().userId).toBe('user-from-logger');
				expect(ctx.log.propagationMeta().accountUuid).toBe('account-from-logger');
			}
		);
	});
});
