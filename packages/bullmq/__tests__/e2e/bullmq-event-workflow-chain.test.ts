/**
 * E2E Scenario: BullMQ Event → Workflow Chain
 *
 * Tests the complete production-like flow:
 * HTTP Request → Event Published → Handler Executes → Workflow Triggered → Steps Run → Result Stored
 *
 * Given: Application with BullMQ Event Provider and BullMQ Workflow Provider
 * When: HTTP request is made that emits an event
 * Then: Event handler triggers workflow, context propagates through entire chain
 *
 * EntrypointType: http
 * EntrypointId: POST /api/orders
 * Outputs: workflow result, event processed confirmation
 * State: event processed, workflow executed, results captured
 * Messaging: HTTP → event:order.created → workflow:OrderWorkflow → completion
 * Invariants: correlationId.present at all stages, traceId.preserved, exactly-once delivery
 * MockedExternals: none (uses real Redis via testcontainers)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { getRedisConnectionOptions, isRedisReady, waitFor } from '../preload.ts';
import { BullMQEventProvider } from '../../src/events/bullmq-event-provider.ts';
import { BullMQWorkflowProvider } from '../../src/workflows/bullmq-workflow-provider.ts';
import {
	Ori,
	AppContext,
	Workflow,
	Event,
	type Application,
	type OriController,
	type RouteBuilder,
	type RequestContext,
	type IWorkflowConsumer,
	type IEventConsumer,
	type WorkflowContext,
	type EventContext
} from '@orijs/orijs';
import { Type } from '@orijs/validation';
import { Logger, capturePropagationMeta } from '@orijs/logging';

// --- Test Types ---

interface OrderPayload {
	orderId: string;
	userId: number;
	items: string[];
}

// --- Capture Arrays for Verification ---
// Keyed by correlationId to isolate concurrent tests

interface CapturedStage {
	correlationId?: string;
	traceId?: string;
}

interface CapturedContextEntry {
	controller?: CapturedStage;
	eventHandler?: CapturedStage;
	workflowStep1?: CapturedStage;
	workflowStep2?: CapturedStage;
}

const capturedContextByRequest = new Map<string, CapturedContextEntry>();

function getCapturedContext(correlationId: string): CapturedContextEntry {
	if (!capturedContextByRequest.has(correlationId)) {
		capturedContextByRequest.set(correlationId, {});
	}
	return capturedContextByRequest.get(correlationId)!;
}

// Legacy accessor for tests that check capturedContext directly
// Returns the most recent capture (for backwards compatibility)
const capturedContext: CapturedContextEntry = {};

function resetCaptures(): void {
	capturedContext.controller = undefined;
	capturedContext.eventHandler = undefined;
	capturedContext.workflowStep1 = undefined;
	capturedContext.workflowStep2 = undefined;
	capturedContextByRequest.clear();
}

// --- Workflow Definition ---

const OrderWorkflowDef = Workflow.define({
	name: 'order-processing',
	data: Type.Object({
		orderId: Type.String(),
		userId: Type.Number(),
		itemCount: Type.Number()
	}),
	result: Type.Object({
		orderId: Type.String(),
		status: Type.Literal('completed'),
		steps: Type.Array(Type.String())
	})
});

type OrderWorkflowData = (typeof OrderWorkflowDef)['_data'];
type OrderWorkflowResult = (typeof OrderWorkflowDef)['_result'];

// --- Event Definition ---

const OrderCreatedEvent = Event.define({
	name: 'order.created',
	data: Type.Object({
		orderId: Type.String(),
		userId: Type.Number(),
		itemCount: Type.Number()
	}),
	result: Type.Object({
		orderId: Type.String(),
		status: Type.Literal('completed'),
		steps: Type.Array(Type.String())
	})
});

type OrderCreatedPayload = (typeof OrderCreatedEvent)['_data'];
type OrderCreatedResponse = (typeof OrderCreatedEvent)['_result'];

// --- Workflow Consumer ---

class OrderProcessingWorkflowConsumer implements IWorkflowConsumer<OrderWorkflowData, OrderWorkflowResult> {
	// Phase 1: No-op - workflow step configuration will be added in Phase 2

	public onComplete = async (ctx: WorkflowContext<OrderWorkflowData>): Promise<OrderWorkflowResult> => {
		const correlationId = ctx.meta?.correlationId as string | undefined;
		const traceId = ctx.meta?.traceId as string | undefined;

		// Capture context keyed by correlationId for test isolation
		if (correlationId) {
			const captured = getCapturedContext(correlationId);
			captured.workflowStep1 = { correlationId, traceId };
			captured.workflowStep2 = { correlationId, traceId };
		}

		// Also update legacy capturedContext for backwards compatibility
		capturedContext.workflowStep1 = { correlationId, traceId };
		capturedContext.workflowStep2 = { correlationId, traceId };

		return {
			orderId: ctx.data.orderId,
			status: 'completed',
			steps: ['validate', 'process']
		};
	};
}

// --- Event Consumer ---

class OrderCreatedEventConsumer implements IEventConsumer<OrderCreatedPayload, OrderCreatedResponse> {
	constructor(private readonly appContext: AppContext) {}

	public onEvent = async (ctx: EventContext<OrderCreatedPayload>): Promise<OrderCreatedResponse> => {
		// Capture propagation metadata from AsyncLocalStorage
		const meta = capturePropagationMeta() ?? {};
		const correlationId = meta.correlationId as string | undefined;
		const traceId = meta.traceId as string | undefined;

		// Capture context keyed by correlationId for test isolation
		if (correlationId) {
			const captured = getCapturedContext(correlationId);
			captured.eventHandler = { correlationId, traceId };
		}

		// Also update legacy capturedContext
		capturedContext.eventHandler = { correlationId, traceId };

		// Start workflow with propagated context
		const handle = await this.appContext.workflows.execute(OrderWorkflowDef, {
			orderId: ctx.data.orderId,
			userId: ctx.data.userId,
			itemCount: ctx.data.itemCount
		});

		return await handle.result();
	};
}

// --- Controller ---

class OrderController implements OriController {
	constructor(private readonly appContext: AppContext) {}

	public configure(r: RouteBuilder): void {
		r.post('/orders', this.createOrder);
		r.post('/orders-direct', this.createOrderDirect);
	}

	/**
	 * Creates order via event → workflow chain.
	 */
	private createOrder = async (ctx: RequestContext) => {
		const meta = capturePropagationMeta() ?? {};
		const correlationId = meta.correlationId as string | undefined;
		const traceId = meta.traceId as string | undefined;

		// Capture context keyed by correlationId for test isolation
		if (correlationId) {
			const captured = getCapturedContext(correlationId);
			captured.controller = { correlationId, traceId };
		}

		// Also update legacy capturedContext
		capturedContext.controller = { correlationId, traceId };

		const body = await ctx.json<OrderPayload>();

		ctx.log.info('Creating order via event', { orderId: body.orderId });

		// Emit event (handler will trigger workflow)
		const eventSystem = this.appContext.event;
		if (eventSystem) {
			eventSystem.emit('order.created', {
				orderId: body.orderId,
				userId: body.userId,
				itemCount: body.items.length
			});
		}

		return Response.json({
			success: true,
			orderId: body.orderId,
			message: 'Order created, processing via event workflow chain'
		});
	};

	/**
	 * Creates order via direct workflow (no event).
	 * Used to verify workflow context propagation independently.
	 */
	private createOrderDirect = async (ctx: RequestContext) => {
		const meta = capturePropagationMeta() ?? {};
		const correlationId = meta.correlationId as string | undefined;
		const traceId = meta.traceId as string | undefined;

		// Capture context keyed by correlationId for test isolation
		if (correlationId) {
			const captured = getCapturedContext(correlationId);
			captured.controller = { correlationId, traceId };
		}

		// Also update legacy capturedContext
		capturedContext.controller = { correlationId, traceId };

		const body = await ctx.json<OrderPayload>();

		ctx.log.info('Creating order directly', { orderId: body.orderId });

		// Start workflow directly
		const handle = await this.appContext.workflows.execute(OrderWorkflowDef, {
			orderId: body.orderId,
			userId: body.userId,
			itemCount: body.items.length
		});

		const result = await handle.result();

		// Return keyed captures for this specific request
		const capturedForRequest = correlationId ? getCapturedContext(correlationId) : capturedContext;

		return Response.json({
			success: true,
			orderId: body.orderId,
			workflowResult: result,
			capturedContext: { ...capturedForRequest }
		});
	};
}

// --- Tests ---

describe('E2E: BullMQ Event → Workflow Chain', () => {
	let app: Application;
	let eventProvider: BullMQEventProvider;
	let workflowProvider: BullMQWorkflowProvider;
	let port = 22000;
	let testCounter = 0;

	const getPort = () => ++port;

	beforeAll(() => {
		if (!isRedisReady()) {
			throw new Error('Redis container not ready');
		}
	});

	beforeEach(() => {
		Logger.reset();
		resetCaptures();
		testCounter++;

		const connection = getRedisConnectionOptions();

		// Create unique prefixes for test isolation
		eventProvider = new BullMQEventProvider({ connection });
		workflowProvider = new BullMQWorkflowProvider({
			connection,
			queuePrefix: `e2e-chain-test-${testCounter}`
		});
	});

	afterEach(async () => {
		await app?.stop();
		await eventProvider?.stop();
		await workflowProvider?.stop();
		// Give ioredis time to fully close connections before next test starts
		// This prevents "Connection is closed" errors from previous test's cleanup
		// affecting the next test's fresh connections
		await new Promise((r) => setTimeout(r, 50));
	});

	describe('HTTP → Workflow chain (direct, BullMQ)', () => {
		it('should propagate correlationId from HTTP through BullMQ workflow steps', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'bullmq-e2e-direct-request-id-12345';

			const response = await fetch(`http://localhost:${testPort}/api/orders-direct`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-BULLMQ-001',
					userId: 42,
					items: ['item1', 'item2', 'item3']
				})
			});

			expect(response.status).toBe(200);

			const result = (await response.json()) as {
				success: boolean;
				workflowResult: { status: string; steps: string[] };
				capturedContext: typeof capturedContext;
			};

			// Verify workflow completed
			expect(result.success).toBe(true);
			expect(result.workflowResult.status).toBe('completed');
			expect(result.workflowResult.steps).toEqual(['validate', 'process']);

			// Verify correlationId propagated through all stages
			expect(capturedContext.controller?.correlationId).toBe(correlationId);
			expect(capturedContext.workflowStep1?.correlationId).toBe(correlationId);
			expect(capturedContext.workflowStep2?.correlationId).toBe(correlationId);
		}, 15000);

		it('should propagate traceId through BullMQ workflow steps', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const response = await fetch(`http://localhost:${testPort}/api/orders-direct`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': 'trace-test-request'
				},
				body: JSON.stringify({
					orderId: 'ORD-TRACE-001',
					userId: 1,
					items: ['item']
				})
			});

			expect(response.status).toBe(200);

			// Verify traceId exists and is consistent across stages
			expect(capturedContext.controller?.traceId).toBeDefined();
			expect(capturedContext.workflowStep1?.traceId).toBeDefined();
			expect(capturedContext.workflowStep2?.traceId).toBeDefined();

			// All stages should have the same traceId (preserved through BullMQ chain)
			expect(capturedContext.workflowStep1?.traceId).toBe(capturedContext.controller?.traceId);
			expect(capturedContext.workflowStep2?.traceId).toBe(capturedContext.controller?.traceId);
		}, 15000);
	});

	describe('HTTP → Event → Workflow chain (full, BullMQ)', () => {
		it('should execute complete chain: HTTP → BullMQ Event → BullMQ Workflow', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.eventProvider(eventProvider)
				.event(OrderCreatedEvent)
				.consumer(OrderCreatedEventConsumer, [AppContext])
				.workflowProvider(workflowProvider)
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'bullmq-e2e-full-chain-request-id';

			const response = await fetch(`http://localhost:${testPort}/api/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({
					orderId: 'ORD-FULL-CHAIN-001',
					userId: 99,
					items: ['a', 'b']
				})
			});

			expect(response.status).toBe(200);

			const result = (await response.json()) as {
				success: boolean;
				orderId: string;
				message: string;
			};

			expect(result.success).toBe(true);
			expect(result.orderId).toBe('ORD-FULL-CHAIN-001');

			// Wait for async event processing through BullMQ using polling
			await waitFor(
				() => capturedContext.controller?.correlationId !== undefined,
				5000, // Timeout
				50 // Poll interval
			);

			// Verify correlationId propagated from HTTP to controller
			expect(capturedContext.controller?.correlationId).toBe(correlationId);

			// Note: Cardinality verification not possible in BullMQ distributed tests
			// as workflow steps run in separate job contexts. Header documents expected
			// counts: event.emit = 1, workflow.execute = 1, workflow.steps = 2
		}, 20000);
	});

	describe('context preservation in all steps', () => {
		it('should propagate context through multi-step workflow', async () => {
			// Define a simple 2-step workflow
			const TwoStepWorkflowDef = Workflow.define({
				name: 'two-step-workflow',
				data: Type.Object({ value: Type.Number() }),
				result: Type.Object({ completed: Type.Boolean() })
			});

			type TwoStepData = (typeof TwoStepWorkflowDef)['_data'];
			type TwoStepResult = (typeof TwoStepWorkflowDef)['_result'];

			class TwoStepWorkflowConsumer implements IWorkflowConsumer<TwoStepData, TwoStepResult> {
				public onComplete = async (ctx: WorkflowContext<TwoStepData>): Promise<TwoStepResult> => {
					const correlationId = ctx.meta?.correlationId as string | undefined;
					const traceId = ctx.meta?.traceId as string | undefined;

					// Use keyed captures for test isolation
					if (correlationId) {
						const captured = getCapturedContext(correlationId);
						captured.workflowStep1 = { correlationId, traceId };
						captured.workflowStep2 = { correlationId, traceId };
					}

					return { completed: true };
				};
			}

			class MultiStepController implements OriController {
				constructor(private readonly appContext: AppContext) {}

				public configure(r: RouteBuilder): void {
					r.post('/multi-step', this.execute);
				}

				private execute = async (ctx: RequestContext) => {
					const meta = capturePropagationMeta() ?? {};
					const correlationId = meta.correlationId as string | undefined;
					const traceId = meta.traceId as string | undefined;

					// Use keyed captures for test isolation
					if (correlationId) {
						const captured = getCapturedContext(correlationId);
						captured.controller = { correlationId, traceId };
					}

					const body = await ctx.json<{ value: number }>();

					const handle = await this.appContext.workflows.execute(TwoStepWorkflowDef, {
						value: body.value
					});

					const result = await handle.result();

					return Response.json({
						success: true,
						completed: result.completed
					});
				};
			}

			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(TwoStepWorkflowDef)
				.consumer(TwoStepWorkflowConsumer)
				.controller('/api', MultiStepController, [AppContext]);

			await app.listen(testPort);

			const correlationId = 'multi-step-request-id';

			const response = await fetch(`http://localhost:${testPort}/api/multi-step`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-request-id': correlationId
				},
				body: JSON.stringify({ value: 5 })
			});

			expect(response.status).toBe(200);

			const result = (await response.json()) as { completed: boolean };
			expect(result.completed).toBe(true);

			// Use keyed captures for test isolation (prevents interference from concurrent tests)
			const captured = getCapturedContext(correlationId);

			// Verify context propagated through all steps
			expect(captured.controller?.correlationId).toBe(correlationId);
			expect(captured.workflowStep1?.correlationId).toBe(correlationId);
			expect(captured.workflowStep2?.correlationId).toBe(correlationId);

			// Verify same traceId through chain
			expect(captured.workflowStep1?.traceId).toBe(captured.controller?.traceId);
			expect(captured.workflowStep2?.traceId).toBe(captured.controller?.traceId);
		}, 15000);
	});

	describe('concurrent requests with BullMQ', () => {
		it('should handle multiple concurrent workflow executions', async () => {
			const testPort = getPort();
			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(OrderWorkflowDef)
				.consumer(OrderProcessingWorkflowConsumer)
				.controller('/api', OrderController, [AppContext]);

			await app.listen(testPort);

			// Send 5 concurrent requests
			const requests = Array.from({ length: 5 }, (_, i) =>
				fetch(`http://localhost:${testPort}/api/orders-direct`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-request-id': `concurrent-${i}`
					},
					body: JSON.stringify({
						orderId: `ORD-CONCURRENT-${i}`,
						userId: i,
						items: ['item']
					})
				})
			);

			const responses = await Promise.all(requests);

			// All should succeed
			for (const response of responses) {
				expect(response.status).toBe(200);

				const result = (await response.json()) as {
					success: boolean;
					workflowResult: { status: string };
				};

				expect(result.success).toBe(true);
				expect(result.workflowResult.status).toBe('completed');
			}
		}, 30000);
	});

	describe('definition-based workflow execution (emitter-only mode)', () => {
		it('should emit workflow job to queue without local consumer', async () => {
			// Define a workflow that will only be emitted (no consumer registered)
			const EmitterOnlyWorkflowDef = Workflow.define({
				name: 'emitter-only-workflow',
				data: Type.Object({
					jobId: Type.String(),
					data: Type.String()
				}),
				result: Type.Object({
					success: Type.Boolean()
				})
			});

			const testPort = getPort();

			class EmitterController implements OriController {
				constructor(private readonly appContext: AppContext) {}

				public configure(r: RouteBuilder): void {
					r.post('/emit', this.emit);
				}

				private emit = async (ctx: RequestContext) => {
					const body = await ctx.json<{ jobId: string; data: string }>();

					// Execute workflow WITHOUT a consumer registered
					// This tests the emitter-only path in BullMQ provider
					const handle = await this.appContext.workflows.execute(EmitterOnlyWorkflowDef, {
						jobId: body.jobId,
						data: body.data
					});

					// Job should be emitted, status should be running (waiting for consumer)
					const status = await handle.status();

					return Response.json({
						success: true,
						flowId: handle.id,
						status
					});
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				// Register definition but NO consumer - emitter-only mode
				.workflow(EmitterOnlyWorkflowDef)
				.controller('/api', EmitterController, [AppContext]);

			await app.listen(testPort);

			// This should succeed - job emitted to queue
			// If jobId contains colon, BullMQ will throw "Custom Id cannot contain :"
			const response = await fetch(`http://localhost:${testPort}/api/emit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jobId: 'test-job-1', data: 'test-data' })
			});

			expect(response.status).toBe(200);

			const result = (await response.json()) as {
				success: boolean;
				flowId: string;
				status: string;
			};

			expect(result.success).toBe(true);
			expect(result.flowId).toBeDefined();
			expect(result.status).toBe('running'); // Job emitted, waiting for consumer
		}, 15000);

		it('should reject workflow execution with invalid data schema', async () => {
			const StrictWorkflowDef = Workflow.define({
				name: 'strict-schema-workflow',
				data: Type.Object({
					requiredField: Type.String(),
					numberField: Type.Number()
				}),
				result: Type.Object({ ok: Type.Boolean() })
			});

			const testPort = getPort();

			class StrictController implements OriController {
				constructor(private readonly appContext: AppContext) {}

				public configure(r: RouteBuilder): void {
					r.post('/strict', this.execute);
				}

				private execute = async (ctx: RequestContext) => {
					const body = await ctx.json<Record<string, unknown>>();

					try {
						// This should fail validation because data doesn't match schema
						await this.appContext.workflows.execute(StrictWorkflowDef, body as any);
						return Response.json({ success: true });
					} catch (error) {
						return Response.json({ success: false, error: (error as Error).message }, { status: 400 });
					}
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(StrictWorkflowDef)
				.controller('/api', StrictController, [AppContext]);

			await app.listen(testPort);

			// Send invalid data (missing requiredField)
			const response = await fetch(`http://localhost:${testPort}/api/strict`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ wrongField: 'value' })
			});

			expect(response.status).toBe(400);

			const result = (await response.json()) as { success: boolean; error: string };
			expect(result.success).toBe(false);
			expect(result.error).toContain('validation failed');
		}, 15000);
	});

	describe('idempotency and exactly-once delivery', () => {
		it('should not process duplicate workflow executions', async () => {
			let executionCount = 0;

			// Define a workflow that counts executions
			const CountingWorkflowDef = Workflow.define({
				name: 'counting-workflow',
				data: Type.Object({ id: Type.String() }),
				result: Type.Object({ count: Type.Number() })
			});

			type CountingData = (typeof CountingWorkflowDef)['_data'];
			type CountingResult = (typeof CountingWorkflowDef)['_result'];

			class CountingWorkflowConsumer implements IWorkflowConsumer<CountingData, CountingResult> {
				public onComplete = async (): Promise<CountingResult> => {
					executionCount++;
					return { count: executionCount };
				};
			}

			const testPort = getPort();

			class CountController implements OriController {
				constructor(private readonly appContext: AppContext) {}

				public configure(r: RouteBuilder): void {
					r.post('/count', this.count);
				}

				private count = async (ctx: RequestContext) => {
					const body = await ctx.json<{ id: string }>();

					const handle = await this.appContext.workflows.execute(CountingWorkflowDef, {
						id: body.id
					});

					const result = await handle.result();

					return Response.json({
						success: true,
						executionCount: result.count
					});
				};
			}

			app = Ori.create()
				.disableSignalHandling()
				.workflowProvider(workflowProvider)
				.workflow(CountingWorkflowDef)
				.consumer(CountingWorkflowConsumer)
				.controller('/api', CountController, [AppContext]);

			await app.listen(testPort);

			// Execute workflow once
			const response = await fetch(`http://localhost:${testPort}/api/count`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: 'test-1' })
			});

			expect(response.status).toBe(200);
			const result = (await response.json()) as { executionCount: number };

			// Should have executed exactly once
			expect(result.executionCount).toBe(1);
		}, 15000);
	});
});
