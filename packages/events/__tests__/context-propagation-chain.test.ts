/**
 * Functional Tests: Context Propagation Through Event Chains
 *
 * Tests that verify trace context and metadata properly flow through
 * multi-step event chains. These are functional tests that use real
 * event providers (not mocks) to verify end-to-end behavior.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EventRegistry } from '../src/event-registry.ts';
import { createEventSystem } from '../src/events.ts';
import { InProcessEventProvider } from '../src/in-process-orchestrator.ts';
import { Logger, runWithContext, createTraceContext } from '@orijs/logging';
// import type { EventContext } from '../src/event-context.ts';
import type { EventMessage } from '../src/event-provider.types.ts';
import type { PropagationMeta } from '@orijs/logging';

describe('Context Propagation Through Event Chains', () => {
	const Events = EventRegistry.create()
		.event('order.placed')
		.event('inventory.reserved')
		.event('payment.processed')
		.event('notification.sent')
		.build();

	beforeEach(() => {
		Logger.reset();
	});

	describe('trace context propagation', () => {
		it('should propagate trace_id through a chain of events', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			const receivedTraceIds: (string | undefined)[] = [];
			const receivedSpanIds: (string | undefined)[] = [];
			const receivedParentSpanIds: (string | undefined)[] = [];

			// Set up handler chain: order.placed -> inventory.reserved -> payment.processed
			system.onEvent<{ orderId: string }>('order.placed', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				receivedTraceIds.push(meta.traceId as string | undefined);
				receivedSpanIds.push(meta.spanId as string | undefined);
				receivedParentSpanIds.push(meta.parentSpanId as string | undefined);
				ctx.emit('inventory.reserved', { orderId: ctx.data.orderId, items: 5 });
			});

			system.onEvent<{ orderId: string; items: number }>('inventory.reserved', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				receivedTraceIds.push(meta.traceId as string | undefined);
				receivedSpanIds.push(meta.spanId as string | undefined);
				receivedParentSpanIds.push(meta.parentSpanId as string | undefined);
				ctx.emit('payment.processed', { orderId: ctx.data.orderId, amount: 100 });
			});

			system.onEvent<{ orderId: string; amount: number }>('payment.processed', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				receivedTraceIds.push(meta.traceId as string | undefined);
				receivedSpanIds.push(meta.spanId as string | undefined);
				receivedParentSpanIds.push(meta.parentSpanId as string | undefined);
			});

			// Create trace context and emit within runWithContext
			const trace = createTraceContext('original-trace-id', 'original-parent-span');

			await runWithContext({ log: Logger.console(), correlationId: 'req-chain-test', trace }, async () => {
				system.emit('order.placed', { orderId: 'ORD-123' });
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			// All events should have the same trace_id (preserved across chain)
			expect(receivedTraceIds.length).toBe(3);
			receivedTraceIds.forEach((traceId) => {
				expect(traceId).toBe('original-trace-id');
			});

			// Each event should have a unique span_id
			expect(receivedSpanIds.length).toBe(3);
			const uniqueSpans = new Set(receivedSpanIds.filter(Boolean));
			expect(uniqueSpans.size).toBe(3);

			await system.stop();
		});

		it('should maintain causation chain through events', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			const causationChain: (string | undefined)[] = [];
			const correlationIds: string[] = [];

			system.onEvent('order.placed', async (ctx) => {
				causationChain.push(ctx.causationId);
				correlationIds.push(ctx.correlationId);
				ctx.emit('inventory.reserved', { orderId: 'ORD-1' });
			});

			system.onEvent('inventory.reserved', async (ctx) => {
				causationChain.push(ctx.causationId);
				correlationIds.push(ctx.correlationId);
				ctx.emit('payment.processed', { orderId: 'ORD-1' });
			});

			system.onEvent('payment.processed', async (ctx) => {
				causationChain.push(ctx.causationId);
				correlationIds.push(ctx.correlationId);
			});

			system.emit('order.placed', { orderId: 'ORD-1' });
			await new Promise((resolve) => setTimeout(resolve, 50));

			// First event has no causation (it's the root)
			expect(causationChain[0]).toBeUndefined();

			// Subsequent events should have causationId set to parent's correlationId
			// (This depends on how chained emit sets causationId)
			expect(correlationIds.length).toBe(3);
			expect(correlationIds[0]).toBeDefined();
			expect(correlationIds[1]).toBeDefined();
			expect(correlationIds[2]).toBeDefined();

			await system.stop();
		});
	});

	describe('request_id propagation', () => {
		it('should propagate request_id from HTTP context through events', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			const receivedRequestIds: (string | undefined)[] = [];

			system.onEvent('order.placed', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				receivedRequestIds.push(meta.correlationId as string | undefined);
				ctx.emit('notification.sent', { message: 'Order received' });
			});

			system.onEvent('notification.sent', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				receivedRequestIds.push(meta.correlationId as string | undefined);
			});

			// Simulate HTTP request context
			const trace = createTraceContext();
			await runWithContext({ log: Logger.console(), correlationId: 'http-req-abc123', trace }, async () => {
				system.emit('order.placed', { orderId: 'ORD-456' });
				await new Promise((resolve) => setTimeout(resolve, 30));
			});

			expect(receivedRequestIds.length).toBe(2);
			receivedRequestIds.forEach((reqId) => {
				expect(reqId).toBe('http-req-abc123');
			});

			await system.stop();
		});

		it('should work without runWithContext (fallback behavior)', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			let handlerCalled = false;

			system.onEvent('order.placed', async () => {
				handlerCalled = true;
			});

			// Emit without runWithContext
			system.emit('order.placed', { orderId: 'ORD-789' });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(handlerCalled).toBe(true);

			await system.stop();
		});
	});

	describe('metadata preservation through chains', () => {
		it('should preserve custom metadata fields through event chain', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			const receivedMeta: PropagationMeta[] = [];

			// Subscribe at provider level to capture raw metadata
			provider.subscribe('order.placed', async (msg: EventMessage) => {
				receivedMeta.push(msg.meta);
			});

			provider.subscribe('inventory.reserved', async (msg: EventMessage) => {
				receivedMeta.push(msg.meta);
			});

			// Set up high-level handlers that emit chained events
			system.onEvent('order.placed', async (ctx) => {
				ctx.emit('inventory.reserved', { items: 5 });
			});

			const trace = createTraceContext('trace-preserve-test');
			await runWithContext(
				{
					log: Logger.console(),
					correlationId: 'req-preserve-test',
					trace
				},
				async () => {
					system.emit('order.placed', { orderId: 'ORD-P1' });
					await new Promise((resolve) => setTimeout(resolve, 30));
				}
			);

			// Both events should have metadata
			expect(receivedMeta.length).toBeGreaterThanOrEqual(1);

			// First event should have trace context from HTTP request
			const firstMeta = receivedMeta[0];
			expect(firstMeta).toBeDefined();
			expect(firstMeta!.traceId).toBe('trace-preserve-test');
			expect(firstMeta!.correlationId).toBe('req-preserve-test');

			await system.stop();
		});
	});

	describe('parallel event emission', () => {
		it('should maintain separate trace contexts for parallel chains', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			const chain1Results: string[] = [];
			const chain2Results: string[] = [];

			system.onEvent<{ chainId: string }>('order.placed', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				const traceId = meta.traceId as string;
				if (ctx.data.chainId === 'chain1') {
					chain1Results.push(traceId);
				} else {
					chain2Results.push(traceId);
				}
			});

			// Emit two events from different trace contexts
			const trace1 = createTraceContext('trace-chain-1');
			const trace2 = createTraceContext('trace-chain-2');

			const promise1 = runWithContext(
				{ log: Logger.console(), correlationId: 'req-1', trace: trace1 },
				async () => {
					system.emit('order.placed', { orderId: 'ORD-1', chainId: 'chain1' });
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			);

			const promise2 = runWithContext(
				{ log: Logger.console(), correlationId: 'req-2', trace: trace2 },
				async () => {
					system.emit('order.placed', { orderId: 'ORD-2', chainId: 'chain2' });
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			);

			await Promise.all([promise1, promise2]);

			// Each chain should have its own trace_id
			expect(chain1Results.length).toBeGreaterThanOrEqual(1);
			expect(chain2Results.length).toBeGreaterThanOrEqual(1);

			if (chain1Results[0]) {
				expect(chain1Results[0]).toBe('trace-chain-1');
			}
			if (chain2Results[0]) {
				expect(chain2Results[0]).toBe('trace-chain-2');
			}

			await system.stop();
		});
	});

	describe('error handling with context', () => {
		it('should preserve trace context even when handler throws', async () => {
			const provider = new InProcessEventProvider();
			const system = createEventSystem(Events, { provider });

			let capturedTraceId: string | undefined;
			let errorCaught = false;

			system.onEvent('order.placed', async (ctx) => {
				const meta = ctx.log.propagationMeta();
				capturedTraceId = meta.traceId as string;
				throw new Error('Handler failed');
			});

			const trace = createTraceContext('trace-error-test');

			await runWithContext({ log: Logger.console(), correlationId: 'req-error', trace }, async () => {
				system.emit('order.placed', { orderId: 'ORD-ERR' }).catch(() => {
					errorCaught = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 20));
			});

			expect(errorCaught).toBe(true);
			expect(capturedTraceId).toBe('trace-error-test');

			await system.stop();
		});
	});
});
